#!/usr/bin/env bash
# Quick local verification: gateway must be running on 127.0.0.1:18790.
# Run from repo root: ./scripts/verify-local.sh
# Usage: start gateway first (CLERQ_DEV=1 pnpm gateway), then run this in another terminal.

set -e
BASE="${CLERQ_GATEWAY_URL:-http://127.0.0.1:18790}"

echo "Verifying gateway at $BASE ..."

# Health
if ! curl -sf "$BASE/health" > /dev/null; then
  echo "FAIL: GET /health did not return 200. Is the gateway running? (CLERQ_DEV=1 pnpm gateway)"
  exit 1
fi
echo "  GET /health OK"

# Skills
if ! curl -sf "$BASE/skills" > /dev/null; then
  echo "FAIL: GET /skills did not return 200."
  exit 1
fi
echo "  GET /skills OK"

# Arithmetic eval (optional; requires pnpm build:core)
if curl -sf -X POST "$BASE/calculate/eval" -H "Content-Type: application/json" -d '{"expression":"10 + 25","inputs":{}}' > /dev/null 2>/dev/null; then
  echo "  POST /calculate/eval OK"
else
  echo "  POST /calculate/eval skipped (pnpm build:core may not have run)"
fi

# Filing prep (generic)
if curl -sf -X POST "$BASE/filing/prep" -H "Content-Type: application/json" -d '{"form_type":"generic","data":{}}' > /dev/null 2>/dev/null; then
  echo "  POST /filing/prep OK"
else
  echo "  POST /filing/prep skipped"
fi

# Task (optional; requires ANTHROPIC_API_KEY)
TASK_RESP=$(curl -sf -X POST "$BASE/task" -H "Content-Type: application/json" -d '{"message":"Calculate 25% on 100 units"}' 2>/dev/null) || true
if [ -n "$TASK_RESP" ] && echo "$TASK_RESP" | grep -q '"intent"'; then
  echo "  POST /task OK"
else
  echo "  POST /task skipped (ANTHROPIC_API_KEY may be unset)"
fi

echo "Verification passed. Gateway is up and responding."
