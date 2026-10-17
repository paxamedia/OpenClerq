/**
 * Automations — scheduled agent runs that end in a draft pull request.
 *
 * A first-party module over the same slot contract the chat console uses.
 * Three panels over the gateway's automation, run and approval endpoints:
 *   Automations  the specs, a YAML editor that checks a spec before saving
 *                it, and run-now / enable / disable
 *   Runs         what each run did, step by step, with its diff
 *   Approvals    pushes waiting for a decision
 */

import { useCallback, useEffect, useState } from 'react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import {
  gateway,
  GatewayError,
  type Approval,
  type AutomationPreview,
  type AutomationSummary,
  type RunDetail,
  type RunStep,
  type RunSummary,
} from '@clerq/gateway-client';

type Panel = 'automations' | 'runs' | 'approvals';

const TEMPLATE = `name: weekly-dependency-bumps
description: Patch and minor dependency updates, as a draft PR
on:
  schedule: '0 8 * * 1'   # Mondays 08:00, this computer's time zone
targets:
  repos: [local:~/code/my-app]
agent:
  driver: claude-code
  allowed_tools: ['Bash(pnpm install:*)', 'Bash(pnpm test:*)']
prompt: |
  Update dependencies with patch and minor releases only.
  Update the lockfile. Do not change source files.
sandbox:
  profile: native   # no isolation yet: the agent and gates run with your access
  timeout: 20m
gates:
  - run: pnpm install --frozen-lockfile
  - run: pnpm test
publish:
  pull_request: draft
budget:
  max_usd_per_run: 2
  max_usd_per_month: 20
approvals:
  push: manual
`;

const FINISHED = ['done', 'failed', 'cancelled'];

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function describeError(e: unknown): string {
  if (e instanceof GatewayError && e.body && typeof e.body.message === 'string') {
    return e.body.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** One line saying what a step was. */
function stepLabel(step: RunStep): string {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const output = (step.output ?? {}) as Record<string, unknown>;
  switch (step.kind) {
    case 'gate':
      return `Gate: ${String(input.run ?? '')}`;
    case 'git':
      return `git ${String(input.action ?? '')}${output.branch ? ` → ${String(output.branch)}` : ''}`;
    case 'tool':
      return `Tool: ${String(input.name ?? '')}`;
    case 'llm':
      return step.status === 'text' ? String(output.text ?? '') : 'Agent finished';
    default:
      return step.kind;
  }
}

function StepRow({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false);
  const detail = step.kind === 'llm' && step.status === 'text' ? null : (step.output ?? step.input);
  return (
    <li className={`aut-step aut-step--${step.status ?? 'none'}`}>
      <div className="aut-step-head">
        <span className="aut-step-kind">{step.kind}</span>
        <span className="aut-step-label">{stepLabel(step)}</span>
        <span className="chat-meta">
          {[step.status, step.durationMs !== undefined ? `${step.durationMs} ms` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {detail ? (
          <button type="button" className="btn btn-small" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Details'}
          </button>
        ) : null}
      </div>
      {open && detail ? <pre className="chat-json">{JSON.stringify(detail, null, 2)}</pre> : null}
    </li>
  );
}

function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [artifact, setArtifact] = useState<{ name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRun(await gateway.run(runId));
    } catch (e) {
      setError(describeError(e));
    }
  }, [runId]);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!run || !FINISHED.includes(run.status)) load();
    }, 2000);
    return () => clearInterval(t);
  }, [load, run]);

  if (!run) return <p className="chat-empty">{error ?? 'Loading…'}</p>;
  return (
    <div className="aut-run">
      <div className="aut-run-head">
        <button type="button" className="btn btn-small" onClick={onClose}>
          ← Runs
        </button>
        <strong>{run.automationName ?? run.trigger}</strong>
        <span className={`aut-status aut-status--${run.status}`}>{run.status}</span>
        {!FINISHED.includes(run.status) && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => gateway.cancelRun(run.id).then(load, (e) => setError(describeError(e)))}
          >
            Cancel
          </button>
        )}
      </div>
      {error && <p className="chat-error">{error}</p>}
      <dl className="aut-facts">
        <dt>Started</dt>
        <dd>{when(run.startedAt)}</dd>
        <dt>Outcome</dt>
        <dd>{run.exitReason ?? '—'}</dd>
        <dt>Branch</dt>
        <dd>{run.branch ?? '—'}</dd>
        <dt>Pull request</dt>
        <dd>
          {run.prUrl ? (
            <button type="button" className="link-button" onClick={() => openUrl(run.prUrl!)}>
              {run.prUrl}
            </button>
          ) : (
            '—'
          )}
        </dd>
        <dt>Cost</dt>
        <dd>
          {money(run.costUsd)}
          {run.costKnown ? '' : ' (at least)'} · {run.tokensIn} in / {run.tokensOut} out
        </dd>
      </dl>
      {run.artifacts.length > 0 && (
        <div className="row">
          {run.artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              className="btn btn-small"
              onClick={async () => {
                const full = await gateway.artifact(run.id, a.id);
                setArtifact({ name: a.name ?? a.kind, content: full.content });
              }}
            >
              {a.kind === 'diff' ? 'Show diff' : `Show ${a.name ?? a.kind}`}
            </button>
          ))}
        </div>
      )}
      {artifact && (
        <div>
          <div className="aut-run-head">
            <strong>{artifact.name}</strong>
            <button type="button" className="btn btn-small" onClick={() => setArtifact(null)}>
              Hide
            </button>
          </div>
          <pre className="chat-json aut-diff">{artifact.content}</pre>
        </div>
      )}
      <ol className="aut-steps">
        {run.steps.map((s) => (
          <StepRow key={s.seq} step={s} />
        ))}
      </ol>
    </div>
  );
}

function Editor({
  editing,
  onSaved,
  onCancel,
}: {
  editing: { id: string; source: string } | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [source, setSource] = useState(editing?.source ?? TEMPLATE);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await gateway.previewAutomation(source, editing?.id));
    } catch (e) {
      setPreview(null);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await gateway.updateAutomation(editing.id, source);
      else await gateway.createAutomation(source);
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aut-editor">
      <p className="section-desc">
        Saved automations start disabled; switch one on when its check passes. The format is in
        docs/ROADMAP.md §4.
      </p>
      <textarea
        className="aut-yaml"
        value={source}
        onChange={(e) => {
          setSource(e.target.value);
          setPreview(null);
        }}
        rows={22}
        spellCheck={false}
      />
      {error && <p className="chat-error">{error}</p>}
      {preview && (
        <ul className="aut-checks">
          {preview.checks.map((c, i) => (
            <li key={i} className={`aut-check aut-check--${c.level}`}>
              {c.message}
            </li>
          ))}
          {preview.nextRunAt && (
            <li className="aut-check aut-check--ok">Next run: {when(preview.nextRunAt)}</li>
          )}
        </ul>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={check}>
          Check
        </button>
        <button type="button" className="btn" disabled={busy} onClick={save}>
          {editing ? 'Save changes' : 'Save (disabled)'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function Automations({
  moduleDisplayName,
  onBack,
  onAbout,
  themeToggle,
}: {
  moduleDisplayName: string;
  onBack: () => void;
  onAbout: () => void;
  themeToggle: React.ReactNode;
}) {
  const [panel, setPanel] = useState<Panel>('automations');
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [editing, setEditing] = useState<{ id: string; source: string } | null | 'new'>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A failed refresh, kept apart from action errors so the next good one clears it. */
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, r, p] = await Promise.all([
        gateway.automations(),
        gateway.runs(50),
        gateway.approvals(),
      ]);
      setAutomations(a.automations);
      setRuns(r.runs.filter((run) => run.automationId));
      setApprovals(p.approvals);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not reach the gateway: ${describeError(e)}`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    }
    refresh();
  };

  return (
    <div className="app">
      <div className="view-header">
        <button type="button" className="btn btn-small" onClick={onBack}>
          ← Back
        </button>
        <h1 className="view-title">{moduleDisplayName}</h1>
        <div className="view-header-actions">
          {themeToggle}
          <button type="button" className="btn btn-small" onClick={onAbout}>
            About
          </button>
        </div>
      </div>

      <div className="row aut-tabs" role="tablist">
        {(['automations', 'runs', 'approvals'] as Panel[]).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={panel === p}
            className={`btn btn-small${panel === p ? '' : ' btn-ghost'}`}
            onClick={() => {
              setPanel(p);
              setOpenRun(null);
            }}
          >
            {p === 'automations'
              ? 'Automations'
              : p === 'runs'
                ? 'Runs'
                : `Approvals (${approvals.length})`}
          </button>
        ))}
      </div>
      {loadError && <p className="chat-error">{loadError}</p>}
      {error && <p className="chat-error">{error}</p>}

      {panel === 'automations' &&
        (editing ? (
          <Editor
            editing={editing === 'new' ? null : editing}
            onSaved={() => {
              setEditing(null);
              refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="aut-list">
            <div className="row">
              <button type="button" className="btn" onClick={() => setEditing('new')}>
                New automation
              </button>
            </div>
            {automations.length === 0 && (
              <p className="chat-empty">
                No automations yet. An automation runs a coding agent on a schedule in its own
                worktree, checks the result with your gates, and opens a draft pull request.
              </p>
            )}
            {automations.map((a) => (
              <article key={a.id} className="aut-card">
                <div className="aut-card-head">
                  <strong>{a.name}</strong>
                  <span className={`aut-status aut-status--${a.enabled ? 'enabled' : 'disabled'}`}>
                    {a.running ? 'running' : a.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                {a.description && <p className="section-desc">{a.description}</p>}
                {a.problem && <p className="chat-error">{a.problem}</p>}
                <div className="chat-meta">
                  {[
                    a.repo,
                    a.problem ? null : a.schedule ? `schedule ${a.schedule}` : 'on demand',
                    a.enabled && a.nextRunAt ? `next ${when(a.nextRunAt)}` : null,
                    `${money(a.monthSpendUsd)} this month`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {a.lastRun && (
                  <div className="chat-meta">
                    Last run {when(a.lastRun.createdAt)}: {a.lastRun.status}
                    {a.lastRun.exitReason ? ` — ${a.lastRun.exitReason}` : ''}
                  </div>
                )}
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={a.running}
                    onClick={() =>
                      act(async () => {
                        const { runId } = await gateway.runAutomation(a.id);
                        setPanel('runs');
                        setOpenRun(runId);
                      })
                    }
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => act(() => gateway.setAutomationEnabled(a.id, !a.enabled))}
                  >
                    {a.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() =>
                      act(async () => {
                        const full = await gateway.automation(a.id);
                        setEditing({ id: a.id, source: full.source });
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    onClick={() => {
                      if (window.confirm(`Delete "${a.name}"? Its run history is kept.`)) {
                        act(() => gateway.deleteAutomation(a.id));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        ))}

      {panel === 'runs' &&
        (openRun ? (
          <RunView runId={openRun} onClose={() => setOpenRun(null)} />
        ) : (
          <ul className="aut-runs">
            {runs.length === 0 && <li className="chat-empty">No automation runs yet.</li>}
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className="aut-run-row" onClick={() => setOpenRun(r.id)}>
                  <span className={`aut-status aut-status--${r.status}`}>{r.status}</span>
                  <strong>{r.automationName ?? r.automationId}</strong>
                  <span className="chat-meta">
                    {when(r.createdAt)} · {r.trigger} · {money(r.costUsd)}
                    {r.exitReason ? ` · ${r.exitReason}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {panel === 'approvals' && (
        <ul className="aut-runs">
          {approvals.length === 0 && <li className="chat-empty">Nothing is waiting for you.</li>}
          {approvals.map((p) => (
            <li key={p.id} className="aut-card">
              <div className="aut-card-head">
                <strong>{p.tool}</strong>
                <span className={`aut-status aut-status--${p.tier}`}>{p.tier} risk</span>
              </div>
              <p className="chat-text">{p.reason}</p>
              <div className="chat-meta">Requested {when(p.requestedAt)}</div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => act(() => gateway.decideApproval(p.id, 'approve'))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => act(() => gateway.decideApproval(p.id, 'deny'))}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    setPanel('runs');
                    setOpenRun(p.runId);
                  }}
                >
                  View run
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default Automations;
