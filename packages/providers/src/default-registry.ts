/**
 * The built-in provider registry.
 *
 * Kept as a module rather than a file beside the build output: the desktop
 * sidecar is a single `bun --compile` binary with no directory to read a YAML
 * file from, and a copy step would be one more thing to break on Windows.
 */

export const DEFAULT_REGISTRY_YAML = `# Model provider registry.
#
# This is the built-in registry. To change it without rebuilding, copy it to
# ~/.clerq/providers.yaml, or point CLERQ_PROVIDERS_FILE at a copy. That file
# then replaces this one entirely.
#
# Base URLs, model ids, context windows and prices change every few weeks;
# that volatility is exactly why this is data and not code.
#
# adapter:
#   anthropic       Anthropic Messages API
#   openai-compat   Any /chat/completions endpoint
#
# defaultModel is used when no model is named. Without it, the first model is.
#
# Prices are US dollars per million tokens. Verify them against the vendor's
# current pricing page before relying on a cost estimate. A model with no
# prices has an unknown cost, recorded as unknown rather than as free.

version: 1

providers:
  - id: anthropic
    label: Anthropic (Claude)
    adapter: anthropic
    baseUrl: https://api.anthropic.com/v1
    authEnv: ANTHROPIC_API_KEY
    defaultModel: claude-haiku-4-5
    models:
      - id: claude-opus-4-5
        context: 200000
        inputPerM: 5.00
        outputPerM: 25.00
      - id: claude-sonnet-4-5
        context: 200000
        inputPerM: 3.00
        outputPerM: 15.00
      - id: claude-haiku-4-5
        context: 200000
        inputPerM: 1.00
        outputPerM: 5.00

  - id: openai
    label: OpenAI
    adapter: openai-compat
    baseUrl: https://api.openai.com/v1
    authEnv: OPENAI_API_KEY
    defaultModel: gpt-5.2
    models:
      - id: gpt-5.2
        context: 400000
        inputPerM: 1.25
        outputPerM: 10.00

  - id: deepseek
    label: DeepSeek
    adapter: openai-compat
    baseUrl: https://api.deepseek.com/v1
    authEnv: DEEPSEEK_API_KEY
    defaultModel: deepseek-chat
    models:
      - id: deepseek-chat
        context: 128000
        inputPerM: 0.27
        outputPerM: 1.10
      - id: deepseek-reasoner
        context: 128000
        inputPerM: 0.55
        outputPerM: 2.19

  - id: moonshot
    label: Moonshot (Kimi)
    adapter: openai-compat
    # Mainland China endpoint is https://api.moonshot.cn/v1
    baseUrl: https://api.moonshot.ai/v1
    authEnv: MOONSHOT_API_KEY
    defaultModel: kimi-k2-0905-preview
    models:
      - id: kimi-k2-0905-preview
        context: 256000
        inputPerM: 0.60
        outputPerM: 2.50

  - id: zai
    label: Z.ai (GLM)
    adapter: openai-compat
    baseUrl: https://api.z.ai/api/paas/v4
    authEnv: ZAI_API_KEY
    defaultModel: glm-4.6
    models:
      - id: glm-4.6
        context: 200000
        inputPerM: 0.60
        outputPerM: 2.20

  - id: minimax
    label: MiniMax
    adapter: openai-compat
    baseUrl: https://api.minimax.io/v1
    authEnv: MINIMAX_API_KEY
    defaultModel: MiniMax-M2
    models:
      - id: MiniMax-M2
        context: 200000
        inputPerM: 0.30
        outputPerM: 1.20

  - id: ollama
    label: Ollama (local)
    adapter: openai-compat
    baseUrl: http://localhost:11434/v1
    # No key needed for a local model.
    authEnv: null
    defaultModel: llama3.2
    models:
      - id: llama3.2
        context: 128000
        inputPerM: 0
        outputPerM: 0

  - id: lmstudio
    label: LM Studio (local)
    adapter: openai-compat
    baseUrl: http://localhost:1234/v1
    authEnv: null
    models: []
`;
