/**
 * Secrets vault UI — add and remove secrets. Values are never displayed.
 */
import { useState, useEffect, useCallback } from 'react';
import { gateway } from '../gateway';

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function SecretsVaultSection() {
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    setError(null);
    try {
      const res = await gateway.secrets();
      if (Array.isArray((res as { secrets?: string[] }).secrets)) {
        setNames((res as { secrets: string[] }).secrets);
      } else {
        setError((res as { error: string }).error ?? 'Vault unavailable');
        setNames([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gateway unreachable');
      setNames([]);
    }
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      setMessage('Name: alphanumeric, underscore, hyphen only.');
      return;
    }
    setMessage(null);
    try {
      await gateway.setSecret(name, newValue);
      setNewName('');
      setNewValue('');
      setMessage('Saved. Value is encrypted.');
      loadSecrets();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleDelete = async (name: string) => {
    setMessage(null);
    try {
      await gateway.deleteSecret(name);
      setMessage(`Removed ${name}`);
      loadSecrets();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ fontSize: '0.9rem' }}>
          Name
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="MY_API_KEY"
            style={{ display: 'block', width: 160, marginTop: 4 }}
          />
        </label>
        <label style={{ fontSize: '0.9rem' }}>
          Value
          <input
            type="password"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="••••••••"
            style={{ display: 'block', width: 200, marginTop: 4 }}
          />
        </label>
        <button type="button" className="btn" onClick={handleAdd}>Add</button>
      </div>
      {error && <ResultBox error>{error}</ResultBox>}
      {message && <ResultBox error={message.startsWith('Failed') || message.includes('only')}>{message}</ResultBox>}
      {names.length > 0 && (
        <div>
          <span style={{ fontSize: '0.9rem' }}>Stored:</span>
          <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
            {names.map((n) => (
              <li key={n} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <code>{n}</code>
                <button type="button" className="btn btn-ghost" style={{ fontSize: '0.8rem' }} onClick={() => handleDelete(n)}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
