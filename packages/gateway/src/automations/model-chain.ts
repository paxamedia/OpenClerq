/**
 * The models an automation run may use, and checking them before it starts.
 *
 * A run has a primary model, models to escalate to when a gate fails
 * (`agent.model.escalate`), and models to use instead when the one in use is
 * unavailable (`agent.model.fallback`). The runner and the spec preview both
 * check the whole chain through here, so they cannot disagree about what a
 * spec needs.
 *
 * Strictness: a model a person chose for this run (a run started by hand that
 * names one) is used or the run fails plainly; it never falls back. Models
 * the spec names, in a run it started or a schedule did, may.
 */

import { DRIVER_CAPABILITIES, type Driver, type DriverAvailability } from '@clerq/drivers';
import type { Registry } from '@clerq/providers';
import type { AutomationSpec } from './spec.js';

export type ModelRole = 'primary' | 'escalation' | 'fallback';

export interface ModelPlan {
  /** The model the run starts with. Absent: the CLI's own default. */
  primary?: string;
  /** Models to run the agent again with, in order, when a gate fails. */
  escalate: string[];
  /** Models to use when the one in use is unavailable, in order. Empty when `strict`. */
  fallback: string[];
  /**
   * A person chose `primary` for this run, so it is used as chosen: no
   * fallback. Escalation is still the spec's own policy for a failed gate.
   */
  strict: boolean;
}

/**
 * The models of a run. `chosen` is a model a person named for this run
 * (`POST /automations/:id/run { model }`); without one the spec's apply.
 */
export function planModels(spec: AutomationSpec, chosen?: string | null): ModelPlan {
  if (chosen) {
    return {
      primary: chosen,
      escalate: spec.agent.escalate.filter((m) => m !== chosen),
      fallback: [],
      strict: true,
    };
  }
  return {
    primary: spec.agent.model,
    escalate: spec.agent.escalate,
    fallback: spec.agent.fallback,
    strict: false,
  };
}

/** The provider part of a `provider/model` reference. */
function providerOf(model: string | undefined): string | undefined {
  const slash = model?.indexOf('/') ?? -1;
  return model && slash > 0 ? model.slice(0, slash) : undefined;
}

/**
 * Whether the spec's own API key (`agent.api_key_secret`) applies to `model`.
 * A CLI reads its key itself, whatever the model. The builtin agent's key is
 * for the provider of the spec's own primary model: a model of another
 * provider (a fallback, an escalation, one a person named for this run) uses
 * that provider's usual key, so a key never goes to a vendor it was not given
 * for.
 */
export function keyAppliesTo(spec: AutomationSpec, model: string | undefined) {
  if (!spec.agent.apiKeySecret) return false;
  if (spec.agent.driver !== 'builtin') return true;
  const provider = providerOf(model);
  return provider !== undefined && provider === providerOf(spec.agent.model);
}

/** What is wrong with a model a person names for one run, or undefined when it is usable. */
export function modelChoiceProblem(
  spec: AutomationSpec,
  model: string,
  registry?: Registry
): string | undefined {
  const caps = DRIVER_CAPABILITIES[spec.agent.driver];
  if (!caps.models) {
    return `${caps.label}'s CLI cannot be told which model to use, so a run of this automation cannot be given one.`;
  }
  if (spec.agent.driver === 'builtin') {
    const provider = providerOf(model);
    if (provider === undefined) {
      return `"${model}" must name the provider too, as provider/model (e.g. anthropic/${model || 'claude-sonnet-4-5'}).`;
    }
    if (registry && !registry.providers.some((p) => p.id === provider)) {
      return `Unknown provider "${provider}" in "${model}". Known: ${registry.providers.map((p) => p.id).join(', ')}.`;
    }
  }
  return undefined;
}

export interface ModelCheck {
  model: string | undefined;
  role: ModelRole;
  availability: DriverAvailability;
}

/**
 * Ask the driver about every model of the plan, in order: the primary, each
 * escalation model, each fallback model. `onChecked` sees each result as it
 * comes (the runner records it as a step).
 */
export async function checkModels(
  driver: Driver,
  spec: AutomationSpec,
  plan: ModelPlan,
  hasBudget: boolean,
  onChecked?: (check: ModelCheck) => void
): Promise<ModelCheck[]> {
  const entries: Array<{ model: string | undefined; role: ModelRole }> = [
    { model: plan.primary, role: 'primary' },
    ...plan.escalate.map((model) => ({ model, role: 'escalation' as const })),
    ...plan.fallback.map((model) => ({ model, role: 'fallback' as const })),
  ];
  const checks: ModelCheck[] = [];
  for (const entry of entries) {
    const availability = await driver.detect({
      // A CLI in a container is the image's; the host's is not checked.
      ...(spec.sandbox.profile === 'container' && spec.agent.driver !== 'builtin'
        ? { inContainer: true }
        : {}),
      apiKey: keyAppliesTo(spec, entry.model),
      permissionMode: spec.agent.permissionMode,
      model: entry.model,
      budget: hasBudget,
    });
    const check = { ...entry, availability };
    checks.push(check);
    onChecked?.(check);
  }
  return checks;
}

export interface ChainVerdict {
  /** What stops the run, in the order of the chain. Each reads as a sentence. */
  errors: string[];
  /** What the run goes on despite: a fallback model it cannot use now. */
  warnings: string[];
  /**
   * The primary model is unavailable and the run starts with `to` instead.
   * Only when every other check passed and the plan may fall back.
   */
  movedOff?: { from: string | undefined; to: string; reason: string };
  /** The model the run starts with. */
  start: string | undefined;
}

const reasonOf = (c: ModelCheck) => c.availability.reason ?? 'It is unavailable.';

/**
 * The model cannot be used because of what the spec says, not because of how
 * things are right now: it has no price under a dollar budget, or the
 * reference is wrong (an unknown provider, a missing provider). No other model
 * makes that up, and moving on would hide it.
 */
export function isSpecFault(a: DriverAvailability): boolean {
  return a.reasonKind === 'unpriced' || a.reasonKind === 'invalid';
}

/** Another model may stand in: the provider has no key here, or a local server is not running. */
function standsIn(a: DriverAvailability): boolean {
  return a.reasonKind === 'no_key' || a.reasonKind === 'unreachable';
}

/**
 * What the checks mean for the run.
 *
 *  - The primary unavailable because its provider has no key, or a local server
 *    does not answer: an error, unless the plan has a fallback model that is
 *    available; the run then starts with that one. Any other reason (an unknown
 *    provider, a typo; no price under a dollar budget; a CLI that is missing or
 *    signed out) is a fault no fallback makes up for: an error.
 *  - An escalation model unavailable, or unpriced under a dollar budget: an
 *    error. The run would find out only after spending on the first model.
 *  - A fallback model that is a fault in the spec (unknown provider, unpriced
 *    under a dollar budget): an error. Otherwise unavailable only means it is
 *    skipped when the time comes, which is a warning.
 */
export function judgeChain(plan: ModelPlan, checks: ModelCheck[]): ChainVerdict {
  const errors: string[] = [];
  const warnings: string[] = [];
  let start = plan.primary;
  let movedOff: ChainVerdict['movedOff'];

  const primary = checks.find((c) => c.role === 'primary');
  const fallbacks = checks.filter((c) => c.role === 'fallback');
  if (primary && !primary.availability.available) {
    const usable = standsIn(primary.availability)
      ? fallbacks.find((c) => c.availability.available)
      : undefined;
    if (usable) {
      start = usable.model;
      movedOff = {
        from: plan.primary,
        to: usable.model as string,
        reason: reasonOf(primary),
      };
    } else {
      errors.push(reasonOf(primary));
    }
  }
  for (const c of checks) {
    if (c.availability.available) continue;
    if (c.role === 'escalation') errors.push(`Escalation model ${c.model}: ${reasonOf(c)}`);
    if (c.role === 'fallback') {
      if (isSpecFault(c.availability)) errors.push(`Fallback model ${c.model}: ${reasonOf(c)}`);
      else warnings.push(`Fallback model ${c.model}: ${reasonOf(c)} It is skipped when needed.`);
    }
  }
  return { errors, warnings, ...(movedOff ? { movedOff } : {}), start };
}
