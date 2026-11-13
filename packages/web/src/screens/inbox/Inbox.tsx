/**
 * The inbox: everything waiting for you, from every module. Approvals show the
 * action, its risk, the change and the gate results, so they can be decided
 * here; other items can be answered, marked done or dismissed.
 * J and K move; A approves or marks done; D denies or dismisses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ExternalLink,
  Inbox as InboxIcon,
  ListTodo,
  MessageSquareReply,
  Send,
  ShieldCheck,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Approval, InboxItem, RunDetail, RunStep } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { KeyValue } from '../../ui/Display';
import { Textarea } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { StatusTag, type Tone } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { cx } from '../../ui/cx';
import { useClient } from '../../app/client';
import { useApprovals, useRun } from '../../app/data';
import { errorMessage } from '../../app/format';
import { fillRef, moduleRoute, refId, useExtensions } from '../../app/extensions';
import { useLive, useResource } from '../../app/live';
import { Link, navigate } from '../../app/router';
import {
  EmptyState,
  Loaded,
  Page,
  PageHeader,
  PageSkeleton,
  PHONE_QUERY,
  Section,
  useMedia,
} from '../../shell/layout';
import { ModuleFrame } from '../../shell/ModuleFrame';
import { When } from '../common';
import './inbox.css';

const RISK: Record<Approval['tier'], { label: string; tone: Tone }> = {
  low: { label: 'Low risk', tone: 'muted' },
  medium: { label: 'Medium risk', tone: 'warn' },
  high: { label: 'High risk', tone: 'err' },
};

/** What the action does, in words. */
export function actionLabel(tool: string): string {
  const known: Record<string, string> = {
    'git.push': 'push',
    'forge.pull_request': 'pull request',
    'git.commit': 'commit',
    'runtime.agent': 'agent run',
    'runtime.gate': 'gate',
  };
  return known[tool] ?? tool;
}

function gateSteps(run: RunDetail | undefined): RunStep[] {
  return (run?.steps ?? []).filter((s) => s.kind === 'gate');
}

function diffStat(run: RunDetail | undefined) {
  const commit = (run?.steps ?? []).find(
    (s) => s.kind === 'git' && (s.input as { action?: string } | undefined)?.action === 'commit'
  );
  return commit?.output as
    | { filesChanged?: number; insertions?: number; deletions?: number; files?: string[] }
    | undefined;
}

/**
 * Where an approval came from, as links: the run that started the sub-agent
 * asking, and the chat that is waiting for the answer. Nothing when it is
 * neither.
 */
export function ApprovalOrigin({ approval }: { approval: Approval }) {
  if (!approval.parentRunId && !approval.sessionId) return null;
  return (
    <span className="approvals-origin">
      {approval.parentRunId && (
        <span>
          Sub-agent of run{' '}
          <Link className="page-link" to={`/runs/${encodeURIComponent(approval.parentRunId)}`}>
            {approval.parentRunId}
          </Link>
        </span>
      )}
      {approval.sessionId && (
        <Link className="page-link" to={`/m/chat/${encodeURIComponent(approval.sessionId)}`}>
          Open the chat
        </Link>
      )}
    </span>
  );
}

export function ApprovalDetail({
  approval,
  onDecide,
  busy,
}: {
  approval: Approval;
  onDecide: (a: Approval, d: 'approve' | 'deny') => void;
  busy: boolean;
}) {
  const run = useRun(approval.runId);
  const stat = diffStat(run.data);
  const gates = gateSteps(run.data);
  const risk = RISK[approval.tier];
  const action = actionLabel(approval.tool);
  return (
    <div className="approval-detail">
      <header className="approval-detail-head">
        <h2 className="approval-title">Approve {action}?</h2>
        <StatusTag tone={risk.tone}>{risk.label}</StatusTag>
      </header>
      <p className="approval-reason">{approval.reason}</p>
      <KeyValue
        items={[
          {
            label: 'Run',
            value: (
              <Link className="page-link" to={`/runs/${encodeURIComponent(approval.runId)}`}>
                {run.data?.automationName ?? approval.runId}
              </Link>
            ),
          },
          ...(approval.parentRunId
            ? [
                {
                  label: 'Sub-agent of',
                  value: (
                    <Link
                      className="page-link"
                      to={`/runs/${encodeURIComponent(approval.parentRunId)}`}
                    >
                      {approval.parentRunId}
                    </Link>
                  ),
                  mono: true,
                },
              ]
            : []),
          ...(approval.sessionId
            ? [
                {
                  label: 'Asked in',
                  value: (
                    <Link
                      className="page-link"
                      to={`/m/chat/${encodeURIComponent(approval.sessionId)}`}
                    >
                      A chat
                    </Link>
                  ),
                },
              ]
            : []),
          { label: 'Asked', value: <When at={approval.requestedAt} /> },
          { label: 'Branch', value: run.data?.branch, mono: true },
        ]}
      />
      {!run.data && !run.error ? (
        <PageSkeleton kind="text" label="Loading the run" />
      ) : (
        <>
          <Section title="Change">
            {stat?.filesChanged !== undefined ? (
              <div className="approval-stat">
                <span>
                  {stat.filesChanged} {stat.filesChanged === 1 ? 'file' : 'files'}{' '}
                  <span className="tone-text-ok">+{stat.insertions ?? 0}</span>{' '}
                  <span className="tone-text-err">−{stat.deletions ?? 0}</span>
                </span>
                {stat.files?.length ? (
                  <ul className="approval-files">
                    {stat.files.slice(0, 8).map((f) => (
                      <li key={f} className="page-mono">
                        {f}
                      </li>
                    ))}
                    {stat.files.length > 8 && (
                      <li className="page-muted">and {stat.files.length - 8} more</li>
                    )}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="page-hint">No commit recorded for this run.</p>
            )}
          </Section>
          <Section title="Gates">
            {gates.length ? (
              <ul className="approval-gates">
                {gates.map((g) => (
                  <li key={g.seq}>
                    <StatusTag
                      tone={
                        g.status === 'passed' ? 'ok' : g.status === 'running' ? 'accent' : 'err'
                      }
                    >
                      {g.status === 'passed'
                        ? 'Passed'
                        : g.status === 'running'
                          ? 'Running'
                          : 'Failed'}
                    </StatusTag>
                    <code>{String((g.input as { run?: string } | undefined)?.run ?? '')}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="page-hint">This automation has no gates.</p>
            )}
          </Section>
        </>
      )}
      <div className="approval-actions">
        <Link
          className="page-link approval-open"
          to={`/runs/${encodeURIComponent(approval.runId)}`}
        >
          <Icon glyph={ExternalLink} size={14} /> Open run
        </Link>
        <Button
          variant="danger"
          icon={X}
          disabled={busy}
          onClick={() => onDecide(approval, 'deny')}
          aria-keyshortcuts="D"
        >
          Deny
        </Button>
        <Button
          variant="primary"
          icon={Check}
          disabled={busy}
          onClick={() => onDecide(approval, 'approve')}
          aria-keyshortcuts="A"
        >
          Approve {action}
        </Button>
      </div>
    </div>
  );
}

/** The open items, approvals included, most urgent first. */
export function useInbox() {
  const client = useClient();
  return useResource(
    'inbox',
    async () =>
      (await client.inbox({ status: 'open' })).items.sort(
        (a, b) => b.priority - a.priority || Date.parse(b.createdAt) - Date.parse(a.createdAt)
      ),
    { on: ['inbox', 'approvals'] }
  );
}

const KIND: Record<InboxItem['kind'], { label: string; icon: LucideIcon; tone: Tone }> = {
  approval: { label: 'Approval', icon: ShieldCheck, tone: 'warn' },
  reply: { label: 'Reply', icon: MessageSquareReply, tone: 'accent' },
  task: { label: 'Task', icon: ListTodo, tone: 'accent' },
  alert: { label: 'Alert', icon: TriangleAlert, tone: 'err' },
};

/** Keys are ignored this long after a decision, so a held key cannot decide the next item. */
export const DECISION_COOLDOWN_MS = 400;
/** A high-risk approval by key needs the same key again within this long. */
export const CONFIRM_WINDOW_MS = 4000;

export interface KeyState {
  key: string;
  repeat: boolean;
  now: number;
  /** When the last decision was made by key, or 0. */
  lastDecisionAt: number;
  /** The item the address names. Never the implicit first one. */
  opened: InboxItem | undefined;
  approval: Approval | undefined;
  /** The approval's run (change and gates) has loaded. */
  runLoaded: boolean;
  /** An armed high-risk approve: the approval id and when it was armed. */
  armed: { id: number; at: number } | null;
}

export type KeyAction =
  | { kind: 'none' }
  | { kind: 'move'; by: 1 | -1 }
  | { kind: 'arm'; approval: Approval }
  | { kind: 'approve' | 'deny'; approval: Approval }
  | { kind: 'done' | 'dismissed'; item: InboxItem };

/** What a key press does. Decisions need an opened item, loaded run data, and no repeat. */
export function keyAction(s: KeyState): KeyAction {
  const none: KeyAction = { kind: 'none' };
  const key = s.key.toLowerCase();
  if (key === 'j') return s.repeat ? none : { kind: 'move', by: 1 };
  if (key === 'k') return s.repeat ? none : { kind: 'move', by: -1 };
  if (key !== 'a' && key !== 'd') return none;
  if (s.repeat || !s.opened) return none;
  if (s.now - s.lastDecisionAt < DECISION_COOLDOWN_MS) return none;
  if (s.approval) {
    if (!s.runLoaded) return none;
    if (key === 'd') return { kind: 'deny', approval: s.approval };
    const confirmed =
      s.armed && s.armed.id === s.approval.id && s.now - s.armed.at <= CONFIRM_WINDOW_MS;
    return s.approval.tier === 'high' && !confirmed
      ? { kind: 'arm', approval: s.approval }
      : { kind: 'approve', approval: s.approval };
  }
  if (approvalId(s.opened) !== null) return none;
  return { kind: key === 'a' ? 'done' : 'dismissed', item: s.opened };
}

const approvalId = (item: InboxItem): number | null =>
  item.id.startsWith('apr_') ? Number(item.id.slice(4)) : null;

function ItemDetail({
  item,
  onClose,
}: {
  item: InboxItem;
  onClose: (item: InboxItem, status: 'done' | 'dismissed') => void;
}) {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const extensions = useExtensions();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const view = (extensions.data?.['inbox.item'] ?? []).find(
    (x) => x.moduleId === item.moduleId && (!x.kind || x.kind === item.kind) && x.path
  );
  const kind = KIND[item.kind];

  const respond = async () => {
    setBusy(true);
    try {
      await client.respondInboxItem(item.id, { text });
      setText('');
      toast({ message: 'Sent.', tone: 'ok' });
      live.invalidate(['inbox']);
    } catch (e) {
      toast({ message: `Couldn’t send. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval-detail">
      <header className="approval-detail-head">
        <h2 className="approval-title">{item.title}</h2>
        <StatusTag tone={kind.tone}>{kind.label}</StatusTag>
      </header>
      <KeyValue
        items={[
          { label: 'From', value: item.moduleId ?? 'OpenClerq' },
          { label: 'Arrived', value: <When at={item.createdAt} /> },
          { label: 'Due', value: item.dueAt ? <When at={item.dueAt} /> : '' },
          {
            label: 'About',
            value: item.ref ? (
              item.ref.startsWith('core:') ? (
                <Link className="page-link" to={`/records/${encodeURIComponent(refId(item.ref))}`}>
                  {item.ref}
                </Link>
              ) : (
                <code>{item.ref}</code>
              )
            ) : (
              ''
            ),
          },
        ]}
      />
      {item.body && <p className="approval-reason inbox-body">{item.body}</p>}
      {view && item.moduleId && (
        <ModuleFrame
          moduleId={item.moduleId}
          path={fillRef(view.path ?? '/', item.ref)
            .split('{id}')
            .join(encodeURIComponent(item.id))}
          title={item.title}
          layout="fit"
        />
      )}
      {(item.kind === 'reply' || item.kind === 'task') && (
        <Textarea
          label={item.kind === 'reply' ? 'Your reply' : 'Note'}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
              e.preventDefault();
              void respond();
            }
          }}
        />
      )}
      <div className="approval-actions">
        {item.link && item.moduleId && (
          <Link className="page-link approval-open" to={moduleRoute(item.moduleId, item.link)}>
            <Icon glyph={ExternalLink} size={14} /> Open in {item.moduleId}
          </Link>
        )}
        <Button
          variant="ghost"
          icon={X}
          onClick={() => onClose(item, 'dismissed')}
          aria-keyshortcuts="D"
        >
          Dismiss
        </Button>
        {(item.kind === 'reply' || item.kind === 'task') && (
          <Button icon={Send} busy={busy} disabled={!text.trim()} onClick={respond}>
            {item.kind === 'reply' ? 'Send reply' : 'Send'}
          </Button>
        )}
        <Button
          variant="primary"
          icon={Check}
          onClick={() => onClose(item, 'done')}
          aria-keyshortcuts="A"
        >
          Mark done
        </Button>
      </div>
    </div>
  );
}

export function Inbox({ id }: { id: string | null }) {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const inbox = useInbox();
  const approvals = useApprovals();
  const list = useMemo(() => inbox.data ?? [], [inbox.data]);
  const selected = list.find((x) => x.id === id) ?? list[0];
  const approvalOf = (item: InboxItem | undefined) => {
    const n = item ? approvalId(item) : null;
    return n === null ? undefined : approvals.data?.find((a) => a.id === n);
  };

  const select = useCallback((x: InboxItem | undefined) => {
    if (x) navigate(`/inbox/${encodeURIComponent(x.id)}`, { replace: true });
  }, []);

  /** Take an item out of the list at once, and move to the next one. */
  const remove = useCallback(
    (item: InboxItem) => {
      const index = list.findIndex((x) => x.id === item.id);
      const next = list[index + 1] ?? list[index - 1];
      live.write<InboxItem[]>('inbox', (cur) => (cur ?? []).filter((x) => x.id !== item.id));
      if (next) select(next);
    },
    [list, live, select]
  );

  const decide = useCallback(
    async (a: Approval, decision: 'approve' | 'deny') => {
      const item = list.find((x) => approvalId(x) === a.id);
      if (item) remove(item);
      try {
        await client.decideApproval(a.id, decision);
        toast({
          message:
            decision === 'approve'
              ? `Approved ${actionLabel(a.tool)}.`
              : `Denied ${actionLabel(a.tool)}.`,
          tone: 'ok',
        });
      } catch (e) {
        toast({ message: `Couldn’t record the decision. ${errorMessage(e)}`, tone: 'err' });
      } finally {
        live.invalidate(['inbox', 'approvals']);
      }
    },
    [list, remove, client, toast, live]
  );

  const close = useCallback(
    async (item: InboxItem, status: 'done' | 'dismissed') => {
      remove(item);
      try {
        await client.setInboxStatus(item.id, status);
      } catch (e) {
        toast({ message: `Couldn’t update the item. ${errorMessage(e)}`, tone: 'err' });
      } finally {
        live.invalidate(['inbox']);
      }
    },
    [remove, client, toast, live]
  );

  // Keys act only on the item the address opens, once its run has loaded.
  const opened = id ? list.find((x) => x.id === id) : undefined;
  const openedApproval = approvalOf(opened);
  const openedRun = useRun(openedApproval?.runId ?? null);
  const lastDecisionAt = useRef(0);
  const armed = useRef<{ id: number; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, dialog[open], [role="menu"], iframe')) return;
      const now = Date.now();
      const act = keyAction({
        key: e.key,
        repeat: e.repeat,
        now,
        lastDecisionAt: lastDecisionAt.current,
        opened,
        approval: openedApproval,
        runLoaded: Boolean(openedRun.data),
        armed: armed.current,
      });
      const i = selected ? list.indexOf(selected) : -1;
      if (act.kind === 'none') {
        // Swallow held or early A and D so the page does not react to them either.
        if (
          /^[ad]$/i.test(e.key) &&
          (e.repeat || now - lastDecisionAt.current < DECISION_COOLDOWN_MS)
        )
          e.preventDefault();
        return;
      }
      if (act.kind === 'move') {
        select(list[Math.max(0, Math.min(list.length - 1, i + act.by))]);
      } else if (act.kind === 'arm') {
        armed.current = { id: act.approval.id, at: now };
        toast({
          message: `High risk. Press A again to approve ${actionLabel(act.approval.tool)}.`,
          tone: 'neutral',
        });
      } else {
        lastDecisionAt.current = now;
        armed.current = null;
        if ('approval' in act)
          void decide(act.approval, act.kind === 'approve' ? 'approve' : 'deny');
        else void close(act.item, act.kind);
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const approval = approvalOf(selected);
  // On a phone the list and the item are separate pages: an id in the address opens the item.
  const phone = useMedia(PHONE_QUERY);
  const showList = !phone || !id;
  const showItem = !phone || Boolean(id);

  return (
    <Page>
      <PageHeader
        crumbs={
          phone && id && selected
            ? [{ label: 'Inbox', to: '/inbox' }, { label: selected.title }]
            : [{ label: 'Inbox' }]
        }
      />
      <Loaded resource={inbox} what="the inbox" skeleton="rows">
        {() =>
          list.length === 0 ? (
            <EmptyState icon={InboxIcon} title="Nothing is waiting for you">
              Approvals, replies and tasks from every module arrive here.
            </EmptyState>
          ) : (
            <div className="approvals">
              {showList && (
                <ul className="approvals-list" aria-label="Waiting for you">
                  {list.map((x) => {
                    const kind = KIND[x.kind];
                    const asked = approvalOf(x);
                    return (
                      <li key={x.id} className={cx('approvals-row', x === selected && 'is-active')}>
                        <button
                          type="button"
                          className="approvals-item"
                          aria-current={x === selected ? 'true' : undefined}
                          onClick={() =>
                            phone ? navigate(`/inbox/${encodeURIComponent(x.id)}`) : select(x)
                          }
                        >
                          <span className="approvals-item-head">
                            <span className="approvals-item-title">{x.title}</span>
                            <When at={x.createdAt} />
                          </span>
                          {x.body && <span className="approvals-item-reason">{x.body}</span>}
                          <span className="inbox-item-meta">
                            <StatusTag tone={kind.tone}>{kind.label}</StatusTag>
                            {x.moduleId && <span className="page-muted">{x.moduleId}</span>}
                          </span>
                        </button>
                        {asked && <ApprovalOrigin approval={asked} />}
                      </li>
                    );
                  })}
                </ul>
              )}
              {showItem &&
                selected &&
                (approvalId(selected) !== null ? (
                  approval ? (
                    <ApprovalDetail
                      key={selected.id}
                      approval={approval}
                      onDecide={decide}
                      busy={false}
                    />
                  ) : (
                    <div className="approval-detail">
                      <PageSkeleton kind="text" label="Loading the approval" />
                    </div>
                  )
                ) : (
                  <ItemDetail key={selected.id} item={selected} onClose={close} />
                ))}
              <p className="page-hint approvals-keys">
                <kbd>J</kbd> <kbd>K</kbd> move · <kbd>A</kbd> approve or mark done · <kbd>D</kbd>{' '}
                deny or dismiss
              </p>
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}
