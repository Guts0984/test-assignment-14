#!/usr/bin/env bash
# Brings the full stack (postgres, redis, migrate+seed, 2x api, worker, web, mailstub, nginx) up in its test profile and waits.
# Usage: scripts/stack.sh up|down|logs
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
compose=(docker compose -f docker-compose.yml -f docker-compose.test.yml)
case "${1:-up}" in
  up)
    "${compose[@]}" up -d --build --wait --wait-timeout 600 postgres redis api-1 api-2 mailstub worker web nginx
    ;;
  down) "${compose[@]}" down -v ;;
  logs) "${compose[@]}" logs --tail 100 ;;
  *) echo "usage: $0 up|down|logs" >&2; exit 2 ;;
esac
