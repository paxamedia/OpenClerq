/**
 * Managed mode in the chat: the agent's tool activity and approvals as they
 * happen, drafted automations (preview, dry run, save; saved ones start off),
 * the folder a conversation works in, and what managed adds over raw.
 */

import { useEffect, useState } from 'react';
import { Check, FileCode, FlaskConical, FolderOpen, Save, X } from 'lucide-react';
import type {
  Approval,
  ChatDraft,
  ChatPermissionMode,
  ChatSession,
  DraftDryRun,
  ModeDiff,
} from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { CodeBlock, KeyValue, ProgressLine } from '../../ui/Display';
import { Input, Select } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { StatusTag, type Tone } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient } from '../../app/client';
import { describeCron } from '../../app/cron';
import { errorMessage, exactTime, money } from '../../app/format';
import { When } from '../common';

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
  };
  return labels[name] ?? name;
}

const TOOL_TONES: Record<string, { tone: Tone; label: string }> = {
  running: { tone: 'accent', label: 'Working' },
  ok: { tone: 'ok', label: 'Done' },
  error: { tone: 'err', label: 'Failed' },
  denied: { tone: 'warn', label: 'Refused' },
};

export interface LiveTool {
  id: string;
  name: string;
  status: 'running' | 'ok' | 'error' | 'denied';
}

export interface LiveApproval {
  approval: Approval & { input?: unknown };
  decided?: boolean;
  approved?: boolean;
}

/** What the agent is doing while a managed message runs. */
export function LiveActivity({
  tools,
  approvals,
  onDecided,
}: {
  tools: LiveTool[];
  approvals: LiveApproval[];
  onDecided: (id: number, approved: boolean) => void;
}) {
  if (tools.length === 0 && approvals.length === 0) return null;
  return (
    <div className="chat-activity">
      {tools.length > 0 && (
        <ul className="chat-tools" aria-label="Tool calls">
          {tools.map((t) => (
            <li key={t.id} className="chat-tool">
              <StatusTag tone={TOOL_TONES[t.status].tone}>{TOOL_TONES[t.status].label}</StatusTag>
              <span>{toolLabel(t.name)}</span>
            </li>
          ))}
        </ul>
      )}
      {approvals.map((a) => (
        <ApprovalCard key={a.approval.id} item={a} onDecided={onDecided} />
      ))}
    </div>
  );
}

function ApprovalCard({
  item,
  onDecided,
}: {
  item: LiveApproval;
  onDecided: (id: number, approved: boolean) => void;
}) {
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const { approval } = item;
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    try {
      await client.decideApproval(approval.id, decision);
      onDecided(approval.id, decision === 'approve');
    } catch (e) {
      toast({ message: `Couldn’t answer. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="chat-approval" aria-label={`Approval: ${toolLabel(approval.tool)}`}>
      <header className="chat-card-head">
        <StatusTag tone={item.decided ? (item.approved ? 'ok' : 'muted') : 'warn'}>
          {item.decided ? (item.approved ? 'Approved' : 'Refused') : 'Needs approval'}
        </StatusTag>
        <strong>{toolLabel(approval.tool)}</strong>
      </header>
      <p className="chat-card-text">{approval.reason}</p>
      {approval.input !== undefined && (
        <CodeBlock code={JSON.stringify(approval.input, null, 2)} maxHeight="sm" wrap />
      )}
      {!item.decided && (
        <div className="chat-card-actions">
          <Button
            variant="primary"
            size="sm"
            icon={Check}
            busy={busy === 'approve'}
            disabled={busy !== null}
            onClick={() => decide('approve')}
          >
            Approve
          </Button>
          <Button
            size="sm"
            icon={X}
            busy={busy === 'deny'}
            disabled={busy !== null}
            onClick={() => decide('deny')}
          >
            Deny
          </Button>
        </div>
      )}
    </section>
  );
}

const CHECK_TONES: Record<string, Tone> = { ok: 'ok', warning: 'warn', error: 'err' };

/** An automation the model drafted: preview, dry run, save. Saving never switches it on. */
export function DraftCard({ sessionId, draftId }: { sessionId: string; draftId: string }) {
  const client = useClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [dry, setDry] = useState<DraftDryRun | null>(null);
  const [busy, setBusy] = useState<'dry' | 'save' | null>(null);

  useEffect(() => {
    let live = true;
    client
      .draft(sessionId, draftId)
      .then((d) => live && setDraft(d))
      .catch((e: unknown) => live && setFailed(e));
    return () => {
      live = false;
    };
  }, [client, sessionId, draftId]);

  if (failed)
    return <p className="tone-text-err">Couldn’t load the draft. {errorMessage(failed)}</p>;
  if (!draft) return <ProgressLine label="Loading the draft" />;
  const s = draft.summary;

  const dryRun = async () => {
    setBusy('dry');
    try {
      setDry(await client.dryRunDraft(sessionId, draftId));
      // Saving is open once this YAML has been dry-run.
      setDraft({ ...draft, dryRunAt: new Date().toISOString() });
    } catch (e) {
      toast({ message: `Couldn’t check the draft. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    try {
      const saved = await client.saveDraft(sessionId, draftId);
      setDraft({ ...draft, automationId: saved.id, savedAt: new Date().toISOString() });
      toast({ message: `Saved ${saved.name}. It is off until you turn it on.`, tone: 'ok' });
    } catch (e) {
      toast({ message: `Couldn’t save. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="chat-draft" aria-label={`Draft automation ${draft.name}`}>
      <DraftFacts draft={draft} />
      {dry && <DryRunResult result={dry} />}
      <div className="chat-card-actions">
        <Button size="sm" icon={FileCode} onClick={() => setShowYaml(true)}>
          Preview YAML
        </Button>
        <Button
          size="sm"
          icon={FlaskConical}
          busy={busy === 'dry'}
          disabled={busy !== null || !s}
          onClick={dryRun}
        >
          Dry run
        </Button>
        {draft.automationId ? (
          <a
            className="page-link"
            href={`#/m/automations/${encodeURIComponent(draft.automationId)}`}
          >
            Open in Automations
          </a>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={Save}
            busy={busy === 'save'}
            disabled={busy !== null || !s || !draft.dryRunAt}
            title={draft.dryRunAt ? undefined : 'Dry-run it first.'}
            onClick={save}
          >
            Save
          </Button>
        )}
      </div>
      {!draft.automationId && !draft.dryRunAt && (
        <p className="page-hint">Dry-run it before you save it.</p>
      )}
      <Dialog
        open={showYaml}
        onClose={() => setShowYaml(false)}
        title={draft.name}
        size="lg"
        actions={<Button onClick={() => setShowYaml(false)}>Close</Button>}
      >
        <CodeBlock code={draft.source} maxHeight="lg" />
      </Dialog>
    </section>
  );
}

/** What a draft would do, in words, and the promise that saving does not arm it. */
export function DraftFacts({ draft }: { draft: ChatDraft }) {
  const s = draft.summary;
  return (
    <>
      <header className="chat-card-head">
        <StatusTag tone={draft.automationId ? 'ok' : 'muted'}>
          {draft.automationId ? 'Saved, off' : 'Draft'}
        </StatusTag>
        <strong className="page-mono">{draft.name}</strong>
      </header>
      {s ? (
        <KeyValue
          columns={2}
          items={[
            {
              label: 'Schedule',
              value: s.schedule ? describeCron(s.schedule) : 'Only when started by hand',
            },
            { label: 'Next run', value: s.nextRunAt ? <When at={s.nextRunAt} /> : '' },
            { label: 'Repository', value: s.repo, mono: true },
            { label: 'Agent', value: s.model ? `${s.driver} · ${s.model}` : s.driver },
            {
              label: 'Publishes',
              value: s.push
                ? s.pullRequest === 'draft'
                  ? 'Pushes and opens a draft pull request'
                  : 'Pushes a branch'
                : 'Nothing',
            },
            {
              label: 'Budget',
              value:
                s.maxUsdPerRun !== null || s.maxUsdPerMonth !== null
                  ? [
                      s.maxUsdPerRun !== null ? `${money(s.maxUsdPerRun)} a run` : null,
                      s.maxUsdPerMonth !== null ? `${money(s.maxUsdPerMonth)} a month` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : '',
            },
            {
              label: 'Push',
              value: s.push
                ? s.pushApproval === 'auto'
                  ? 'Without asking, after the first'
                  : 'Waits for your approval'
                : 'Never',
            },
            {
              label: 'Isolation',
              value:
                s.sandbox.profile === 'native'
                  ? 'None: your account’s access'
                  : `${s.sandbox.profile}, network ${
                      s.sandbox.network === 'all'
                        ? 'unlimited'
                        : s.sandbox.network?.length
                          ? s.sandbox.network.join(', ')
                          : 'off'
                    }`,
            },
            {
              label: 'Access',
              value: [
                s.permissionMode,
                s.allowedTools.length ? `tools ${s.allowedTools.join(', ')}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
              mono: true,
            },
            {
              label: 'Reads notes',
              value: s.memoryRead.length
                ? `${s.memoryRead.join(', ')}${s.memoryIncludeAgent ? ', with notes an agent wrote' : ''}`
                : 'None',
            },
          ]}
        />
      ) : (
        <p className="tone-text-err">{draft.problem}</p>
      )}
      {s && (
        <>
          <CodeBlock title="Prompt" code={s.prompt} maxHeight="sm" wrap copy={false} />
          <CodeBlock
            title="Gates"
            code={s.gates.length ? s.gates.join('\n') : 'None'}
            maxHeight="sm"
            copy={false}
          />
          {s.warnings.length > 0 && (
            <ul className="chat-checks" aria-label="Look at these before saving">
              {s.warnings.map((w) => (
                <li key={w}>
                  <StatusTag tone="warn">Check</StatusTag>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="page-hint">
        A saved automation starts off, and its first push waits for your approval.
      </p>
    </>
  );
}

export function DryRunResult({ result }: { result: DraftDryRun }) {
  const e = result.estimate;
  const estimate =
    e.perRunUsd === null
      ? e.note
      : `${money(e.perRunUsd)} a run${e.perMonthUsd !== null ? `, about ${money(e.perMonthUsd)} a month` : ''}. ${e.note}`;
  return (
    <div className="chat-dry-run" aria-label="Dry run">
      <p className="page-hint">Checked without running anything.</p>
      <ul className="chat-checks">
        {result.checks.map((c, i) => (
          <li key={i}>
            <StatusTag tone={CHECK_TONES[c.level] ?? 'muted'}>
              {c.level === 'ok' ? 'OK' : c.level === 'warning' ? 'Warning' : 'Problem'}
            </StatusTag>
            <span>{c.message}</span>
          </li>
        ))}
      </ul>
      <KeyValue
        items={[
          {
            label: `Next runs (${result.timeZone})`,
            value: result.nextFirings.length
              ? result.nextFirings.slice(0, 5).map(exactTime).join(' · ')
              : 'Only when started by hand',
          },
          { label: 'Cost', value: estimate },
        ]}
      />
    </div>
  );
}

const PERMISSION_LABELS: Record<ChatPermissionMode, string> = {
  acceptEdits: 'Full access',
  default: 'Ask before changes',
  plan: 'Read only',
  sandboxed: 'Sandboxed',
};

const PERMISSION_HINTS: Record<ChatPermissionMode, string> = {
  acceptEdits:
    'The agent can do anything your account can, including drive OpenClerq itself. A push it recognises waits for you.',
  default:
    'Writes and commands wait for your approval. A command you approve has your account’s access.',
  plan: 'The agent only reads the folder.',
  sandboxed:
    'Commands and file tools run sandboxed: writes only in this folder, no network, your credentials unreadable.',
};

/** Attach a folder to a managed conversation, or detach it. */
export function FolderDialog({
  open,
  session,
  onClose,
  onSaved,
}: {
  open: boolean;
  session: ChatSession;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useClient();
  const [path, setPath] = useState(session.workspace ?? '');
  const [mode, setMode] = useState<ChatPermissionMode>(session.permissionMode ?? 'acceptEdits');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPath(session.workspace ?? '');
      setMode(session.permissionMode ?? 'acceptEdits');
      setError(null);
    }
  }, [open, session.workspace, session.permissionMode]);

  const save = async (workspace: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await client.updateSession(session.id, { workspace, permissionMode: mode });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Folder"
      description="The agent reads, edits and runs commands in this folder, with a home directory of its own. Without a folder it has no file or command tools. OpenClerq's own data folder cannot be attached."
      size="md"
      actions={
        <>
          {session.workspace && (
            <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
              Detach
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={FolderOpen}
            busy={busy}
            disabled={!path.trim()}
            onClick={() => save(path.trim())}
          >
            Attach
          </Button>
        </>
      }
    >
      <div className="chat-folder-form">
        <Input
          label="Folder path"
          mono
          value={path}
          placeholder="~/code/app"
          onChange={(e) => setPath(e.target.value)}
          error={error ?? undefined}
        />
        <Select
          label="Access"
          value={mode}
          onChange={(e) => setMode(e.target.value as ChatPermissionMode)}
          hint={PERMISSION_HINTS[mode]}
        >
          {(Object.keys(PERMISSION_LABELS) as ChatPermissionMode[])
            .filter((m) => m !== 'sandboxed' || session.sandboxAvailable || mode === 'sandboxed')
            .map((m) => (
              <option key={m} value={m}>
                {PERMISSION_LABELS[m]}
              </option>
            ))}
        </Select>
      </div>
    </Dialog>
  );
}

export function permissionLabel(mode: ChatPermissionMode | undefined): string {
  return PERMISSION_LABELS[mode ?? 'acceptEdits'];
}

/** What managed adds to a message over raw, as it would be sent now. */
export function ModeDiffView({ sessionId, text }: { sessionId: string; text: string }) {
  const client = useClient();
  const [diff, setDiff] = useState<ModeDiff | null>(null);
  const [failed, setFailed] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setFailed(null);
    client
      .modeDiff(sessionId, { text })
      .then((d) => live && setDiff(d))
      .catch((e: unknown) => live && setFailed(e));
    return () => {
      live = false;
    };
  }, [client, sessionId, text]);

  if (failed) return <p className="tone-text-err">Couldn’t compare. {errorMessage(failed)}</p>;
  if (!diff) return <ProgressLine label="Comparing raw and managed" />;
  return <ModeDiffBody diff={diff} />;
}

/** The comparison itself: every line of the system prompt is an addition. */
export function ModeDiffBody({ diff }: { diff: ModeDiff }) {
  const m = diff.managed;
  const added = m.system
    .split('\n')
    .map((line) => `+ ${line}`)
    .join('\n');
  return (
    <section className="chat-mode-diff" aria-label="What managed adds">
      <h3 className="chat-section-title">What managed adds</h3>
      <p className="page-hint">
        As it would be sent now. Raw sends the same messages with nothing added.
      </p>
      <KeyValue
        items={[
          {
            label: 'Model',
            value: m.chosen
              ? `${m.model}, as chosen`
              : m.fallbackModels.length
                ? `${m.model}, then ${m.fallbackModels.join(', then ')} if it is unavailable`
                : m.model,
            mono: true,
          },
          { label: 'Skill', value: m.skill?.name ?? m.skill?.slug ?? 'None' },
          {
            label: 'Saved notes',
            value: m.memory ? `${m.memory.count} added to the prompt` : 'None',
          },
          {
            label: 'Folder',
            value: m.workspace
              ? `${m.workspace} · ${permissionLabel(m.permissionMode)}`
              : 'None, so no file or command tools',
          },
        ]}
      />
      <ul className="chat-checks" aria-label="Tools offered">
        {m.tools.map((t) => (
          <li key={t.name}>
            <StatusTag tone={t.decision === 'allow' ? 'ok' : 'warn'}>
              {t.decision === 'allow' ? 'Allowed' : 'Asks first'}
            </StatusTag>
            <span>{toolLabel(t.name)}</span>
            <span className="page-mono chat-tool-name">{t.modelName}</span>
          </li>
        ))}
      </ul>
      <CodeBlock title="System prompt (raw sends none)" code={added} maxHeight="lg" wrap />
    </section>
  );
}
