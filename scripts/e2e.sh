#!/usr/bin/env bash
# Playwright against the running stack, in two phases: the real rules, then a stack started with a queue limit of 1.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
compose=(docker compose -f docker-compose.yml -f docker-compose.test.yml)
export E2E_BASE_URL="http://127.0.0.1:8080"
export E2E_API_1_URL="http://127.0.0.1:8081" E2E_API_2_URL="http://127.0.0.1:8082"

pnpm --filter @ticketing/web exec playwright test --grep-invert @queue
E2E_QUEUE_ACTIVATE_AT=1 E2E_QUEUE_MAX_SELECTING=1 "${compose[@]}" up -d --wait api-1 api-2 worker
E2E_QUEUE_LIMIT=1 pnpm --filter @ticketing/web exec playwright test --grep @queue
"${compose[@]}" up -d --wait api-1 api-2 worker  # back to the real thresholds
