# Security and abuse tests

Real HTTP server (booted on an ephemeral port), real Postgres and Redis, attacker harness in `apps/api/test/attacker/`
(distinct loopback source IPs, flood, raw TCP, slowloris). Commit C10 re-runs the same suites against nginx + two api copies.

| Attack | Expected behavior | Actual result | Test file | Status |
| --- | --- | --- | --- | --- |
| 200 concurrent holds of the same two seats | exactly one wins, 199 get `SEAT_UNAVAILABLE`, seats belong to one order | 1 x 200, 199 x 409 | `hold-race.adv.test.ts` | pass |
| 200 buyers requesting overlapping seat pairs | all-or-nothing orders, no seat in two orders, no partial order | invariant holds | `hold-race.adv.test.ts` | pass |
| Same `Idempotency-Key` x10 in parallel; same key + other body; missing key; key of another user | one order; 422 `IDEMPOTENCY_KEY_REUSED`; 400 `IDEMPOTENCY_KEY_REQUIRED`; keys are per user | as expected | `hold-race.adv.test.ts` | pass |
| 10 parallel 2-ticket orders, limit 6 | 3 succeed, 6 tickets | 3 x 200, 7 x 409 `LIMIT_EXCEEDED` | `limits-race.adv.test.ts` | pass |
| Dance floor over capacity (40 buyers x 2 on 30 places) | exactly 15 succeed; expired holds reclaimed by server clock | 15 / 30 reclaimed | `limits-race.adv.test.ts` | pass |
| 150 concurrent promo applications, limit 100 | exactly 100; expired unpaid orders return the use | 100 / 100 again after expiry | `promo-race.adv.test.ts` | pass |
| Foreign / unknown promo code | `PROMO_INVALID` | as expected | `promo-race.adv.test.ts` | pass |
| Login brute force from one IP | exactly the limit (30) gets 401, then 429 with `Retry-After`, while two innocent IPs keep 200 with p95 < 2 s | as expected | `auth.adv.test.ts` | pass |
| Spoofed `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, rotating values, framing a victim IP | limit not evaded, victim IP unaffected | as expected | `auth.adv.test.ts` | pass |
| Account lock-out by an attacker on another IP | only the attacker's IP+account pair is held back; the owner logs in from elsewhere | as expected | `auth.adv.test.ts` | pass |
| Many source IPs | every limiter key has a TTL | all 40 keys expire | `auth.adv.test.ts` | pass |
| Redis down | login fails open, does not hang (documented) | 200 within 5 s | `auth.adv.test.ts` | pass |
| IPv6 / IPv4-mapped normalisation, XFF only from the proxy | one bucket per client | unit-proven | `src/common/client-ip.test.ts` | pass |
| Unknown account vs wrong password | identical status and body, timing ratio within 0.5-2 | as expected | `auth.adv.test.ts` | pass |
| Token attacks: alg none, wrong secret, expired, nbf, missing claims, edited payload, unknown role/session, refresh-type token | 401 `UNAUTHENTICATED` | all rejected | `auth.adv.test.ts` | pass |
| Replay after logout; refresh reuse; 10 parallel refreshes | access token dead; whole family revoked (`TOKEN_REUSE_DETECTED`); exactly one refresh wins | as expected | `auth.adv.test.ts` | pass |
| Parallel registration with one email; mass assignment (`role`, `id`, `__proto__`) | one account; 400 | as expected | `auth.adv.test.ts` | pass |
| Every route without / with bad token | 401 for all protected routes, only the allow-list is public | route table iterated from OpenAPI | `routes.adv.test.ts` | pass |
| Role matrix on every protected route | 403 for each wrong role | as expected | `routes.adv.test.ts` | pass |
| Test-only endpoints in production profile | 404, clock untouched | as expected | `routes.adv.test.ts` | pass |
| IDOR on orders (read, history, remove item, release, promo) | 404, identical to a missing order | as expected | `idor.adv.test.ts` | pass |
| IDOR on venues, events, layouts, publish, block, promos, creating events in another hall | 404 | as expected | `idor.adv.test.ts` | pass |
| Drafts | invisible to public/search/other organizers, holds refused | as expected | `idor.adv.test.ts` | pass |
| SQL injection strings in search, sort, ids | literal match or 400, tables intact | as expected | `input.adv.test.ts` | pass |
| NoSQL operators, wrong types, floats, negative / unsafe ids | 400 | as expected (bug #2 found and fixed) | `input.adv.test.ts` | pass |
| XSS payloads stored and reflected | JSON + `nosniff`, never echoed in errors | as expected | `input.adv.test.ts` | pass |
| Path traversal, NUL bytes | 400/404, never 500 | as expected | `input.adv.test.ts` | pass |
| Wrong content type, malformed/truncated JSON, empty body, duplicate keys, `__proto__` | 415 / 400, no pollution | as expected | `input.adv.test.ts` | pass |
| Oversized body, huge arrays, very long strings | 413 / 400 | as expected | `input.adv.test.ts` | pass |
| Deeply nested JSON | 400 | bug #1 found (500) and fixed | `input.adv.test.ts` | pass |
| Invalid / negative pagination | 400 | as expected | `input.adv.test.ts` | pass |
| CRLF header injection, odd HTTP methods | no injected header, clean JSON 404 | as expected | `input.adv.test.ts` | pass |
| CORS, security headers, error bodies | foreign origin gets no CORS headers; helmet headers; no stack/SQL/paths | as expected | `input.adv.test.ts` | pass |
| Ledger tampering (UPDATE/DELETE/TRUNCATE, unbalanced, hand-edited balance) | rejected by the database | as expected | `test/integration/ledger.int.test.ts` | pass |
