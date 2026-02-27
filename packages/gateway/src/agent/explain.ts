/**
 * AI explanation layer — guidance only, no calculations.
 * Supports Anthropic (cloud), Ollama, or OpenAI-compatible local models (LM Studio, vLLM).
 * Set CLERQ_LLM_PROVIDER=ollama for local models; no API key required.
 */

import { callLLM } from './llm-provider.js';
import { loadSystemPrompt } from '../system-prompt.js';

export interface ExplainRequest {
  question: string;
  /** Optional: context (e.g. data from user's own tools or calculation engine) */
  context?: Record<string, unknown>;
  /** Optional: selected skill for scoped guidance */
  skillSlug?: string;
  skillName?: string;
  /** Optional: model override (use when user has multiple models) */
  model?: string;
}

export interface ContextPreview {
  systemPrompt: string;
  userContent: string;
  /** Approximate token count (chars / 4). */
  estimatedInputTokens?: number;
}

/**
 * Build the context that would be sent to the LLM, without making a call.
 */
export function buildContextPreview(req: Pick<ExplainRequest, 'question' | 'context' | 'skillSlug' | 'skillName'>): ContextPreview {
  let userContent = req.question;
  if (req.context && Object.keys(req.context).length > 0) {
    userContent += `\n\nContext:\n${JSON.stringify(req.context, null, 2)}`;
  }
  if (req.skillSlug || req.skillName) {
    userContent += `\n\nAnswer using the ${req.skillName ?? req.skillSlug} skill rules.`;
  }
  const systemPrompt = loadSystemPrompt();
  const estimatedInputTokens = Math.ceil((systemPrompt.length + userContent.length) / 4);
  return { systemPrompt, userContent, estimatedInputTokens };
}

export interface ExplainResponse {
  explanation: string;
  model: string;
  disclaimer: string;
}

export async function getExplanation(req: ExplainRequest): Promise<ExplainResponse> {
  let userContent = req.question;
  if (req.context && Object.keys(req.context).length > 0) {
    userContent += `\n\nContext:\n${JSON.stringify(req.context, null, 2)}`;
  }
  if (req.skillSlug || req.skillName) {
    userContent += `\n\nAnswer using the ${req.skillName ?? req.skillSlug} skill rules.`;
  }

  const systemPrompt = loadSystemPrompt();
  const { text, model } = await callLLM(systemPrompt, userContent, req.model);

  return {
    explanation: text,
    model,
    disclaimer: 'This is guidance only, not legal or professional advice.',
  };
}
