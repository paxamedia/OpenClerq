/**
 * Calculator panel — deterministic arithmetic via local Rust engine.
 * Per AGENTS.md: all numeric work is executed by the calculation engine, not by AI.
 */
import { useState, useCallback } from 'react';
import { gateway, type EvalCalcResponse } from '@clerq/gateway-client';

type CalcMode = 'expression' | 'spec';

const EXPRESSION_PLACEHOLDER = 'amount * 1.25';
const SPEC_PLACEHOLDER = '{"net": "gross / 1.25", "tax": "gross - net"}';
const INPUTS_PLACEHOLDER = '{"gross": 125}';

function parseInputsJson(raw: string): Record<string, number> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v)) result[k] = v;
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) result[k] = parseFloat(v);
  }
  return result;
}

export function CalculatorPanel() {
  const [mode, setMode] = useState<CalcMode>('expression');
  const [expression, setExpression] = useState('');
  const [specFormulas, setSpecFormulas] = useState(SPEC_PLACEHOLDER);
  const [specOutputs, setSpecOutputs] = useState('net, tax');
  const [inputs, setInputs] = useState(INPUTS_PLACEHOLDER);
  const [result, setResult] = useState<{ values: EvalCalcResponse['values']; proof: EvalCalcResponse['proof'] } | string | null>(null);
  const [loading, setLoading] = useState(false);

  const runCalculate = useCallback(async () => {
    setResult(null);
    setLoading(true);
    try {
      let body: Parameters<typeof gateway.calculateEval>[0];
      const parsedInputs = (() => {
        try {
          return parseInputsJson(inputs);
        } catch {
          throw new Error('Invalid inputs JSON. Use e.g. {"a": 100, "rate": 25}');
        }
      })();

      if (mode === 'expression') {
        const expr = expression.trim();
        if (!expr) throw new Error('Expression is required');
        body = { expression: expr, inputs: parsedInputs };
      } else {
        let formulas: Record<string, string>;
        try {
          formulas = JSON.parse(specFormulas.trim()) as Record<string, string>;
          if (!formulas || typeof formulas !== 'object') throw new Error('Invalid formulas');
        } catch {
          throw new Error('Formulas must be a JSON object, e.g. {"net": "gross/1.25"}');
        }
        const outputNames = specOutputs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        body = {
          spec: { formulas, output_names: outputNames },
          inputs: parsedInputs,
        };
      }

      const out = await gateway.calculateEval(body);
      setResult({ values: out.values, proof: out.proof });
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mode, expression, specFormulas, specOutputs, inputs]);

  return (
    <section className="section dev-section calculator-panel">
      <h2>Calculator</h2>
      <p className="section-desc">
        Deterministic arithmetic via the local Rust engine. All numeric work is auditable.
      </p>

      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
          <input
            type="radio"
            checked={mode === 'expression'}
            onChange={() => setMode('expression')}
          />
          Expression
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
          <input
            type="radio"
            checked={mode === 'spec'}
            onChange={() => setMode('spec')}
          />
          Spec (multi-formula)
        </label>
      </div>

      {mode === 'expression' ? (
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.9rem' }}>Expression</span>
          <input
            type="text"
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder={EXPRESSION_PLACEHOLDER}
            style={{ display: 'block', width: '100%', marginTop: 4 }}
          />
        </label>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <label style={{ fontSize: '0.9rem' }}>
            Formulas (JSON: name → expression)
            <textarea
              value={specFormulas}
              onChange={(e) => setSpecFormulas(e.target.value)}
              rows={2}
              placeholder={SPEC_PLACEHOLDER}
              style={{ display: 'block', width: '100%', fontFamily: 'monospace', marginTop: 4 }}
            />
          </label>
          <label style={{ fontSize: '0.9rem' }}>
            Output names (comma-separated)
            <input
              type="text"
              value={specOutputs}
              onChange={(e) => setSpecOutputs(e.target.value)}
              placeholder="net, tax"
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
        </div>
      )}

      <label style={{ display: 'block', marginBottom: '0.75rem' }}>
        <span style={{ fontSize: '0.9rem' }}>Inputs (JSON)</span>
        <textarea
          value={inputs}
          onChange={(e) => setInputs(e.target.value)}
          rows={2}
          placeholder={INPUTS_PLACEHOLDER}
          style={{ display: 'block', width: '100%', fontFamily: 'monospace', marginTop: 4 }}
        />
      </label>

      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
        <button
          type="button"
          className="btn"
          onClick={runCalculate}
          disabled={loading}
        >
          {loading ? 'Calculating…' : 'Calculate'}
        </button>
      </div>

      {result !== null && (
        <div className="calculator-result">
          {typeof result === 'string' ? (
            <pre className="result-box error">{result}</pre>
          ) : (
            <>
              <div className="calculator-values">
                {Object.entries(result.values).map(([k, v]) => (
                  <div key={k} className="calculator-value-row">
                    <strong>{k}</strong>
                    <span>{typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)}</span>
                  </div>
                ))}
              </div>
              {result.proof && (
                <details className="calculator-proof" style={{ marginTop: '0.5rem' }}>
                  <summary style={{ fontSize: '0.85rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    Audit proof
                  </summary>
                  <pre className="result-box" style={{ marginTop: 4, fontSize: '0.8rem' }}>
                    {JSON.stringify(result.proof, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
