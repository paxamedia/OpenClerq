/** `clerq run <automation> [--model m] [--follow]`. */

import { gateway, type RunDetail } from '@clerq/gateway-client';
import { flag, str, type Call } from '../args.js';
import { connect } from '../connect.js';
import type { Context } from '../context.js';
import { EXIT, UsageError } from '../errors.js';
import { money } from '../format.js';
import { watch } from '../follow.js';
import { findAutomation } from './automation.js';

/** What a finished (or abandoned) watch says last, for a person and as data. */
export function closing(ctx: Context, run: RunDetail, exit: number): void {
  const { out } = ctx;
  if (exit === EXIT.interrupted) {
    out.note(`Stopped watching. The run goes on. Watch it again: clerq logs ${run.id} --follow`);
    return;
  }
  out.data({
    type: 'result',
    runId: run.id,
    status: run.status,
    exitReason: run.exitReason ?? null,
    branch: run.branch ?? null,
    prUrl: run.prUrl ?? null,
    costUsd: run.costUsd,
    costKnown: run.costKnown,
    exitCode: exit,
  });
  if (run.status === 'awaiting_approval') {
    out.note(
      `The run is waiting for an approval. Answer it with \`clerq approve <id>\` or \`clerq deny <id>\` (see \`clerq approvals\`), then watch it: clerq logs ${run.id} --follow`
    );
    return;
  }
  if (run.branch) out.say(`          Branch: ${run.branch}`);
  if (run.prUrl) out.say(`          Pull request: ${run.prUrl}`);
  if (run.costUsd > 0 || run.costKnown)
    out.say(`          Cost: ${money(run.costUsd, run.costKnown)}`);
}

export async function run(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const follow = flag(call, 'follow');
  const stopAtApproval = flag(call, 'stop-at-approval');
  if (stopAtApproval && !follow)
    throw new UsageError('--stop-at-approval only means something with --follow.');
  const model = str(call, 'model');

  await connect(ctx);
  const automation = await findAutomation(call.args[0]);
  if (model) {
    out.note(
      `Model ${model} is used as chosen: if it is unavailable the run fails; it does not fall back to another model.`
    );
  }
  const started = await gateway.runAutomation(automation.id, model);
  const queued = started.queued === true;
  out.data({
    type: 'started',
    runId: started.runId,
    queued,
    automation: { id: automation.id, name: automation.name },
    ...(model ? { model, strict: true } : {}),
  });
  out.say(`Started run ${started.runId} of ${automation.name}.`);
  if (queued) {
    out.say(
      'It is queued: the limit on runs at once is reached, and it starts when a place frees.'
    );
  }
  if (!follow) {
    out.say(`Watch it: clerq logs ${started.runId} --follow`);
    return EXIT.ok;
  }
  const { run: finished, exit } = await watch(ctx, started.runId, { stopAtApproval });
  closing(ctx, finished, exit);
  return exit;
}
