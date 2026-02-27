/**
 * System prompt editor. Customize the LLM's base instructions.
 */
import { useState, useEffect, useCallback } from 'react';
import { gateway } from '../gateway';

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function SystemPromptSection() {
  const [prompt, setPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await gateway.systemPrompt();
      setPrompt(res.prompt);
      setDefaultPrompt(res.default);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gateway unreachable');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setMessage(null);
    try {
      await gateway.saveSystemPrompt(prompt);
      setMessage('System prompt saved.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  const reset = () => {
    setPrompt(defaultPrompt);
    setMessage('Reset to default. Click Save to apply.');
  };

  if (error) return <ResultBox error>{error}</ResultBox>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        Base instructions for the LLM. Stored in ~/.clerq/system-prompt.txt. Empty = use default.
      </p>

      <label style={{ fontSize: '0.9rem' }}>
        System prompt
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          placeholder={defaultPrompt}
          style={{ display: 'block', width: '100%', fontFamily: 'monospace', marginTop: 4 }}
        />
      </label>

      <div className="row" style={{ gap: '0.5rem' }}>
        <button type="button" className="btn" onClick={save}>Save</button>
        <button type="button" className="btn btn-ghost" onClick={reset}>Reset to default</button>
      </div>
      {message && <ResultBox error={message.startsWith('Failed')}>{message}</ResultBox>}
    </div>
  );
}
