/**
 * Developer: try a tool, run the calculation engine, run a task with a preview
 * of what the model receives, follow the live log, and see the service's figures.
 */

import { useEffect, useRef, useState } from 'react';
import { Calculator as CalcIcon, Eye, Pause, Play, Send, Trash2 } from 'lucide-react';
import type { ContextPreview, EvalCalcResponse, TaskResponse } from '@clerq/gateway-client';
import { Button } from '../../ui/Button';
import { Checkbox, SegmentedControl } from '../../ui/Choice';
import { CodeBlock, KeyValue } from '../../ui/Display';
import { Input, Select, Textarea } from '../../ui/Field';
import { Tabs } from '../../ui/Tabs';
import { cx } from '../../ui/cx';
import { useClient } from '../../app/client';
import { duration, money, tokens } from '../../app/format';
import { useResource } from '../../app/live';
import { navigate } from '../../app/router';
import { ErrorState, Loaded, Page, PageHeader, Section } from '../../shell/layout';
import './developer.css';

type Tool = 'tools' | 'calculator' | 'task' | 'log' | 'service';

const TOOLS: Array<{ value: Tool; label: string }> = [
  { value: 'tools', label: 'Tools' },
  { value: 'calculator', label: 'Calculator' },
  { value: 'task', label: 'Task' },
  { value: 'log', label: 'Live log' },
  { value: 'service', label: 'Service' },
];

function Result({ value, error }: { value: unknown; error: unknown }) {
  if (error) return <ErrorState error={error} compact />;
  if (value === undefined) return null;
  return (
    <CodeBlock
      title="Result"
      code={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      wrap
      maxHeight="lg"
    />
  );
}

function ToolRunner() {
  const client = useClient();
  const tools = useResource('tools', async () => (await client.tools()).tools);
  const [name, setName] = useState('fs.read');
  const [input, setInput] = useState('{"relativePath": "README.md"}');
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setError(null);
    setResult(undefined);
    let parsed: unknown = {};
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch {
      setError(new Error('The input isn’t valid JSON.'));
      return;
    }
    setBusy(true);
    try {
      setResult((await client.runTool(name.trim(), parsed)).result);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Try a tool">
      <p className="page-hint">Try a tool before an automation uses it.</p>
      <Loaded resource={tools} what="tools" skeleton="text">
        {(list) => (
          <div className="dev-form">
            <Select
              label="Tool"
              value={name}
              onChange={(e) => setName(e.target.value)}
              hint={list.find((t) => t.name === name)?.description}
            >
              {list.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Textarea
              label="Input"
              mono
              rows={4}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              hint="JSON. ⌘↵ runs it."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <div className="page-row">
              <Button variant="primary" icon={Play} busy={busy} onClick={run}>
                Run tool
              </Button>
            </div>
            <Result value={result} error={error} />
          </div>
        )}
      </Loaded>
    </Section>
  );
}

function numbers(raw: string): Record<string, number> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
  }
  return out;
}

function Calculator() {
  const client = useClient();
  const [mode, setMode] = useState<'expression' | 'formulas'>('expression');
  const [expression, setExpression] = useState('gross / 1.25');
  const [formulas, setFormulas] = useState('{"net": "gross / 1.25", "tax": "gross - net"}');
  const [outputs, setOutputs] = useState('net, tax');
  const [inputs, setInputs] = useState('{"gross": 125}');
  const [result, setResult] = useState<EvalCalcResponse | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setError(null);
    setResult(undefined);
    let vars: Record<string, number>;
    try {
      vars = numbers(inputs);
    } catch {
      setError(new Error('The inputs aren’t valid JSON, e.g. {"gross": 125}.'));
      return;
    }
    let body: Parameters<typeof client.calculateEval>[0];
    if (mode === 'expression') body = { expression: expression.trim(), inputs: vars };
    else {
      try {
        body = {
          spec: {
            formulas: JSON.parse(formulas) as Record<string, string>,
            output_names: outputs
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          },
          inputs: vars,
        };
      } catch {
        setError(new Error('The formulas aren’t valid JSON, e.g. {"net": "gross / 1.25"}.'));
        return;
      }
    }
    setBusy(true);
    try {
      setResult(await client.calculateEval(body));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Calculator">
      <p className="page-hint">
        Exact arithmetic by the calculation engine on this computer, with a proof of each step.
      </p>
      <div className="dev-form">
        <SegmentedControl
          label="Kind"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'expression', label: 'One expression' },
            { value: 'formulas', label: 'Several formulas' },
          ]}
        />
        {mode === 'expression' ? (
          <Input
            label="Expression"
            mono
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
          />
        ) : (
          <>
            <Textarea
              label="Formulas"
              mono
              rows={3}
              value={formulas}
              onChange={(e) => setFormulas(e.target.value)}
              hint="JSON: a name for each formula."
            />
            <Input
              label="Outputs"
              mono
              value={outputs}
              onChange={(e) => setOutputs(e.target.value)}
              hint="The names to return, separated by commas."
            />
          </>
        )}
        <Textarea
          label="Inputs"
          mono
          rows={2}
          value={inputs}
          onChange={(e) => setInputs(e.target.value)}
          hint="JSON numbers by name."
        />
        <div className="page-row">
          <Button variant="primary" icon={CalcIcon} busy={busy} onClick={run}>
            Calculate
          </Button>
        </div>
        {error ? <ErrorState error={error} compact /> : null}
        {result && (
          <>
            <KeyValue
              items={Object.entries(result.values).map(([k, v]) => ({
                label: k,
                value: String(v),
                mono: true,
              }))}
            />
            <CodeBlock title="Proof" code={JSON.stringify(result.proof, null, 2)} maxHeight="md" />
          </>
        )}
      </div>
    </Section>
  );
}

function TaskRunner() {
  const client = useClient();
  const models = useResource('models', () => client.models());
  const [kind, setKind] = useState<'task' | 'explain'>('task');
  const [message, setMessage] = useState('');
  const [context, setContext] = useState('');
  const [model, setModel] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [result, setResult] = useState<
    TaskResponse | { explanation: string; model?: string; disclaimer?: string } | undefined
  >(undefined);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const parseContext = (): Record<string, unknown> | undefined => {
    if (!context.trim()) return undefined;
    return JSON.parse(context) as Record<string, unknown>;
  };

  const showPreview = async () => {
    setError(null);
    try {
      setPreview(
        await client.contextPreview({
          question: message || '(empty)',
          context: kind === 'explain' ? parseContext() : undefined,
        })
      );
    } catch (e) {
      setError(e instanceof SyntaxError ? new Error('The context isn’t valid JSON.') : e);
    }
  };

  const run = async () => {
    if (!message.trim()) return;
    setError(null);
    setResult(undefined);
    setBusy(true);
    try {
      const m = model || undefined;
      setResult(
        kind === 'explain'
          ? await client.explain(message, parseContext(), m)
          : await client.task(message, m, dryRun)
      );
    } catch (e) {
      setError(e instanceof SyntaxError ? new Error('The context isn’t valid JSON.') : e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Run a task">
      <div className="dev-form">
        <SegmentedControl
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'task', label: 'Task' },
            { value: 'explain', label: 'Explain' },
          ]}
        />
        <Textarea
          label="Message"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What should it do?"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void run();
            }
          }}
        />
        {kind === 'explain' && (
          <Textarea
            label="Context"
            mono
            rows={2}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder='{"document": "…"}'
            hint="Optional JSON the explanation draws on."
          />
        )}
        <div className="settings-inline">
          <Select label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{models.data ? `Default (${models.data.current})` : 'Default'}</option>
            {(models.data?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
          {kind === 'task' && (
            <Checkbox
              label="Dry run"
              hint="Work out the intent without calling a model."
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
          )}
        </div>
        <div className="page-row">
          <Button icon={Eye} onClick={showPreview}>
            Preview context
          </Button>
          <Button
            variant="primary"
            icon={Send}
            busy={busy}
            disabled={!message.trim()}
            onClick={run}
          >
            Run
          </Button>
        </div>
        {error ? <ErrorState error={error} compact /> : null}
        {preview && (
          <div className="dev-preview">
            <p className="page-hint">
              What the model would receive
              {preview.estimatedInputTokens !== undefined
                ? `, about ${tokens(preview.estimatedInputTokens)}`
                : ''}
              .
            </p>
            <CodeBlock title="System prompt" code={preview.systemPrompt} wrap maxHeight="sm" />
            <CodeBlock title="Message" code={preview.userContent} wrap maxHeight="sm" />
          </div>
        )}
        {result && (
          <div className="dev-preview">
            {'error' in result && result.error ? (
              <ErrorState error={new Error(result.error)} compact />
            ) : null}
            <CodeBlock title="Answer" code={result.explanation ?? ''} wrap maxHeight="lg" />
            <p className="page-hint">
              {[result.model, result.disclaimer].filter(Boolean).join(' · ')}
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}

interface LogEntry {
  id: string;
  ts: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  msg: string;
  data?: Record<string, unknown>;
}

function LiveLog() {
  const client = useClient();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<'all' | 'WARN' | 'ERROR'>('all');
  const [paused, setPaused] = useState(false);
  const [state, setState] = useState<'connecting' | 'open' | 'down'>('connecting');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const url = client.logsStreamUrl();
    if (typeof EventSource === 'undefined' || !/^https?:/.test(url)) {
      setState('down');
      return;
    }
    const es = new EventSource(url);
    es.onopen = () => setState('open');
    es.onerror = () => setState('down');
    es.onmessage = (m) => {
      if (pausedRef.current) return;
      try {
        const entry = JSON.parse(m.data) as LogEntry;
        setEntries((all) => [...all.slice(-499), entry]);
      } catch {
        /* not a log entry */
      }
    };
    return () => es.close();
  }, [client]);

  useEffect(() => {
    if (!paused) end.current?.scrollIntoView({ block: 'end' });
  }, [entries, paused]);

  const shown = entries.filter(
    (e) => level === 'all' || e.level === level || (level === 'WARN' && e.level === 'ERROR')
  );
  return (
    <Section
      title="Live log"
      actions={
        <>
          <SegmentedControl
            size="sm"
            label="Level"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'all', label: 'All' },
              { value: 'WARN', label: 'Warnings' },
              { value: 'ERROR', label: 'Errors' },
            ]}
          />
          <Button size="sm" icon={paused ? Play : Pause} onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setEntries([])}>
            Clear
          </Button>
        </>
      }
    >
      {state === 'down' && <ErrorState error={new TypeError('Failed to fetch')} compact />}
      <div className="dev-log" role="log" aria-live="off" tabIndex={0}>
        {shown.length === 0 ? (
          <p className="page-hint dev-log-empty">
            {state === 'open' ? 'Waiting for the next entry.' : 'Connecting.'}
          </p>
        ) : (
          shown.map((e) => (
            <div key={e.id} className={cx('dev-log-line', `is-${e.level.toLowerCase()}`)}>
              <span className="dev-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="dev-log-level">{e.level}</span>
              <span className="dev-log-msg">
                {e.msg}
                {e.data ? <span className="dev-log-data"> {JSON.stringify(e.data)}</span> : null}
              </span>
            </div>
          ))
        )}
        <div ref={end} />
      </div>
    </Section>
  );
}

interface Metrics {
  version: string;
  uptime_seconds: number;
  llm_calls_total?: number;
  llm_calls_failed?: number;
  llm_avg_latency_ms?: number | null;
  llm_input_tokens_total?: number;
  llm_output_tokens_total?: number;
  llm_cost_usd_total?: number;
  llm_unpriced_calls_total?: number;
}

function Service() {
  const client = useClient();
  const metrics = useResource('metrics', async () => (await client.metrics()) as Metrics, {
    on: ['runs'],
  });
  const health = useResource('health', () => client.health(), { on: ['health'] });
  return (
    <Section title="Background service">
      <Loaded resource={metrics} what="the service’s figures" skeleton="text">
        {(m) => (
          <KeyValue
            columns={2}
            items={[
              { label: 'Version', value: m.version, mono: true },
              { label: 'Up for', value: duration(m.uptime_seconds * 1000), mono: true },
              {
                label: 'Model',
                value: health.data?.llm
                  ? `${health.data.llm.provider} · ${health.data.llm.model}`
                  : '',
              },
              { label: 'Address', value: client.getUrl(), mono: true },
              { label: 'Model calls', value: String(m.llm_calls_total ?? 0), mono: true },
              { label: 'Failed calls', value: String(m.llm_calls_failed ?? 0), mono: true },
              {
                label: 'Average latency',
                value: m.llm_avg_latency_ms != null ? duration(m.llm_avg_latency_ms) : '',
                mono: true,
              },
              {
                label: 'Tokens',
                value: `${tokens(m.llm_input_tokens_total ?? 0, false)} in · ${tokens(m.llm_output_tokens_total ?? 0, false)} out`,
                mono: true,
              },
              {
                label: 'Spend since start',
                value: money(m.llm_cost_usd_total ?? 0, {
                  atLeast: (m.llm_unpriced_calls_total ?? 0) > 0,
                }),
                mono: true,
              },
            ]}
          />
        )}
      </Loaded>
      <p className="page-hint">
        Designing a screen? See the{' '}
        <a className="page-link" href="#/dev/gallery">
          component gallery
        </a>
        .
      </p>
    </Section>
  );
}

export function Developer({ tool }: { tool: string | null }) {
  const current = (TOOLS.find((t) => t.value === tool)?.value ?? 'tools') as Tool;
  return (
    <Page>
      <PageHeader crumbs={[{ label: 'Developer' }]} />
      <Tabs<Tool>
        label="Developer tools"
        value={current}
        onChange={(t) => navigate(`/developer/${t}`, { replace: true })}
        items={TOOLS}
      >
        <div className="dev-panel">
          {current === 'tools' && <ToolRunner />}
          {current === 'calculator' && <Calculator />}
          {current === 'task' && <TaskRunner />}
          {current === 'log' && <LiveLog />}
          {current === 'service' && <Service />}
        </div>
      </Tabs>
    </Page>
  );
}
