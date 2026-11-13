/**
 * What an in-process or CLI agent did, written to its run as it happens: one
 * step per piece of narration and per tool call, a `tool_calls` row beside
 * each call's step, one accounted step per model call, and the context
 * compactions. An automation run and a managed chat message record through
 * this one path, so their traces read the same.
 */

import type { DriverEvent } from '@clerq/drivers';
import {
  addRunStep,
  addToolCall,
  completeRunStep,
  completeToolCall,
  recordModelCall,
  runEventContext,
} from '../runs.js';
import { emit } from '../events.js';

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export interface EventRecorder {
  /**
   * Record one event. Returns true when it was one this recorder handles
   * (text, tool_call, tool_result, model_call, context); the caller handles the rest.
   */
  record(event: DriverEvent): boolean;
  /** Model calls the driver reported one by one. */
  readonly modelCalls: number;
  /** The error of the latest model call, when it failed. */
  readonly lastModelError: string | undefined;
}

export function eventRecorder(runId: string): EventRecorder {
  const ctx = runEventContext(runId);
  const pending = new Map<string, { seq: number; row: number; started: number }>();
  let modelCalls = 0;
  let lastModelError: string | undefined;

  return {
    get modelCalls() {
      return modelCalls;
    },
    get lastModelError() {
      return lastModelError;
    },
    record(event) {
      switch (event.type) {
        case 'text':
          // Narration, not a model call: status "text" keeps it out of cost accounting.
          addRunStep(runId, { kind: 'llm', output: { text: event.text }, status: 'text' });
          return true;
        case 'tool_call': {
          const seq = addRunStep(runId, {
            kind: 'tool',
            input: { name: event.name, input: event.input },
            status: 'running',
          });
          const row = addToolCall(runId, {
            stepSeq: seq,
            callId: event.id,
            name: event.name,
            input: event.input,
          });
          pending.set(event.id, { seq, row, started: Date.now() });
          emit('tool.started', { name: event.name }, { ...ctx, toolCallId: event.id });
          return true;
        }
        case 'tool_result': {
          const call = pending.get(event.id);
          if (call) {
            const status = event.denied ? 'denied' : event.isError ? 'error' : 'ok';
            const durationMs = Date.now() - call.started;
            const output = tail(event.output, 16_000);
            completeRunStep(runId, call.seq, { output: { text: output }, status, durationMs });
            completeToolCall(call.row, { output, status, durationMs, approval: event.approval });
            pending.delete(event.id);
          }
          emit(
            event.isError ? 'tool.failed' : 'tool.completed',
            {},
            { ...ctx, toolCallId: event.id }
          );
          return true;
        }
        case 'model_call': {
          modelCalls += 1;
          const c = event.call;
          lastModelError = c.ok ? undefined : c.error;
          recordModelCall({
            provider: c.provider,
            model: c.model,
            prompt:
              c.purpose === 'turn'
                ? `Agent turn ${c.turn}`
                : `Summary of earlier context, before turn ${c.turn + 1}`,
            status: c.ok ? 'ok' : 'error',
            text:
              c.text ||
              (c.toolCalls ? `${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'}` : ''),
            error: c.error,
            tokensIn: c.tokensIn,
            tokensOut: c.tokensOut,
            costUsd: c.costUsd,
            latencyMs: c.latencyMs,
          });
          return true;
        }
        case 'context': {
          const { type: _type, action: _action, ...record } = event;
          addRunStep(runId, {
            kind: 'tool',
            input: { name: 'context.compact', method: event.method },
            output: record,
            status: event.method === 'summary' ? 'ok' : 'warning',
          });
          return true;
        }
        default:
          return false;
      }
    },
  };
}
