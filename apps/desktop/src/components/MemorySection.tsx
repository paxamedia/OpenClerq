/**
 * Memory layer — inspect and prune file-backed memory (~/.clerq/memory.json).
 */
import { useState, useCallback, useEffect } from 'react';
import { gateway } from '../gateway';

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function MemorySection({ connectionOk }: { connectionOk: boolean }) {
  const [entries, setEntries] = useState<Array<{ key: string; value: unknown; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('{}');
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connectionOk) return;
    setError(null);
    try {
      const r = await gateway.memory();
      setEntries(r.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setEntries([]);
    }
  }, [connectionOk]);

  useEffect(() => {
    load();
  }, [load]);

  const addEntry = async () => {
    const k = newKey.trim();
    if (!k) {
      setMessage('Key required');
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(newValue);
    } catch {
      v = newValue;
    }
    setMessage(null);
    try {
      await gateway.setMemory(k, v);
      setNewKey('');
      setNewValue('{}');
      load();
      setMessage('Added.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  const removeEntry = async (key: string) => {
    setMessage(null);
    try {
      await gateway.deleteMemory(key);
      load();
      setMessage('Deleted.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (error) return <ResultBox error>{error}</ResultBox>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        File-backed memory in ~/.clerq/memory.json. Inspect and prune entries.
      </p>
      <div className="row" style={{ gap: '0.5rem' }}>
        <button type="button" className="btn" onClick={load} disabled={!connectionOk}>
          Refresh
        </button>
        {message && <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{message}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.9rem' }}>
          <span>Add entry</span>
          <div className="row" style={{ gap: '0.5rem', marginTop: 4, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              style={{ width: 120 }}
            />
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder='{"value": "..."}'
              style={{ flex: 1, minWidth: 150 }}
            />
            <button type="button" className="btn" onClick={addEntry} disabled={!connectionOk}>
              Add
            </button>
          </div>
        </label>
      </div>
      {entries.length === 0 ? (
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>No entries. Add one above.</p>
      ) : (
        <ul style={{ paddingLeft: '1.25rem', margin: 0 }}>
          {entries.map((e) => (
            <li key={e.key} style={{ marginBottom: '0.5rem' }}>
              <strong>{e.key}</strong>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: 8 }}>
                {e.createdAt}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginLeft: 8, padding: '0.1rem 0.35rem', fontSize: '0.8rem' }}
                onClick={() => removeEntry(e.key)}
              >
                Delete
              </button>
              <pre style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', maxHeight: 60, overflow: 'auto' }}>
                {typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
