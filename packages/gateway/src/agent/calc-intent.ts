/**
 * Detect calculation intent from natural language and extract expression/inputs.
 * Used by /task to run the arithmetic engine before AI explanation.
 */

export interface CalcIntent {
  expression: string;
  inputs?: Record<string, number>;
}

/**
 * Try to parse a calculation request from the message.
 * Returns null if no clear calculation intent.
 */
export function parseCalculationIntent(message: string): CalcIntent | null {
  const trimmed = message.trim().toLowerCase();

  // "Calculate 25% on 100", "25% of 100", "add 25% to 100"
  const percentOn = trimmed.match(/(?:calculate|add|apply)\s+(\d+(?:\.\d+)?)\s*%\s*(?:on|of|to)\s+(\d+(?:\.\d+)?)/i);
  if (percentOn) {
    const pct = parseFloat(percentOn[1]) / 100;
    const base = parseFloat(percentOn[2]);
    return { expression: `${base} * (1 + ${pct})`, inputs: {} };
  }

  const percentOf = trimmed.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of|on)\s+(\d+(?:\.\d+)?)/i);
  if (percentOf) {
    const pct = parseFloat(percentOf[1]) / 100;
    const base = parseFloat(percentOf[2]);
    return { expression: `${base} * ${pct}`, inputs: {} };
  }

  // "What is 10 * 20", "Compute 100 + 200"
  const mathPrefix = trimmed.match(/(?:what(?:'s| is)?|compute|calculate|eval)\s+([\d\s+*/().\-]+)/i);
  if (mathPrefix) {
    const expr = mathPrefix[1].replace(/\s+/g, '');
    if (expr.length >= 2 && /^[\d+*/().\-]+$/.test(expr)) {
      return { expression: expr, inputs: {} };
    }
  }

  // Standalone expression: "10 * 1.25", "100 + 200"
  const standalone = trimmed.match(/^([\d\s+*/().\-]+)$/);
  if (standalone && standalone[1].replace(/\s/g, '').length >= 2) {
    const expr = standalone[1].replace(/\s+/g, '');
    if (/[\d][\s]*[+*/\-][\s]*[\d]/.test(expr)) {
      return { expression: expr, inputs: {} };
    }
  }

  // "a + b" with "a=10 b=20" or "where a=10, b=20"
  const withVars = trimmed.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(\d+(?:\.\d+)?)/g);
  if (withVars) {
    const inputs: Record<string, number> = {};
    for (const m of withVars) {
      const [k, v] = m.split(/\s*=\s*/);
      if (k && v) inputs[k.trim()] = parseFloat(v);
    }
    const exprMatch = trimmed.match(/(?:calculate|eval|compute)\s+([a-zA-Z0-9_+\-*/().\s]+?)(?:\s+where|\s*$)/i)
      || trimmed.match(/^([a-zA-Z0-9_+\-*/().\s]+?)(?:\s+where|$)/);
    if (exprMatch && Object.keys(inputs).length > 0) {
      const expression = exprMatch[1].replace(/\s+/g, '');
      if (expression.length >= 1) return { expression, inputs };
    }
  }

  return null;
}
