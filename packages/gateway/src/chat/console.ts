/**
 * The chat console's two jobs: talk to a model, and compare several.
 *
 * Every message is a run, so a conversation leaves the same durable trace an
 * automation does — including what each model call cost. Nothing here reaches
 * the filesystem or a tool: a raw conversation is a text channel, and the
 * policy engine has nothing to decide about it.
 */

import { chat } from '../agent/llm-provider.js';
import { recordRun, currentRunId } from '../runs.js';
import {
  addMessage,
  conversation,
  getSession,
  listMessages,
  updateSession,
  parseMode,
  SessionError,
  type Message,
  type PipelineMode,
  type Session,
} from './sessions.js';
import { getStore } from '../store.js';
import { logger } from '../logger.js';

/** The managed pipeline, injected so this module stays free of the agent wiring. */
export type ManagedPipeline = (
  message: string,
  model?: string
) => Promise<{ explanation: string; model?: string; skillSlug?: string }>;

export interface SendInput {
  sessionId: string;
  text: string;
  /** Overrides the session's mode for this message alone: "raw" or "managed". */
  mode?: unknown;
  model?: string;
  onDelta?: (text: string) => void;
  /** Called once the run exists, with its id — before any model call. */
  onStart?: (runId: string) => void;
  managed?: ManagedPipeline;
  /** Cancels the run when it aborts — typically the client disconnecting. */
  signal?: AbortSignal;
}

export interface SendResult {
  runId: string;
  message: Message;
}

function requireText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SessionError('message text is required.');
  }
  return text;
}

/** Name an untitled conversation after its opening line. */
function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Check a send before anything is spent or streamed, so a bad request can be
 * answered with a status code rather than an error event on an open stream.
 */
export function validateSend(input: Pick<SendInput, 'sessionId' | 'text' | 'mode' | 'model'>): {
  session: Session;
  text: string;
  mode: PipelineMode;
  model?: string;
} {
  const session = getSession(input.sessionId);
  if (!session) throw new SessionError(`No session ${input.sessionId}.`);
  const text = requireText(input.text);
  // An unknown mode is refused rather than quietly treated as raw.
  const mode = input.mode === undefined ? session.mode : parseMode(input.mode, session.mode);
  if (input.model !== undefined && typeof input.model !== 'string') {
    throw new SessionError('model must be a model reference string.');
  }
  const model = input.model?.trim() || session.model || undefined;
  return { session, text, mode, model };
}

export async function sendMessage(input: SendInput): Promise<SendResult> {
  const { session, text, mode, model } = validateSend(input);

  addMessage(session.id, { role: 'user', content: text });
  if (!session.title) updateSession(session.id, { title: titleFrom(text) });

  let runId = '';
  const message = await recordRun(
    { trigger: 'manual', message: text, signal: input.signal },
    async () => {
      runId = currentRunId() as string;
      input.onStart?.(runId);

      if (mode === 'managed') {
        if (!input.managed) throw new SessionError('The managed pipeline is not available here.');
        const result = await input.managed(text, model);
        return addMessage(session.id, {
          role: 'assistant',
          content: result.explanation,
          meta: { mode, model: result.model, skillSlug: result.skillSlug, runId },
        });
      }

      // Raw: the conversation as it stands, and nothing else. No system prompt.
      const res = await chat({
        messages: conversation(session.id),
        model,
        onDelta: input.onDelta,
      });
      return addMessage(session.id, {
        role: 'assistant',
        content: res.text,
        meta: {
          mode,
          provider: res.provider,
          model: res.model,
          tokensIn: res.usage.inputTokens,
          tokensOut: res.usage.outputTokens,
          usageReported: res.usageReported,
          costUsd: res.costUsd,
          latencyMs: res.latencyMs,
          // Raw mode exists to answer "what exactly was sent?".
          request: res.request,
          ...(res.truncated ? { truncated: true } : {}),
          runId,
        },
      });
    }
  );

  return { runId, message };
}

export interface ComparisonColumn {
  model: string;
  provider?: string;
  text?: string;
  error?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  latencyMs?: number;
}

export interface CompareResult {
  runId: string;
  messageId: number;
  columns: ComparisonColumn[];
}

/**
 * Send one message to several models at once.
 *
 * A model that fails becomes a column with an error, not a failed comparison:
 * the point is to see how they differ, and "this one refused" is a result.
 */
export async function compare(input: {
  sessionId: string;
  text: string;
  models: unknown;
  /** Cancels every column when it aborts. */
  signal?: AbortSignal;
}): Promise<CompareResult> {
  const session = getSession(input.sessionId);
  if (!session) throw new SessionError(`No session ${input.sessionId}.`);
  const text = requireText(input.text);
  const models = validateModels(input.models);

  const history = conversation(session.id);
  addMessage(session.id, { role: 'user', content: text });
  if (!session.title) updateSession(session.id, { title: titleFrom(text) });
  const messages = [...history, { role: 'user' as const, content: text }];

  let runId = '';
  const columns = await recordRun(
    { trigger: 'manual', message: text, signal: input.signal },
    async () => {
      runId = currentRunId() as string;
      return Promise.all(
        models.map(async (model): Promise<ComparisonColumn> => {
          try {
            const res = await chat({ messages, model });
            return {
              model: `${res.provider}/${res.model}`,
              provider: res.provider,
              text: res.text,
              tokensIn: res.usage.inputTokens,
              tokensOut: res.usage.outputTokens,
              costUsd: res.costUsd,
              latencyMs: res.latencyMs,
            };
          } catch (e) {
            return { model, error: columnError(e) };
          }
        })
      );
    }
  );

  // The first answer stands as the turn until a human promotes another, so the
  // conversation can continue either way.
  const chosen = columns.findIndex((c) => c.text !== undefined);
  const message = addMessage(session.id, {
    role: 'assistant',
    content: chosen === -1 ? '' : (columns[chosen].text ?? ''),
    meta: { mode: 'compare', chosen: chosen === -1 ? null : chosen, columns, runId },
  });

  return { runId, messageId: message.id, columns };
}

/** The most models one comparison may fan out to — each is a paid call. */
export const MAX_COMPARE_MODELS = 8;

/**
 * Model references for a comparison: two to eight non-empty strings. The same
 * model may appear twice — comparing a model with itself shows its variance.
 */
function validateModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new SessionError('Comparison needs at least two models.');
  }
  if (value.length > MAX_COMPARE_MODELS) {
    throw new SessionError(`Comparison is limited to ${MAX_COMPARE_MODELS} models at a time.`);
  }
  return value.map((m, i) => {
    if (typeof m !== 'string' || !m.trim()) {
      throw new SessionError(`Model ${i + 1} must be a non-empty model reference string.`);
    }
    return m.trim();
  });
}

/**
 * What a failed column says. A provider's own message is useful and safe to
 * show; anything else is an internal fault, logged here and summarised there.
 */
function columnError(e: unknown): string {
  if ((e as { code?: unknown })?.code === 'provider_error') {
    return e instanceof Error ? e.message : String(e);
  }
  logger.error('Comparison column failed', { err: e instanceof Error ? e.message : String(e) });
  return 'Internal error; see the gateway log.';
}

/** Make another column of a comparison the canonical turn. */
export function promote(sessionId: string, messageId: number, index: number): Message {
  const message = listMessages(sessionId).find((m) => m.id === messageId);
  if (!message) throw new SessionError(`No message ${messageId} in ${sessionId}.`);
  const columns = message.meta?.columns as ComparisonColumn[] | undefined;
  if (!columns) throw new SessionError('That message is not a comparison.');
  const column = columns[index];
  if (!column || column.text === undefined) {
    throw new SessionError(`Column ${index} has no answer to promote.`);
  }

  // The alternatives stay on the message; promoting chooses, it does not discard.
  getStore()
    .prepare('UPDATE messages SET content = ?, meta = ? WHERE id = ? AND session_id = ?')
    .run(column.text, JSON.stringify({ ...message.meta, chosen: index }), messageId, sessionId);
  return { ...message, content: column.text, meta: { ...message.meta, chosen: index } };
}
