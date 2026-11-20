#!/usr/bin/env bash
# Same sequence CI runs. Usage: bash scripts/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm check:secrets
pnpm check:api-client
pnpm test
pnpm build
