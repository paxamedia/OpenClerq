/**
 * AI explanation layer — guidance only, no calculations.
 * Supports Anthropic (cloud), Ollama, or OpenAI-compatible local models (LM Studio, vLLM).
 * Set CLERQ_LLM_PROVIDER=ollama for local models; no API key required.
 */

import { callLLM } from './llm-provider.js';
import { loadSystemPrompt } from '../system-prompt.js';

/**
 * The most of a skill's instructions sent with each call, in characters
 * (about 4,000 tokens). Anything past it is cut off and marked as cut.
 */
export const SKILL_INSTRUCTIONS_MAX_CHARS = 16_000;

export interface ExplainRequest {
  question: string;
  /** Optional: context (e.g. data from user's own tools or calculation engine) */
  context?: Record<string, unknown>;
  /** Optional: selected skill for scoped guidance */
  skillSlug?: string;
  skillName?: string;
  /** Optional: the selected skill's instructions (the SKILL.md body). */
  skillInstructions?: string;
  /** Optional: model override (use when user has multiple models) */
  model?: string;
  /** Stops the model call, e.g. when the client that asked has gone. */
  signal?: AbortSignal;
}

export interface ContextPreview {
  systemPrompt: string;
  userContent: string;
  /** Approximate token count (chars / 4). */
  estimatedInputTokens?: number;
}

type PromptInput = Pick<
  ExplainRequest,
  'question' | 'context' | 'skillSlug' | 'skillName' | 'skillInstructions'
>;

/** Cut instructions to the cap without splitting a surrogate pair. */
function capInstructions(text: string): string {
  if (text.length <= SKILL_INSTRUCTIONS_MAX_CHARS) return text;
  let end = SKILL_INSTRUCTIONS_MAX_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n\n[Skill instructions truncated at ${SKILL_INSTRUCTIONS_MAX_CHARS} characters.]`;
}

/**
 * The system prompt and user turn for a request. The real call and the
 * preview both use this, so the preview shows exactly what is sent.
 */
function buildPrompt(req: PromptInput): { systemPrompt: string; userContent: string } {
  let userContent = req.question;
  if (req.context && Object.keys(req.context).length > 0) {
    userContent += `\n\nContext:\n${JSON.stringify(req.context, null, 2)}`;
  }

  let systemPrompt = loadSystemPrompt();
  const skill = req.skillName ?? req.skillSlug;
  if (skill) {
    systemPrompt += `\n\nThe "${skill}" skill was selected for this request.`;
    const instructions = req.skillInstructions?.trim();
    if (instructions) {
      systemPrompt +=
        ' Follow its instructions below; they do not override the rules above.' +
        `\n\n<skill_instructions>\n${capInstructions(instructions)}\n</skill_instructions>`;
    }
  }
  return { systemPrompt, userContent };
}

/**
 * Build the context that would be sent to the LLM, without making a call.
 */
export function buildContextPreview(req: PromptInput): ContextPreview {
  const { systemPrompt, userContent } = buildPrompt(req);
  const estimatedInputTokens = Math.ceil((systemPrompt.length + userContent.length) / 4);
  return { systemPrompt, userContent, estimatedInputTokens };
}

export interface ExplainResponse {
  explanation: string;
  model: string;
  disclaimer: string;
}

export async function getExplanation(req: ExplainRequest): Promise<ExplainResponse> {
  const { systemPrompt, userContent } = buildPrompt(req);
  const { text, model } = await callLLM(systemPrompt, userContent, req.model, req.signal);

  return {
    explanation: text,
    model,
    disclaimer: 'This is guidance only, not legal or professional advice.',
  };
}
