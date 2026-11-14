/**
 * What a run says, in plain words. The gateway records most things an
 * automation run does as a step with a `name` and a few fields; this turns the
 * ones a person should be able to read at a glance into a sentence, and gives
 * the longer ones a note for the step's detail. Anything it does not know is
 * shown as the step's kind and name.
 *
 * The desktop app's run page and the `clerq` command line read a run through
 * these, so they say the same thing; there is no other copy.
 */

import type { RunStep } from './index.js';

export interface StepWords {
  /** One line for the step list. */
  label: string;
  /** What it means, for the step's detail. Absent when the label says it all. */
  note?: string;
}

type Fields = Record<string, unknown>;

const fields = (v: unknown): Fields =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Fields) : {};
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const whole = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Why a run was tried again, in words. */
const RETRY_CAUSE: Record<string, string> = {
  driver_crash: 'the agent stopped without a result',
  provider_unavailable: 'the model’s provider was unavailable',
  lease_expired: 'the gateway that was running it stopped',
};

/** The tools a sub-agent was started with: a list, or the read-only default. */
function toolsWords(tools: unknown): string {
  if (Array.isArray(tools)) return tools.length ? tools.map(String).join(', ') : 'none';
  return text(tools) ?? 'read-only';
}

/**
 * What the model before an escalation was. The runner records `default` when no
 * model was named for it: a spec that sets none leaves the choice to the agent
 * program (a CLI), so the model is that program's own default, not one this page
 * can name. The gateway's default chain does not apply to an automation run.
 */
export function previousModel(from: unknown): string | undefined {
  const model = text(from);
  if (!model) return undefined;
  return model === 'default'
    ? 'Before this it used the agent program’s own default model, since none was named.'
    : `Before this it used ${model}.`;
}

function toolStep(name: string, input: Fields, output: Fields): StepWords | null {
  switch (name) {
    case 'model.fallback': {
      const from = text(input.from);
      const to = text(input.to) ?? 'the next model';
      const skipped = Array.isArray(output.skipped)
        ? (output.skipped as Array<{ model?: unknown; reason?: unknown }>)
            .map((s) => `${String(s.model)} (${String(s.reason)})`)
            .join('; ')
        : '';
      return {
        label: `Switched to ${to}: ${from ?? 'the model in use'} was unavailable`,
        note:
          [
            text(output.reason) && `Reason: ${sentence(String(output.reason))}`,
            skipped && `Passed over: ${skipped}.`,
            `From here the work is sent to ${to}, whose provider may be a different one.`,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      };
    }
    case 'agent.escalate': {
      const model = text(input.model);
      const after = text(output.after);
      return {
        label: `A gate failed: running the agent again${model ? ` with ${model}` : ''}`,
        note: [
          after && `After: ${sentence(after)}`,
          'It starts over in the same worktree, with the failed check in its prompt.',
          previousModel(output.from),
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'subagent.start': {
      const model = text(input.model);
      const parent = text(input.parentRunId);
      return {
        label: 'Started as a sub-agent',
        note: [
          parent && `Started by run ${parent}.`,
          `Tools: ${toolsWords(input.tools)}.`,
          model
            ? input.strict === false
              ? `Model: ${model}.`
              : `Model: ${model}, used as named: it does not fall back.`
            : 'Model: the one its parent was using.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'skill.select': {
      const skill = text(input.skill);
      const trust = text(input.trust);
      const notes = Array.isArray(output.notes) ? output.notes.map(String) : [];
      const skipped = Array.isArray(output.skipped) ? output.skipped.length : 0;
      return {
        label: skill
          ? `Used the skill ${skill}${trust && trust !== 'trusted' ? ` (${trust})` : ''}${skipped ? `, passed over ${plural(skipped, 'other')}` : ''}`
          : `Passed over ${plural(skipped, 'skill')} that matched`,
        note: notes.join(' ') || undefined,
      };
    }
    case 'sandbox': {
      const profile = text(input.profile) ?? 'native';
      return {
        label:
          profile === 'native'
            ? 'Not isolated: runs with your account’s access'
            : `Isolated: ${profile}`,
        note: text(output.note),
      };
    }
    case 'diff.secrets':
      return {
        label: 'A vault secret is in the diff',
        note: text(output.note),
      };
    case 'run.retry': {
      const attempt = whole(input.attempt);
      const cause = text(output.cause);
      const after = text(output.after);
      const at = text(output.notBefore);
      return {
        label: `Trying the run again${attempt ? ` (attempt ${attempt})` : ''}`,
        note: [
          after && `After: ${sentence(after)}`,
          cause && `Cause: ${RETRY_CAUSE[cause] ?? cause}.`,
          at && `Not before ${new Date(at).toLocaleString()}.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'run.requeue': {
      const n = whole(input.relaunch);
      const of = whole(output.of);
      return {
        label: `Put back in the queue${n ? ` (${n}${of ? ` of ${of}` : ''})` : ''}`,
        note: text(output.after)
          ? `After: ${sentence(String(output.after))} The run had not started.`
          : undefined,
      };
    }
    case 'schedule.catch_up': {
      const missed = whole(output.missedSlots);
      const first = text(output.firstMissed);
      return {
        label: 'Caught up a missed schedule',
        note: [
          missed !== undefined &&
            `${plural(missed, 'scheduled time')}${output.countCapped ? ' or more' : ''} passed while this computer slept or the gateway was down` +
              `${first ? `, the first at ${new Date(first).toLocaleString()}` : ''}.`,
          'This one run stands for all of them.',
          text(output.noticed) && `Noticed on ${String(output.noticed)}.`,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'memory.read': {
      const types = Array.isArray(input.types) ? (input.types as unknown[]).map(String) : [];
      const n = whole(output.notes) ?? 0;
      return {
        label: n ? `Read ${plural(n, 'saved note')}` : 'Looked for saved notes: none matched',
        note:
          `Types read: ${types.join(', ') || 'none'}.` +
          (input.includeAgent ? ' Notes an agent wrote were included.' : '') +
          (n ? ' They were added to the prompt, so the model saw them.' : ''),
      };
    }
    case 'context.compact': {
      const method = text(input.method);
      const before = whole(output.tokensBefore);
      const after = whole(output.tokensAfter);
      const done = whole(output.compactedMessages);
      return {
        label: method === 'summary' ? 'Summarised earlier context' : 'Dropped earlier context',
        note: [
          'The conversation reached the model’s window.',
          done !== undefined &&
            `${plural(done, 'older message')} ${method === 'summary' ? 'were summarised' : 'were left out'}.`,
          before !== undefined && after !== undefined && `${before} tokens became ${after}.`,
          method !== 'summary' && 'No summary was made, so the model no longer sees them.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    case 'driver.detect': {
      const model = text(input.model);
      const what = text(input.for);
      const available = fields(output).available !== false;
      const subject =
        what === 'chosen'
          ? `the model chosen for this run (${model ?? 'default'})`
          : model
            ? `${what ?? 'the'} model ${model}`
            : (text(input.driver) ?? 'the agent');
      return {
        label: `Checked ${subject}${available ? '' : ': not available'}`,
        note: text(output.reason),
      };
    }
    default:
      return null;
  }
}

/** A credential's source in words: "the GitHub App my-app", or the vault secret's name. */
function credentialWords(source: string): string {
  const app = /^github-app:([^/]+)\//.exec(source);
  return app ? `the GitHub App ${app[1]}` : source.replace(/^vault:/, '');
}

function gitStep(input: Fields, output: Fields): StepWords | null {
  const action = text(input.action);
  const repo = text(input.repo);
  if (action === 'clone' || action === 'cached') {
    const credential = text(output.credential);
    return {
      label:
        action === 'clone'
          ? `Cloned ${repo ?? 'the repository'}`
          : `Used the cached clone of ${repo ?? 'the repository'}`,
      note: [
        text(output.path) && `Clone: ${String(output.path)}.`,
        credential ? `Reached with ${credentialWords(credential)}.` : 'No credential was used.',
        action === 'cached' &&
          'An existing clone was reused; the base branch is fetched into it next.',
      ]
        .filter(Boolean)
        .join(' '),
    };
  }
  return null;
}

/** The hosts the sandbox refused a gate's connections to, once each. */
function blockedHosts(output: Fields): string[] {
  const denied = Array.isArray(output.egressDenied) ? (output.egressDenied as Fields[]) : [];
  return [...new Set(denied.map((d) => String(d.host)))];
}

/** Read a step in words. */
export function describeStep(step: RunStep): StepWords {
  const input = fields(step.input);
  const output = fields(step.output);
  switch (step.kind) {
    case 'gate': {
      const what = String(input.run ?? input.assert ?? '');
      const blocked = blockedHosts(output);
      if (blocked.length) {
        return {
          label: `Gate: ${what}: ${plural(blocked.length, 'host')} blocked`,
          note:
            `The sandbox refused connections to ${blocked.join(', ')}. ` +
            'A host the gate needs goes in sandbox.network in the spec.',
        };
      }
      return { label: `Gate: ${what}` };
    }
    case 'git': {
      const words = gitStep(input, output);
      if (words) return words;
      const action = String(input.action ?? '');
      const known: Record<string, string> = {
        fetch: 'Fetched the base branch',
        worktree: `Opened a worktree${output.branch ? ` on ${String(output.branch)}` : ''}`,
        commit: `Committed${output.sha ? ` ${String(output.sha).slice(0, 7)}` : ''}`,
        push: `Pushed ${String(input.branch ?? '')}`.trim(),
        pull_request: 'Opened a draft pull request',
      };
      const credential = text(output.credential);
      const actor = text(output.openedBy) ?? text(output.pushedAs);
      const note = credential
        ? `Used ${credentialWords(credential)}.` +
          (actor ? ` Done as ${actor}, the app’s own account, not as a person.` : '')
        : undefined;
      return { label: known[action] ?? `git ${action}`, ...(note ? { note } : {}) };
    }
    case 'tool': {
      const name = String(input.name ?? '');
      return toolStep(name, input, output) ?? { label: `Tool: ${name}` };
    }
    case 'llm':
      return {
        label: step.status === 'text' ? String(output.text ?? '').split('\n')[0] : 'Model call',
      };
    case 'shell':
      return { label: `Shell: ${String(input.command ?? input.run ?? '')}` };
    default:
      return { label: step.kind };
  }
}

export function stepLabel(step: RunStep): string {
  return describeStep(step).label;
}

/** A tool, as the policy names it, in words. */
export function toolLabel(name: string): string {
  if (name.startsWith('memory.write')) return 'Save a note';
  const labels: Record<string, string> = {
    'fs.read': 'Read a file',
    'fs.list': 'List files',
    'fs.search': 'Search files',
    'fs.write': 'Write a file',
    'fs.edit': 'Edit a file',
    'runtime.shell': 'Run a command',
    'git.status': 'Check changes',
    'git.diff': 'Show changes',
    'git.push': 'Push',
    'memory.search': 'Search saved notes',
    'automation.draft': 'Draft an automation',
    'sessions.spawn': 'Start a sub-agent',
  };
  return labels[name] ?? name;
}
