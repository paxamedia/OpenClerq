/** `clerq logs <run> [--follow]`. */

import { GatewayError, gateway } from '@clerq/gateway-client';
import { flag, type Call } from '../args.js';
import { connect } from '../connect.js';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { RunReader, emit, runHeader, watch } from '../follow.js';
import { closing } from './run.js';
import { findAutomation } from './automation.js';

/** A run id, or the name of an automation, meaning its latest run. */
async function runIdOf(ref: string): Promise<string> {
  if (ref.startsWith('run_')) return ref;
  const automation = await findAutomation(ref);
  if (!automation.lastRun) {
    throw new CliError(
      `${automation.name} has not run yet. Start it with: clerq run ${automation.name}`
    );
  }
  return automation.lastRun.id;
}

export async function run(ctx: Context, call: Call): Promise<number> {
  const { out } = ctx;
  const follow = flag(call, 'follow');
  if (flag(call, 'stop-at-approval') && !follow) {
    throw new UsageError('--stop-at-approval only means something with --follow.');
  }
  await connect(ctx);
  const id = await runIdOf(call.args[0]);

  let snapshot;
  try {
    snapshot = await gateway.run(id);
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) {
      throw new CliError(
        `There is no run "${id}". A run's id is printed when it starts; \`clerq automation show <name>\` shows the last one.`
      );
    }
    throw e;
  }

  if (!out.json) for (const line of runHeader(snapshot)) out.say(line);
  const reader = new RunReader();
  if (!follow) {
    const pending =
      snapshot.status === 'awaiting_approval'
        ? (await gateway.approvals()).approvals.filter(
            (a) => a.runId === id || a.parentRunId === id
          )
        : [];
    if (out.json) out.data({ type: 'run', run: snapshot });
    else out.say('');
    emit(ctx, id, out.json ? [] : reader.news(snapshot, pending, true));
    return EXIT.ok;
  }

  out.data({ type: 'run', run: snapshot });
  if (!out.json) out.say('');
  // Everything so far is shown by the first look inside watch(); the snapshot above was the header.
  const { run: last, exit } = await watch(ctx, id, {
    stopAtApproval: flag(call, 'stop-at-approval'),
    reader,
  });
  closing(ctx, last, exit);
  return exit;
}
