/**
 * LLM observability: latency, token usage, failure rates.
 * Audit-ready metrics for /metrics endpoint.
 */

let llmCallsTotal = 0;
let llmCallsFailed = 0;
let llmLatencyMs: number[] = [];
let llmInputTokens = 0;
let llmOutputTokens = 0;
const MAX_SAMPLES = 100;

export function recordLLMSuccess(latencyMs: number, inputTokens?: number, outputTokens?: number): void {
  llmCallsTotal += 1;
  llmLatencyMs.push(latencyMs);
  if (llmLatencyMs.length > MAX_SAMPLES) llmLatencyMs.shift();
  if (typeof inputTokens === 'number') llmInputTokens += inputTokens;
  if (typeof outputTokens === 'number') llmOutputTokens += outputTokens;
}

export function recordLLMFailure(): void {
  llmCallsTotal += 1;
  llmCallsFailed += 1;
}

export function getObservability() {
  const avgLatency =
    llmLatencyMs.length > 0
      ? Math.round(llmLatencyMs.reduce((a, b) => a + b, 0) / llmLatencyMs.length)
      : null;
  const failureRate = llmCallsTotal > 0 ? llmCallsFailed / llmCallsTotal : 0;
  return {
    llm_calls_total: llmCallsTotal,
    llm_calls_failed: llmCallsFailed,
    llm_failure_rate: Math.round(failureRate * 1000) / 1000,
    llm_avg_latency_ms: avgLatency,
    llm_input_tokens_total: llmInputTokens,
    llm_output_tokens_total: llmOutputTokens,
  };
}
