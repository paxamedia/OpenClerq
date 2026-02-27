/**
 * Capabilities UI — filesystem root, network allowlist. Restricts tool access.
 */
import { useState, useEffect, useCallback } from 'react';
import { gateway } from '../gateway';

interface CapabilitiesConfig {
  fsRoot?: string;
  fsAllowWrite?: boolean;
  httpAllowlist?: string[];
}

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function CapabilitiesSection() {
  const [config, setConfig] = useState<CapabilitiesConfig>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await gateway.capabilities();
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gateway unreachable');
      setConfig({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setMessage(null);
    try {
      await gateway.saveCapabilities(config);
      setMessage('Capabilities saved. Applied immediately.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  const addHost = () => {
    const list = [...(config.httpAllowlist ?? []), ''];
    setConfig({ ...config, httpAllowlist: list });
  };

  const updateHost = (i: number, v: string) => {
    const list = [...(config.httpAllowlist ?? [])];
    list[i] = v;
    setConfig({ ...config, httpAllowlist: list });
  };

  const removeHost = (i: number) => {
    const list = (config.httpAllowlist ?? []).filter((_, j) => j !== i);
    setConfig({ ...config, httpAllowlist: list });
  };

  if (error) return <ResultBox error>{error}</ResultBox>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        Restrict what tools can access. Stored in ~/.clerq/capabilities.json.
      </p>

      <label style={{ fontSize: '0.9rem' }}>
        <span>Filesystem root</span>
        <input
          type="text"
          value={config.fsRoot ?? ''}
          onChange={(e) => setConfig({ ...config, fsRoot: e.target.value || undefined })}
          placeholder="Leave empty for working directory"
          style={{ display: 'block', width: '100%', maxWidth: 400, marginTop: 4 }}
        />
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>fs.read resolves paths under this directory.</span>
      </label>

      <div>
        <div className="row" style={{ alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <strong>HTTP allowlist</strong>
          <button type="button" className="btn btn-ghost" onClick={addHost}>+ Add host</button>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          Hostnames http.request can call. Empty = http.request disabled.
        </p>
        {(config.httpAllowlist ?? []).map((h, i) => (
          <div key={i} className="row" style={{ gap: '0.5rem', marginBottom: '0.35rem' }}>
            <input
              placeholder="example.com"
              value={h}
              onChange={(e) => updateHost(i, e.target.value)}
              style={{ width: 200 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeHost(i)}>✕</button>
          </div>
        ))}
      </div>

      <button type="button" className="btn" onClick={save}>Save capabilities</button>
      {message && <ResultBox error={message.startsWith('Failed')}>{message}</ResultBox>}
    </div>
  );
}
