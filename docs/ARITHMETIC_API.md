# Arithmetic API — Calculation Engine Reference

The arithmetic engine runs **locally** in Rust (`clerq-calc`). All numeric work is deterministic and auditable. AI never computes; this engine does.

## Endpoint

`POST /calculate/eval`

## Request

Provide either `expression` (single formula) or `spec` (multi-formula):

```json
{
  "expression": "a * 1.25",
  "inputs": { "a": 100 }
}
```

Or with spec (multiple outputs):

```json
{
  "spec": {
    "formulas": { "net": "gross / 1.25", "tax": "gross - net" },
    "output_names": ["net", "tax"]
  },
  "inputs": { "gross": 125 }
}
```

## Response

```json
{
  "values": { "net": 100, "tax": 25 },
  "proof": {
    "calculation_id": "...",
    "timestamp": "...",
    "scope": "ARITHMETIC",
    "operation": "...",
    "proof_hash": "...",
    "engine_version": "0.1.0",
    "is_audit_ready": true
  }
}
```

## Supported Operators

| Operator | Description |
|----------|-------------|
| `+` `-` `*` `/` | Basic arithmetic |
| `%` | Modulo |
| `^` | Power |

## Supported Functions

| Function | Example | Description |
|----------|---------|-------------|
| `min(a, b)` | `min(3, 7)` → 3 | Minimum of two values |
| `max(a, b)` | `max(3, 7)` → 7 | Maximum of two values |
| `floor(x)` | `floor(99.9)` → 99 | Round down |
| `round(x)` | `round(99.7)` → 100 | Round to nearest |
| `ceil(x)` | `ceil(99.1)` → 100 | Round up |
| `math::sqrt(x)` | `math::sqrt(144)` → 12 | Square root |
| `math::abs(x)` | `math::abs(-42)` → 42 | Absolute value |
| `math::ln(x)` | `math::ln(2.718)` | Natural log |
| `math::log(x, base)` | `math::log(100, 10)` → 2 | Log with base |
| `math::log2(x)` | — | Base-2 log |
| `math::log10(x)` | — | Base-10 log |
| `math::exp(x)` | — | e^x |
| `math::exp2(x)` | — | 2^x |
| `math::pow(base, exp)` | `math::pow(2, 10)` → 1024 | Power |

## Examples

### Simple expression

```bash
curl -X POST http://127.0.0.1:18790/calculate/eval \
  -H "Content-Type: application/json" \
  -d '{"expression":"100 + 25","inputs":{}}'
```

### With variables

```bash
curl -X POST http://127.0.0.1:18790/calculate/eval \
  -H "Content-Type: application/json" \
  -d '{"expression":"a * (1 + rate/100)","inputs":{"a":100,"rate":25}}'
```

### Percentage (gross with 25% added)

```bash
curl -X POST http://127.0.0.1:18790/calculate/eval \
  -H "Content-Type: application/json" \
  -d '{"expression":"net * 1.25","inputs":{"net":80}}'
```

### Multi-formula spec

```bash
curl -X POST http://127.0.0.1:18790/calculate/eval \
  -H "Content-Type: application/json" \
  -d '{"spec":{"formulas":{"tax":"amount*0.25","total":"amount+tax"},"output_names":["tax","total"]},"inputs":{"amount":100}}'
```

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `expression or spec.formulas required` | 400 | Must provide expression or spec.formulas |
| `calculation_engine_unavailable` | 503 | Run `pnpm build:core` |
| `calculation_failed` | 500 | Invalid expression or runtime error |

## See Also

- [DEVELOPER_SETUP](DEVELOPER_SETUP.md) — Run the gateway and test locally
- [ERROR_RESPONSE_SHAPE](ERROR_RESPONSE_SHAPE.md) — Error format
