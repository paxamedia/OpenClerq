/**
 * The automation editor: YAML on the left with line numbers and errors on
 * their line; on the right a check that runs as you type, what the spec will
 * do, the next five runs, and a schedule picker that writes the cron line.
 */

import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { Check, CircleAlert, Save, TriangleAlert } from 'lucide-react';
import type { AutomationPreview } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Popover } from '../../ui/Popover';
import { ProgressLine } from '../../ui/Display';
import { useToast } from '../../ui/Toast';
import { cx } from '../../ui/cx';
import { useClient } from '../../app/client';
import { cronFromSimple, describeCron, nextFirings, simpleSchedule } from '../../app/cron';
import { errorMessage, exactTime, relativeTime } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import { navigate } from '../../app/router';
import { ErrorState, Page, PageHeader, PageSkeleton, Section } from '../../shell/layout';
import { lineOf, scheduleOf, summarize, TEMPLATE, withSchedule } from './spec';

const DAYS = [
  { d: 1, label: 'Mon' },
  { d: 2, label: 'Tue' },
  { d: 3, label: 'Wed' },
  { d: 4, label: 'Thu' },
  { d: 5, label: 'Fri' },
  { d: 6, label: 'Sat' },
  { d: 0, label: 'Sun' },
];

function SchedulePicker({
  cron,
  onChange,
}: {
  cron: string | null;
  onChange: (cron: string) => void;
}) {
  const current = (cron && simpleSchedule(cron)) || { weekdays: [1], hour: 8, minute: 0 };
  const [days, setDays] = useState<number[]>(
    current.weekdays.length === 7 ? [0, 1, 2, 3, 4, 5, 6] : current.weekdays
  );
  const [time, setTime] = useState(
    `${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}`
  );
  const [h, m] = time.split(':').map(Number);
  const next = cronFromSimple({ weekdays: days, hour: h || 0, minute: m || 0 });
  return (
    <Popover
      label="Schedule"
      placement="bottom-end"
      trigger={(p) => (
        <Button size="sm" {...p}>
          Pick days and time
        </Button>
      )}
    >
      {(close) => (
        <div className="editor-picker">
          <fieldset className="editor-picker-days">
            <legend className="editor-picker-legend">Days</legend>
            {DAYS.map(({ d, label }) => (
              <Checkbox
                key={d}
                label={label}
                checked={days.includes(d)}
                onChange={(e) =>
                  setDays((prev) => (e.target.checked ? [...prev, d] : prev.filter((x) => x !== d)))
                }
              />
            ))}
          </fieldset>
          <Input label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <p className="page-hint">
            {days.length ? describeCron(next) : 'Choose at least one day.'}
          </p>
          <Button
            variant="primary"
            size="sm"
            disabled={!days.length}
            onClick={() => {
              onChange(next);
              close();
            }}
          >
            Use this schedule
          </Button>
        </div>
      )}
    </Popover>
  );
}

function YamlEditor({
  value,
  onChange,
  errorLines,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  errorLines: Map<number, string>;
  onSave: () => void;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
  };
  return (
    <div className="editor-yaml">
      <div ref={gutter} className="editor-gutter" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className={cx('editor-line-no', errorLines.has(i + 1) && 'is-error')}
            title={errorLines.get(i + 1)}
          >
            {i + 1}
          </span>
        ))}
      </div>
      <textarea
        className="editor-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          } else if (e.key === 'Tab' && !e.shiftKey) {
            // Two spaces, as YAML wants; Shift+Tab still leaves the field.
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = t;
            onChange(`${value.slice(0, a)}  ${value.slice(b)}`);
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Automation spec, in YAML"
        aria-keyshortcuts="Meta+Enter Control+Enter"
      />
    </div>
  );
}

function Checks({
  preview,
  checking,
  error,
}: {
  preview: AutomationPreview | null;
  checking: boolean;
  error: unknown;
}) {
  return (
    <Section title="Check">
      {checking && <ProgressLine label="Checking the spec" />}
      {error ? (
        <ul className="editor-checks">
          <li className="editor-check is-error">
            <Icon glyph={CircleAlert} />
            <span>{errorMessage(error)}</span>
          </li>
        </ul>
      ) : preview ? (
        <ul className="editor-checks" aria-live="polite">
          {preview.checks.map((c, i) => (
            <li key={i} className={cx('editor-check', `is-${c.level}`)}>
              <Icon
                glyph={
                  c.level === 'ok' ? Check : c.level === 'warning' ? TriangleAlert : CircleAlert
                }
              />
              <span>{c.message}</span>
            </li>
          ))}
          {preview.checks.length === 0 && (
            <li className="editor-check is-ok">
              <Icon glyph={Check} />
              <span>Ready to save.</span>
            </li>
          )}
        </ul>
      ) : (
        <p className="page-hint">Checking as you type.</p>
      )}
    </Section>
  );
}

function Summary({ source, preview }: { source: string; preview: AutomationPreview | null }) {
  const s = summarize(source);
  const schedule = s.schedule;
  const given = (preview as (AutomationPreview & { nextFirings?: string[] }) | null)?.nextFirings;
  const next = (
    given?.length ? given.map((x) => new Date(x)) : schedule ? nextFirings(schedule, 5) : []
  ).slice(0, 5);
  const lines = [
    schedule
      ? `Runs ${describeCron(schedule).replace(/^./, (c) => c.toLowerCase())}.`
      : 'Runs only when you start it.',
    s.repo ? `Works in a fresh worktree of ${s.repo}${s.driver ? ` with ${s.driver}` : ''}.` : null,
    s.gates.length
      ? `Checks the result with ${s.gates.length} ${s.gates.length === 1 ? 'gate' : 'gates'}: ${s.gates.join('; ')}.`
      : 'Has no gates, so nothing checks the result.',
    s.pullRequest === 'draft'
      ? 'Opens a draft pull request.'
      : s.pullRequest
        ? `Pull request: ${s.pullRequest}.`
        : null,
    s.push === 'manual'
      ? 'Asks you before it pushes.'
      : s.push
        ? `Push approval: ${s.push}.`
        : null,
    s.perRun || s.perMonth
      ? `Stops at $${s.perRun ?? '—'} a run and $${s.perMonth ?? '—'} a month.`
      : 'Has no budget cap.',
  ].filter(Boolean);
  return (
    <>
      <Section title="What it will do">
        <ul className="editor-summary">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
      <Section title="Next five runs">
        {next.length ? (
          <ol className="editor-next">
            {next.map((d) => (
              <li key={d.toISOString()}>
                <span>{exactTime(d)}</span>
                <span className="page-muted">{relativeTime(d)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="page-hint">No schedule.</p>
        )}
      </Section>
    </>
  );
}

export function AutomationEditor({ id, base }: { id: string | null; base: string }) {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const existing = useResource(id ? `automation:${id}` : null, () =>
    client.automation(id as string)
  );
  const [source, setSource] = useState<string | null>(id ? null : TEMPLATE);
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (source === null && existing.data) setSource(existing.data.source);
  }, [existing.data, source]);

  // The live check: shortly after typing stops.
  useEffect(() => {
    if (source === null) return;
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(() => {
      client
        .previewAutomation(source, id ?? undefined)
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setCheckError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setCheckError(e);
        })
        .finally(() => !cancelled && setChecking(false));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [source, client, id]);

  const errorLines = useMemo(() => {
    const map = new Map<number, string>();
    const messages = [
      ...(preview?.checks.filter((c) => c.level === 'error').map((c) => c.message) ?? []),
      ...(checkError ? [errorMessage(checkError)] : []),
    ];
    for (const m of messages) {
      const line = lineOf(m);
      if (line) map.set(line, m);
    }
    return map;
  }, [preview, checkError]);

  const save = async () => {
    if (source === null || saving) return;
    setSaving(true);
    try {
      const saved = id
        ? await client.updateAutomation(id, source)
        : await client.createAutomation(source);
      live.invalidate(['automations']);
      toast({
        message: id
          ? 'Saved.'
          : 'Saved. New automations start off; turn it on when its check passes.',
        tone: 'ok',
      });
      navigate(`${base}/${encodeURIComponent(saved.id)}`);
    } catch (e) {
      toast({ message: `Couldn’t save. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setSaving(false);
    }
  };

  const name = existing.data?.name ?? (source ? summarize(source).name : null);
  const crumbs = [
    { label: 'Automations', to: base },
    ...(id
      ? [{ label: name ?? id, to: `${base}/${encodeURIComponent(id)}` }, { label: 'Edit' }]
      : [{ label: 'New automation' }]),
  ];

  return (
    <Page className="editor-page">
      <PageHeader
        crumbs={crumbs}
        title={id ? `Edit ${name ?? id}` : 'New automation'}
        actions={
          <>
            <Button variant="ghost" onClick={() => window.history.back()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Save}
              busy={saving}
              onClick={save}
              aria-keyshortcuts="Meta+Enter"
            >
              Save
            </Button>
          </>
        }
      />
      {id && existing.error && !existing.data ? (
        <ErrorState error={existing.error} onRetry={existing.reload} what="this automation" />
      ) : source === null ? (
        <PageSkeleton />
      ) : (
        <div className="editor">
          <div className="editor-left">
            <div className="editor-toolbar">
              <span className="page-hint">
                {scheduleOf(source) ? describeCron(scheduleOf(source) as string) : 'No schedule'}
              </span>
              <SchedulePicker
                cron={scheduleOf(source)}
                onChange={(cron) => setSource(withSchedule(source, cron))}
              />
            </div>
            <YamlEditor value={source} onChange={setSource} errorLines={errorLines} onSave={save} />
            <p className="page-hint">
              New automations start off. Turn one on when its check passes. <kbd>⌘</kbd>
              <kbd>↵</kbd> saves.
            </p>
          </div>
          <div className="editor-right">
            <Checks preview={preview} checking={checking} error={checkError} />
            <Summary source={source} preview={preview} />
          </div>
        </div>
      )}
    </Page>
  );
}
