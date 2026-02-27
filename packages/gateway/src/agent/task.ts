/**
 * Single entrypoint for agent tasks: message → optional calculation → AI explanation.
 * When a calculation intent is detected, runs the arithmetic engine first and passes
 * the result as context to the LLM.
 */

import { getExplanation } from './explain.js';
import { parseCalculationIntent } from './calc-intent.js';

export interface TaskRequest {
  message: string;
  /** Optional: pre-selected skill from skill selector */
  skillSlug?: string;
  /** Optional: skill display name for explain context */
  skillName?: string;
  /** Optional: run calculation when intent detected (e.g. "Calculate 25% on 100") */
  runCalc?: (expression: string, inputs?: Record<string, number>) => Promise<{ values: Record<string, number> }>;
  /** Optional: model override (use when user has multiple models) */
  model?: string;
  /** When true: parse intent, show trace, but do not call LLM or run calc. */
  dryRun?: boolean;
}

export interface TaskStep {
  step: string;
  detail?: string;
  duration_ms?: number;
}

export interface TaskResponse {
  intent: 'explain';
  skillSlug?: string;
  explanation: string;
  model?: string;
  disclaimer?: string;
  error?: string;
  /** Step-by-step execution trace for debugging */
  trace?: TaskStep[];
}

/**
 * Run a single agent task: optionally run calculation, then get AI explanation.
 */
export async function runTask(req: TaskRequest): Promise<TaskResponse> {
  const { message, skillSlug, skillName, runCalc, dryRun } = req;
  const trimmed = message?.trim() ?? '';
  const trace: TaskStep[] = [];

  if (dryRun) {
    trace.push({ step: 'skill_select', detail: skillSlug ?? 'auto' });
    const calcIntent = parseCalculationIntent(trimmed);
    if (calcIntent) {
      trace.push({ step: 'calculation', detail: `would run: ${calcIntent.expression}` });
    }
    trace.push({ step: 'explain', detail: 'skipped (dry run)' });
    return {
      intent: 'explain',
      skillSlug,
      explanation: '[Dry run] No LLM call. Trace shows what would execute.',
      trace,
    };
  }

  if (!trimmed) {
    const t0 = Date.now();
    trace.push({ step: 'explain', detail: 'default prompt' });
    const explanation = await getExplanation({
      question: 'What can you help me with?',
    }).catch(() => ({
      explanation: 'Ask a question. Add skills and tools to extend what the agent can help with.',
      model: undefined,
      disclaimer: '',
    }));
    trace[trace.length - 1].duration_ms = Date.now() - t0;
    return {
      intent: 'explain',
      explanation: explanation.explanation,
      model: explanation.model,
      disclaimer: explanation.disclaimer,
      trace,
    };
  }

  trace.push({ step: 'skill_select', detail: skillSlug ?? 'auto' });

  let context: Record<string, unknown> | undefined;
  const calcIntent = parseCalculationIntent(trimmed);
  if (calcIntent && runCalc) {
    const t0 = Date.now();
    trace.push({ step: 'calculation', detail: calcIntent.expression });
    try {
      const calcResult = await runCalc(calcIntent.expression, calcIntent.inputs);
      context = { calculation_request: trimmed, calculation_result: calcResult.values };
      trace[trace.length - 1].duration_ms = Date.now() - t0;
    } catch {
      trace[trace.length - 1].detail = 'calculation failed';
      trace[trace.length - 1].duration_ms = Date.now() - t0;
    }
  }

  const t0 = Date.now();
  trace.push({ step: 'explain', detail: skillName ?? 'general' });
  const result = await getExplanation({
    question: trimmed,
    context,
    skillSlug,
    skillName,
    model: req.model,
  });
  trace[trace.length - 1].duration_ms = Date.now() - t0;

  return {
    intent: 'explain',
    skillSlug,
    explanation: result.explanation,
    model: result.model,
    disclaimer: result.disclaimer,
    trace,
  };
}
