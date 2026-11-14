/** `clerq approvals | approve <id> | deny <id>`. */

import {
  GatewayError,
  gateway,
  toolLabel,
  type Approval,
  type RunDetail,
} from '@clerq/gateway-client';
import { str, type Call } from '../args.js';
import { connect } from '../connect.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { dateTime, oneLine, table } from '../format.js';

/** Where an approval was asked: an automation's run, a chat, or a sub-agent. */
async function whereFrom(a: Approval, runs: Map<string, RunDetail | null>): Promise<string> {
  const load = async (id: string) => {
    if (!runs.has(id)) {
      try {
        runs.set(id, await gateway.run(id));
      } catch {
        runs.set(id, null);
      }
    }
    return runs.get(id) ?? null;
  };
  if (a.parentRunId) {
    const parent = await load(a.parentRunId);
    return `Sub-agent of run ${a.parentRunId}${parent?.automationName ? ` (${parent.automationName})` : ''}`;
  }
  const run = await load(a.runId);
  if (a.sessionId) return `Chat ${a.sessionId}`;
  if (run?.automationName) return `Run ${a.runId} of ${run.automationName}`;
  return `Run ${a.runId}`;
}

export async function runList(ctx: Context, _call: Call): Promise<number> {
  const { out } = ctx;
  await connect(ctx);
  const { approvals } = await gateway.approvals();
  const runs = new Map<string, RunDetail | null>();
  const rows: string[][] = [];
  const described = [];
  for (const a of approvals) {
    const from = await whereFrom(a, runs);
    described.push({ ...a, from });
    rows.push([
      String(a.id),
      from,
      `${toolLabel(a.tool)}${toolLabel(a.tool) !== a.tool ? ` (${a.tool})` : ''}`,
      oneLine(a.reason, 90),
      dateTime(a.requestedAt),
    ]);
  }
  out.data({ approvals: described });
  if (approvals.length === 0) {
    out.say('Nothing is waiting for an answer.');
    return EXIT.ok;
  }
  for (const line of table(['ID', 'FROM', 'TOOL', 'WHY', 'ASKED'], rows)) out.say(line);
  out.say('');
  out.say('Answer with `clerq approve <id>` or `clerq deny <id> [--reason <text>]`.');
  return EXIT.ok;
}

function approvalId(text: string): number {
  if (!/^\d+$/.test(text)) {
    throw new UsageError(`"${text}" is not an approval number. \`clerq approvals\` lists them.`);
  }
  return Number(text);
}

async function decide(ctx: Context, call: Call, decision: 'approve' | 'deny'): Promise<number> {
  const { out } = ctx;
  const id = approvalId(call.args[0]);
  const reason = decision === 'deny' ? str(call, 'reason') : undefined;
  await connect(ctx);
  try {
    await gateway.decideApproval(id, decision, { by: 'cli', ...(reason ? { reason } : {}) });
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) {
      throw new CliError(
        `Approval ${id} is not waiting for an answer: it was already decided, or its run has ended. \`clerq approvals\` lists what is waiting.`
      );
    }
    throw e;
  }
  out.data({
    ok: true,
    id,
    decision: decision === 'approve' ? 'approved' : 'denied',
    ...(reason ? { reason } : {}),
  });
  out.say(`${decision === 'approve' ? 'Approved' : 'Denied'} ${id}.`);
  return EXIT.ok;
}

export const runApprove = (ctx: Context, call: Call) => decide(ctx, call, 'approve');
export const runDeny = (ctx: Context, call: Call) => decide(ctx, call, 'deny');
