/**
 * Reasoning controls UI — temperature, max tokens.
 */
import { useState, useEffect, useCallback } from 'react';
import { gateway } from '../gateway';

interface ReasoningConfig {
  temperature?: number;
  maxTokens?: number;
}

function ResultBox({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return <pre className={`result-box ${error ? 'error' : ''}`}>{children}</pre>;
}

export function ReasoningSection() {
  const [config, setConfig] = useState<ReasoningConfig>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await gateway.reasoning();
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
      await gateway.saveReasoning(config);
      setMessage('Reasoning config saved. Applied to next LLM calls.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Failed');
    }
  };

  if (error) return <ResultBox error>{error}</ResultBox>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p className="section-desc" style={{ marginBottom: 0 }}>
        Temperature and max tokens for LLM calls. Stored in ~/.clerq/reasoning.json.
      </p>

      <label style={{ fontSize: '0.9rem' }}>
        Temperature (0–2)
        <input
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={config.temperature ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setConfig({ ...config, temperature: v === '' ? undefined : parseFloat(v) });
          }}
          placeholder="Default"
          style={{ display: 'block', width: 120, marginTop: 4 }}
        />
      </label>

      <label style={{ fontSize: '0.9rem' }}>
        Max tokens
        <input
          type="number"
          min={1}
          max={128000}
          value={config.maxTokens ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            setConfig({ ...config, maxTokens: v === '' ? undefined : parseInt(v, 10) });
          }}
          placeholder="1024"
          style={{ display: 'block', width: 120, marginTop: 4 }}
        />
      </label>

      <button type="button" className="btn" onClick={save}>Save reasoning</button>
      {message && <ResultBox error={message.startsWith('Failed')}>{message}</ResultBox>}
    </div>
  );
}
