/**
 * Triggers UI — cron, file watchers, webhooks. Managed via gateway API.
 */
import { useState, useEffect, useCallback } from 'react';
import { gateway } from '../gateway';

interface CronTrigger {
  id: string;
  schedule: string;
  message: string;
}

interface FileTrigger {
  id: string;
  path: string;
  message: string;
}

interface TriggersConfig {
  cron?: CronTrigger[];
  file?: FileTrigger[];
  webhooks?: Record<string, { message: string }>;
}

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function TriggersSection() {
  const [config, setConfig] = useState<TriggersConfig>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await gateway.triggers();
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gateway unreachable');
      setConfig({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (next: TriggersConfig) => {
      setMessage(null);
      try {
        await gateway.saveTriggers(next);
        setConfig(next);
        setMessage('Triggers saved.');
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Failed');
      }
    },
    []
  );

  const addCron = () => {
    const cron = [...(config.cron ?? []), { id: `cron-${Date.now()}`, schedule: '0 9 * * *', message: 'Check pending tasks' }];
    save({ ...config, cron });
  };

  const updateCron = (i: number, patch: Partial<CronTrigger>) => {
    const cron = [...(config.cron ?? [])];
    cron[i] = { ...cron[i], ...patch };
    save({ ...config, cron });
  };

  const removeCron = (i: number) => {
    const cron = (config.cron ?? []).filter((_, j) => j !== i);
    save({ ...config, cron });
  };

  const addFile = () => {
    const file = [...(config.file ?? []), { id: `file-${Date.now()}`, path: '', message: 'File changed' }];
    save({ ...config, file });
  };

  const updateFile = (i: number, patch: Partial<FileTrigger>) => {
    const file = [...(config.file ?? [])];
    file[i] = { ...file[i], ...patch };
    save({ ...config, file });
  };

  const removeFile = (i: number) => {
    const file = (config.file ?? []).filter((_, j) => j !== i);
    save({ ...config, file });
  };

  const addWebhook = () => {
    const id = `webhook-${Date.now()}`;
    const webhooks = { ...(config.webhooks ?? {}), [id]: { message: 'Webhook triggered' } };
    save({ ...config, webhooks });
  };

  const updateWebhook = (id: string, message: string) => {
    const webhooks = { ...(config.webhooks ?? {}) };
    webhooks[id] = { message };
    save({ ...config, webhooks });
  };

  const removeWebhook = (id: string) => {
    const webhooks = { ...(config.webhooks ?? {}) };
    delete webhooks[id];
    save({ ...config, webhooks });
  };

  if (error) return <ResultBox error>{error}</ResultBox>;

  const webhookUrl = gateway.getUrl();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        Cron, file watchers, webhooks. Stored in ~/.clerq/triggers.json. Gateway must be running.
      </p>

      <div>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <strong>Cron</strong>
          <button type="button" className="btn btn-ghost" onClick={addCron}>+ Add</button>
        </div>
        {(config.cron ?? []).map((t, i) => (
          <div key={t.id} className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <input
              placeholder="0 9 * * *"
              value={t.schedule}
              onChange={(e) => updateCron(i, { schedule: e.target.value })}
              style={{ width: 120 }}
            />
            <input
              placeholder="Message"
              value={t.message}
              onChange={(e) => updateCron(i, { message: e.target.value })}
              style={{ flex: 1, minWidth: 160 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeCron(i)}>✕</button>
          </div>
        ))}
      </div>

      <div>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <strong>File watchers</strong>
          <button type="button" className="btn btn-ghost" onClick={addFile}>+ Add</button>
        </div>
        {(config.file ?? []).map((t, i) => (
          <div key={t.id} className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <input
              placeholder="/path/to/watch"
              value={t.path}
              onChange={(e) => updateFile(i, { path: e.target.value })}
              style={{ flex: 1, minWidth: 200 }}
            />
            <input
              placeholder="Message"
              value={t.message}
              onChange={(e) => updateFile(i, { message: e.target.value })}
              style={{ width: 160 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeFile(i)}>✕</button>
          </div>
        ))}
      </div>

      <div>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <strong>Webhooks</strong>
          <button type="button" className="btn btn-ghost" onClick={addWebhook}>+ Add</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          POST {webhookUrl}/webhook/&lt;id&gt; — optional body: {"{ \"message\": \"...\" }"}
        </p>
        {Object.entries(config.webhooks ?? {}).map(([id, v]) => (
          <div key={id} className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <code style={{ fontSize: '0.85rem' }}>{id}</code>
            <input
              placeholder="Message"
              value={v.message}
              onChange={(e) => updateWebhook(id, e.target.value)}
              style={{ flex: 1, minWidth: 160 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeWebhook(id)}>✕</button>
          </div>
        ))}
      </div>

      {message && <ResultBox error={message.startsWith('Failed')}>{message}</ResultBox>}
    </div>
  );
}
