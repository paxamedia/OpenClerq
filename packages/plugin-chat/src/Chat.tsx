/**
 * Chat: conversations, the transcript, and an inspector with the request, raw
 * response, tokens and cost. Raw sends the conversation as it is; Managed runs
 * an agent with the system prompt, skills, memory and tools (files and
 * commands only in a folder you attach), asks before what needs approval,
 * and can draft automations you preview, dry-run and save (they start off).
 * Compare sends one message to several models side by side.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, FolderOpen, MessageSquare, Plus, Send, Square, Trash2 } from 'lucide-react';
import type {
  ChatMessage,
  ChatSession,
  ComparisonColumn,
  PipelineMode,
} from '@clerq/gateway-client';
import {
  Button,
  Checkbox,
  CodeBlock,
  CompareBars,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  IconButton,
  KeyValue,
  Loaded,
  Page,
  PageHeader,
  PageSkeleton,
  PHONE_QUERY,
  ProgressLine,
  SegmentedControl,
  Select,
  Split,
  Textarea,
  When,
  cx,
  duration,
  errorMessage,
  metricText,
  metricValue,
  money,
  navigate,
  tokens,
  useClient,
  useInvalidate,
  useMedia,
  useResource,
  useToast,
} from '@clerq/web/plugin-ui';
import type { PluginProps } from '@clerq/plugin-sdk/ui';
import { useProviders, useSessions } from './data';
import {
  DraftCard,
  FolderDialog,
  LiveActivity,
  ModeDiffView,
  permissionLabel,
  type LiveApproval,
  type LiveTool,
} from './Managed';
import './chat.css';

function costText(cost: number | null | undefined): string {
  return cost === null || cost === undefined ? 'cost unknown' : money(cost);
}

function MetaLine({ meta }: { meta: ChatMessage['meta'] }) {
  if (!meta || meta.columns) return null;
  const parts: string[] = [];
  if (meta.model)
    parts.push(meta.provider ? `${meta.provider} · ${meta.model}` : String(meta.model));
  if (typeof meta.tokensIn === 'number')
    parts.push(`${tokens(meta.tokensIn, false)} in · ${tokens(meta.tokensOut ?? 0, false)} out`);
  if (typeof meta.toolCalls === 'number' && meta.toolCalls > 0)
    parts.push(`${meta.toolCalls} tool call${meta.toolCalls === 1 ? '' : 's'}`);
  if (meta.mode !== 'managed' || 'costUsd' in meta) parts.push(costText(meta.costUsd));
  if (typeof meta.latencyMs === 'number') parts.push(duration(meta.latencyMs));
  return parts.length ? <p className="chat-meta">{parts.join(' · ')}</p> : null;
}

function Columns({
  columns,
  chosen,
  onPromote,
}: {
  columns: ComparisonColumn[];
  chosen?: number | null;
  onPromote: (index: number) => void;
}) {
  return (
    <div className="chat-compare">
      <CompareBars columns={columns} />
      <div className="chat-columns">
        {columns.map((c, i) => (
          <div key={`${c.model}-${i}`} className={cx('chat-column', chosen === i && 'is-chosen')}>
            <div className="chat-column-head">
              <strong className="page-mono">{c.model}</strong>
              {chosen === i && <span className="chat-chosen">In the transcript</span>}
            </div>
            {c.error ? (
              <p className="tone-text-err">{c.error}</p>
            ) : (
              <p className="chat-text">{c.text}</p>
            )}
            <p className="chat-meta">
              {[
                metricText(metricValue(c, 'tokens'), 'tokens'),
                c.error ? null : costText(c.costUsd),
                metricText(metricValue(c, 'latency'), 'latency'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {!c.error && chosen !== i && (
              <Button size="sm" onClick={() => onPromote(i)}>
                Use this answer
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Inspector({
  message,
  sessionId,
  question,
  onClose,
}: {
  message: ChatMessage | null;
  sessionId: string;
  /** The user message this answers, for the managed-over-raw comparison. */
  question: string;
  onClose: () => void;
}) {
  const meta = message?.meta;
  const raw = meta
    ? Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'request'))
    : null;
  return (
    <Drawer open={Boolean(message)} onClose={onClose} title="Inspector" size="lg">
      {message && (
        <div className="chat-inspector">
          <KeyValue
            items={[
              {
                label: 'Model',
                value: meta?.model ? `${meta.provider ?? ''} ${meta.model}`.trim() : '',
              },
              {
                label: 'Mode',
                value:
                  meta?.mode === 'managed'
                    ? 'Managed'
                    : meta?.mode === 'compare'
                      ? 'Compare'
                      : 'Raw',
              },
              {
                label: 'Tokens',
                value:
                  typeof meta?.tokensIn === 'number'
                    ? `${tokens(meta.tokensIn, false)} in · ${tokens(meta.tokensOut ?? 0, false)} out`
                    : '',
                mono: true,
              },
              { label: 'Cost', value: costText(meta?.costUsd), mono: true },
              {
                label: 'Latency',
                value: typeof meta?.latencyMs === 'number' ? duration(meta.latencyMs) : '',
                mono: true,
              },
              {
                label: 'Run',
                value: meta?.runId ? (
                  <a className="page-link" href={`#/runs/${encodeURIComponent(meta.runId)}`}>
                    {meta.runId}
                  </a>
                ) : (
                  ''
                ),
              },
            ]}
          />
          {meta?.mode === 'managed' && <ModeDiffView sessionId={sessionId} text={question} />}
          {meta?.request ? (
            <CodeBlock
              title="Request"
              code={JSON.stringify(meta.request, null, 2)}
              maxHeight="lg"
            />
          ) : null}
          <CodeBlock
            title="Response"
            code={JSON.stringify({ content: message.content, meta: raw }, null, 2)}
            maxHeight="lg"
            wrap
          />
        </div>
      )}
    </Drawer>
  );
}

function Conversations({
  sessions,
  currentId,
  onNew,
  base,
}: {
  sessions: ChatSession[];
  currentId: string | null;
  onNew: () => void;
  base: string;
}) {
  return (
    <aside className="chat-sessions" aria-label="Conversations">
      <div className="chat-sessions-head">
        <Button size="sm" icon={Plus} onClick={onNew}>
          New conversation
        </Button>
      </div>
      {sessions.length === 0 ? (
        <p className="page-hint chat-sessions-empty">No conversations yet.</p>
      ) : (
        <ul className="chat-session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <a
                href={`#${base}/${encodeURIComponent(s.id)}`}
                className={cx('chat-session', s.id === currentId && 'is-active')}
                aria-current={s.id === currentId ? 'page' : undefined}
              >
                <span className="chat-session-title">{s.title ?? 'Untitled'}</span>
                <span className="chat-session-sub">
                  {s.mode === 'managed' ? 'Managed' : 'Raw'} · {s.messageCount} messages ·{' '}
                  <When at={s.updatedAt} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function Conversation({ id, base }: { id: string; base: string }) {
  const client = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const providers = useProviders();
  const session = useResource(`session:${id}`, () => client.session(id), { on: ['sessions'] });
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compareModels, setCompareModels] = useState<string[]>([]);
  const [streaming, setStreaming] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [inspect, setInspect] = useState<ChatMessage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [liveApprovals, setLiveApprovals] = useState<LiveApproval[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const inFlight = useRef<AbortController | null>(null);

  const options = useMemo(
    () =>
      (providers.data?.providers ?? []).flatMap((p) =>
        p.models.map((m) => ({ ref: m.ref, label: `${p.label} · ${m.id}`, ready: p.ready }))
      ),
    [providers.data]
  );

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [session.data?.messages.length, streaming]);

  // Leaving mid-answer stops the answer, and its spending.
  useEffect(() => () => inFlight.current?.abort(), []);

  const reload = useCallback(async () => {
    await session.reload();
    invalidate(['sessions']);
  }, [session, invalidate]);

  const setMode = async (mode: PipelineMode) => {
    try {
      await client.updateSession(id, { mode });
      await reload();
    } catch (e) {
      toast({ message: `Couldn’t switch mode. ${errorMessage(e)}`, tone: 'err' });
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    if (comparing) {
      try {
        await client.compare(id, { text, models: compareModels });
        await reload();
        setComparing(false);
      } catch (e) {
        setError(e);
        setDraft(text);
      } finally {
        setBusy(false);
      }
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setStreaming('');
    setLiveTools([]);
    setLiveApprovals([]);
    try {
      await client.sendMessage(
        id,
        { text, model: model || undefined },
        (d) => setStreaming((s) => s + d),
        controller.signal,
        (event) => {
          if (event.type === 'tool') {
            setLiveTools((list) =>
              event.status === 'running'
                ? [...list, { id: event.id, name: event.name, status: 'running' }]
                : list.map((t) => (t.id === event.id ? { ...t, status: event.status } : t))
            );
          } else if (event.type === 'approval') {
            setLiveApprovals((list) => [...list, { approval: event.approval }]);
            invalidate(['approvals']);
          } else if (event.type === 'approval_decided') {
            setLiveApprovals((list) =>
              list.map((a) =>
                a.approval.id === event.id ? { ...a, decided: true, approved: event.approved } : a
              )
            );
          }
        }
      );
      await reload();
    } catch (e) {
      if (controller.signal.aborted) await reload().catch(() => undefined);
      else {
        setError(e);
        setDraft(text);
      }
    } finally {
      inFlight.current = null;
      setStreaming('');
      setLiveTools([]);
      setLiveApprovals([]);
      setBusy(false);
    }
  };

  const decided = (approvalId: number, approved: boolean) =>
    setLiveApprovals((list) =>
      list.map((a) => (a.approval.id === approvalId ? { ...a, decided: true, approved } : a))
    );

  const promote = async (messageId: number, index: number) => {
    try {
      await client.promote(id, messageId, index);
      await reload();
    } catch (e) {
      toast({ message: `Couldn’t use that answer. ${errorMessage(e)}`, tone: 'err' });
    }
  };

  const remove = async () => {
    try {
      await client.deleteSession(id);
      invalidate(['sessions']);
      navigate(base, { replace: true });
    } catch (e) {
      toast({ message: `Couldn’t delete the conversation. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setConfirmDelete(false);
    }
  };

  if (!session.data) {
    return session.error ? (
      <ErrorState error={session.error} onRetry={session.reload} what="this conversation" />
    ) : (
      <PageSkeleton />
    );
  }
  const s = session.data;
  const canSend = draft.trim() && (!comparing || compareModels.length >= 2);

  return (
    <section className="chat-main" aria-label={s.title ?? 'Conversation'}>
      <PageHeader
        crumbs={[{ label: 'Chat', to: base }, { label: s.title ?? 'Untitled' }]}
        actions={
          <IconButton
            icon={Trash2}
            label="Delete conversation"
            onClick={() => setConfirmDelete(true)}
          />
        }
      />
      <div className="chat-toolbar">
        <SegmentedControl
          size="sm"
          label="Pipeline"
          value={s.mode}
          onChange={setMode}
          options={[
            { value: 'raw', label: 'Raw' },
            { value: 'managed', label: 'Managed' },
          ]}
        />
        <span className="page-hint chat-mode-hint">
          {s.mode === 'managed'
            ? 'Managed adds your prompt, skills, memory and tools.'
            : 'Raw sends the conversation as it is.'}
        </span>
        {s.mode === 'managed' && (
          <Button
            size="sm"
            variant="ghost"
            icon={FolderOpen}
            onClick={() => setFolderOpen(true)}
            title={s.workspace ?? undefined}
          >
            {s.workspace
              ? `${folderName(s.workspace)} · ${permissionLabel(s.permissionMode)}`
              : 'No folder'}
          </Button>
        )}
        <Select
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="chat-model"
        >
          <option value="">Default model</option>
          {options.map((m) => (
            <option key={m.ref} value={m.ref} disabled={!m.ready}>
              {m.label}
              {m.ready ? '' : ' (no key)'}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          icon={Columns3}
          variant={comparing ? 'primary' : 'secondary'}
          onClick={() => setComparing(!comparing)}
          aria-pressed={comparing}
        >
          Compare
        </Button>
      </div>
      <div className="chat-transcript">
        {s.messages.length === 0 && !streaming ? (
          <EmptyState icon={MessageSquare} title="Say something">
            Ask anything of any model you have a key for.
          </EmptyState>
        ) : null}
        {s.messages.map((m) => (
          <article key={m.id} className={cx('chat-turn', `is-${m.role}`)}>
            <header className="chat-turn-head">
              <span>
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Answer' : 'System'}
              </span>
              <When at={m.createdAt} />
              {m.meta && m.role !== 'user' && (
                <button
                  type="button"
                  className="page-link-button chat-inspect"
                  onClick={() => setInspect(m)}
                >
                  Inspect
                </button>
              )}
            </header>
            {m.meta?.columns ? (
              <Columns
                columns={m.meta.columns}
                chosen={m.meta.chosen}
                onPromote={(i) => promote(m.id, i)}
              />
            ) : (
              <p className="chat-text">{m.content}</p>
            )}
            {m.meta?.drafts?.map((d) => (
              <DraftCard key={d.id} sessionId={id} draftId={d.id} />
            ))}
            <MetaLine meta={m.meta} />
          </article>
        ))}
        {(streaming || (busy && !comparing)) && (
          <article className="chat-turn is-assistant">
            <header className="chat-turn-head">
              <span>Answer</span>
            </header>
            {streaming ? (
              <p className="chat-text">{streaming}</p>
            ) : (
              <ProgressLine label="Waiting for the answer" />
            )}
            <LiveActivity tools={liveTools} approvals={liveApprovals} onDecided={decided} />
          </article>
        )}
        {busy && comparing && <ProgressLine label="Waiting for every model" />}
        <div ref={end} />
      </div>
      {error ? <ErrorState error={error} compact /> : null}
      {comparing && (
        <fieldset className="chat-compare-picker">
          <legend className="page-hint">
            Pick two or more models. The first answer goes in the transcript until you choose
            another.
          </legend>
          <div className="chat-compare-models">
            {options.map((m) => (
              <Checkbox
                key={m.ref}
                label={m.label}
                disabled={!m.ready}
                checked={compareModels.includes(m.ref)}
                onChange={(e) =>
                  setCompareModels((prev) =>
                    e.target.checked ? [...prev, m.ref] : prev.filter((x) => x !== m.ref)
                  )
                }
              />
            ))}
          </div>
        </fieldset>
      )}
      <div className="chat-composer">
        <Textarea
          aria-label="Message"
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={comparing ? 'One message for every model you picked' : 'Message'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        />
        {busy && !comparing ? (
          <Button icon={Square} onClick={() => inFlight.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={comparing ? Columns3 : Send}
            disabled={!canSend}
            busy={busy}
            onClick={send}
          >
            {comparing ? 'Compare' : 'Send'}
          </Button>
        )}
      </div>
      <Inspector
        message={inspect}
        sessionId={id}
        question={questionFor(s.messages, inspect)}
        onClose={() => setInspect(null)}
      />
      <FolderDialog
        open={folderOpen}
        session={s}
        onClose={() => setFolderOpen(false)}
        onSaved={() => void reload()}
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${s.title ?? 'Untitled'}”?`}
        description="The conversation and its messages go. Its runs stay in the history."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" icon={Trash2} onClick={remove}>
              Delete conversation
            </Button>
          </>
        }
      />
    </section>
  );
}

/** The last part of a folder's path. */
function folderName(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** The user message an answer replies to. */
export function questionFor(messages: ChatMessage[], answer: ChatMessage | null): string {
  if (!answer) return '';
  const at = messages.findIndex((m) => m.id === answer.id);
  for (let i = at - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

export function ChatScreen({ parts, base }: PluginProps) {
  const client = useClient();
  const invalidate = useInvalidate();
  const toast = useToast();
  const sessions = useSessions();
  const phone = useMedia(PHONE_QUERY);
  const id = parts[0] ?? null;

  // Open the latest conversation when none is named (not on a phone, where the list is the page).
  useEffect(() => {
    if (!id && !phone && sessions.data?.length)
      navigate(`${base}/${encodeURIComponent(sessions.data[0].id)}`, { replace: true });
  }, [id, phone, sessions.data, base]);

  const create = async () => {
    try {
      const s = await client.createSession({ mode: 'raw' });
      invalidate(['sessions']);
      navigate(`${base}/${encodeURIComponent(s.id)}`);
    } catch (e) {
      toast({ message: `Couldn’t start a conversation. ${errorMessage(e)}`, tone: 'err' });
    }
  };

  return (
    <Page className="chat-page">
      {!id && <PageHeader crumbs={[{ label: 'Chat' }]} />}
      <Loaded resource={sessions} what="conversations" skeleton="rows">
        {(list) =>
          phone ? (
            id ? (
              <Conversation key={id} id={id} base={base} />
            ) : (
              <Conversations sessions={list} currentId={null} onNew={create} base={base} />
            )
          ) : (
            <Split
              storageKey="chat"
              initial={260}
              min={200}
              max={420}
              label="Resize the conversation list"
            >
              <Conversations sessions={list} currentId={id} onNew={create} base={base} />
              {id ? (
                <Conversation key={id} id={id} base={base} />
              ) : (
                <EmptyState
                  icon={MessageSquare}
                  title="No conversations yet"
                  actions={
                    <Button variant="primary" icon={Plus} onClick={create}>
                      New conversation
                    </Button>
                  }
                >
                  Talk to any model you have a key for.
                </EmptyState>
              )}
            </Split>
          )
        }
      </Loaded>
    </Page>
  );
}
