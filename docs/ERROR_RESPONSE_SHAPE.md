# Gateway error response shape

All error responses use a consistent shape. No PII in error bodies.

## Format

```json
{
  "error": "<code>",
  "message": "<human-readable message>",
  "requestId": "<optional>"
}
```

## Error codes

| Code | HTTP | Description |
|------|------|-------------|
| `question is required` | 400 | /explain: missing question |
| `message is required` | 400 | /task: missing message |
| `expression or spec.formulas required` | 400 | /calculate/eval: must provide expression or spec.formulas |
| `calculation_engine_unavailable` | 503 | Rust engine not built |
| `ai_unavailable` | 503 | LLM not configured — set API key (Anthropic) or use local (CLERQ_LLM_PROVIDER=ollama / CLERQ_LLM_BASE_URL) |
| `calculation_failed` | 500 | Arithmetic engine error |
| `explain_failed` | 500 | AI explain error |
| `task_failed` | 500 | Task handler error |
| `skills_load_failed` | 500 | Skills directory load error |

## License errors

When `CLERQ_DEV` is not set and no valid license is provided:

- **403 Forbidden** — License check failed; body may include `error: "license_required"`.
