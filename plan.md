# plan.md — Concert ticketing service

Status: **Phase 0 (plan) — awaiting approval.** Nothing is scaffolded. Not a git repo yet (`git init` happens in C1).
Priority: ASSIGNMENT.md > this plan > CLAUDE.md > defaults. README language: **English** (assumption A-01). Product locales: uk, en, pl.

Block names used below: **C1..C11** = commits (see §8). Test names are file stems; `*.int` = integration (real PG+Redis), `*.unit` = pure, `*.adv` = adversarial against the real stack (nginx + 2×api + worker), `*.e2e` = Playwright.

---

## 1. Requirements matrix

### 1.1 Stack and prohibitions (STK)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| STK-1 | PostgreSQL 16 + Prisma; raw SQL where locks/constraints needed; Postgres is the source of truth | C2 | `schema.constraints.int` |
| STK-2 | Money = double-entry journal | C2, C7 | `ledger.int`, ACC-18 |
| STK-3 | Redis 7 + BullMQ for: hold expiry, payment deadlines, waitlist offers, mass cancel, refunds, payouts, emails, PDF | C4, C8 | `jobs.*.int` |
| STK-4 | Virtual queue at sale start | C4, C7 | `queue.int`, `queue.adv` |
| STK-5 | Socket.IO Redis adapter between `api` copies | C7, C10 | `realtime.adv` |
| STK-6 | Losing Redis loses no orders, money or queue places | C4, C8 | `redis-flush.adv` (INV-9) |
| STK-7 | `apps/api`: NestJS REST + OpenAPI (`@nestjs/swagger`) + Socket.IO (`@nestjs/websockets`); two copies behind nginx in compose | C5, C10 | `smoke.e2e`, `routes.adv` |
| STK-8 | `apps/worker`: separate NestJS process with BullMQ handlers; N copies allowed | C8 | `worker-multi.adv` |
| STK-9 | `apps/web`: Next.js 15 App Router, React 19, client generated from OpenAPI, TanStack Query, React Hook Form, Tailwind, next-intl | C9 | `web build`, `api-client check` |
| STK-10 | `packages/shared`: zod input schemas, rule constants, price & refund calculations shared by api/worker/web | C1 skeleton, C2 content | `pricing.unit`, `refund.unit` |
| STK-11 | Tests: Vitest; integration on real PG+Redis; e2e Playwright | all | CI |
| STK-12 | Forbidden: `any`, `@ts-ignore` without justification, hand-written API response types, external services (payments, mail, SMS, maps), secrets in code | all | lint rules `no-explicit-any`, `ban-ts-comment` (require description), `no-secrets` grep test in CI; `api-client check` |
| STK-13 | Payment stub inside the project | C6 | `stub.*.int` |

### 1.2 Buyer scenarios (SCN-B)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| SCN-B1 | Event search: text, city, date, category, price, "has seats"; filters/sort/page in URL | C5 (api), C9 (web) | `events-search.int`, `search-url.e2e` |
| SCN-B2 | Hall map: zones with prices; seats free/held/sold/unavailable; **live** updates; dance floor = pick quantity | C5, C7, C9 | `seatmap.int`, `two-browsers.e2e`, `realtime.adv` |
| SCN-B3 | Pick ≤6 seats → held 10 min, timer on screen; may remove/add seats while timer runs | C5, C9 | `holds.int`, `hold-timer.unit`, `hold-expiry.e2e` |
| SCN-B4 | Virtual queue at sale start: position + ETA, in-order access, reload keeps place | C4, C7, C9 | `queue.int`, `queue.adv`, `queue.e2e` |
| SCN-B5 | Promo code (percent or fixed, usage limit) | C5 | `promo.int` |
| SCN-B6 | Pay via stub; tickets in account; PDF with QR emailed | C6, C7, C8, C9 | `checkout.e2e`, `ticket-email.int` |
| SCN-B7 | Refund per rules; cancelled event → auto refund incl. fee; rescheduled → full refund within 14 days | C7, C8 | `refund.int`, `mass-cancel.int`, `reschedule-refund.int` |
| SCN-B8 | Transfer ticket by email; old QR invalid | C7 | `transfer.int`, `ticket-flow.e2e` |
| SCN-B9 | Waitlist on sold-out event; offer for 30 min on release | C7, C8 | `waitlist.int` |

### 1.3 Organizer scenarios (SCN-O)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| SCN-O1 | Upload hall JSON (zones, rows, seats, dance floor with capacity), see it; assign zone prices by selecting seats on the map | C5 (api, schema), C9 (UI) | `venue-schema.unit`, `venues.int`, `organizer-pricing.e2e` |
| SCN-O2 | Create event: date, venue, prices, sale start time, per-person limit; block non-sale seats | C5, C9 | `events-crud.int` |
| SCN-O3 | Create promo codes | C5, C9 | `promo.int` |
| SCN-O4 | Reschedule (buyers emailed); cancel (background refund of all orders, live progress) | C7, C8, C9 | `reschedule.int`, `mass-cancel.int`, `cancel-progress.e2e` |
| SCN-O5 | Sales: by hour, by zone, fill ratio, queue→payment funnel | C7, C9 | `reports-organizer.int`, `perf.script` |
| SCN-O6 | Payout after event minus commission | C8 | `payout.int` |

### 1.4 Scanner (SCN-S) and Finance (SCN-F)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| SCN-S1 | Entry page for own event; scan QR with camera or type code | C9 | `ticket-flow.e2e`, `scanner-ui.unit` |
| SCN-S2 | "Pass" or reason: already entered at HH:MM gate N / transferred / other event / refunded | C7 | `scan.int` (all reasons) |
| SCN-S3 | Counter: entered and still expected | C7, C9 | `scan.int` |
| SCN-F1 | Period report (period in URL): sales, service fees, commission, refunds, payouts, per-organizer breakdown | C7, C9 | `reports-finance.int`, `perf.script` |
| SCN-F2 | Reconciliation: sum of entries = 0; account balance = sum of its entries; differences vs payment stub listed | C7 | `reconcile.int` |
| SCN-F3 | Manual refund by order with reason | C7 | `refund-manual.int` |
| SCN-F4 | See stuck/failed jobs, restart them; restart duplicates nothing | C7, C8 | `jobs-admin.int` |

### 1.5 Rules (RUL)

| ID | Rule | Block | Proof |
| --- | --- | --- | --- |
| RUL-1 | Hold 10 min from first selected seat; adding seats does not extend; expiry frees seats and promo | C5, C8 | `holds.int`, `hold-expiry.int` |
| RUL-2 | Default 6 tickets per person per event across all their orders; organizer may change | C5 | `limits.int` |
| RUL-3 | Dance floor sold by count, ≤ capacity | C5 | `dancefloor.int` |
| RUL-4 | Queue activates when >500 claim the event at once; max 200 selecting; admit in join order; one account = one place; admitted user who does not start selecting within 5 min loses the slot to the next | C4, C7 | `queue.int` (time-mocked) |
| RUL-5 | Service fee 5% of ticket price, min 20 ₴, paid by buyer | C2 | `pricing.unit` |
| RUL-6 | Commission 8% of ticket price, withheld from payout, rounded in organizer's favour | C2, C8 | `pricing.unit`, `payout.int` |
| RUL-7 | Promo: percent or fixed; not applied to the service fee; usage limit; usage returned only if the order is unpaid | C5 | `promo.int`, `pricing.unit` |
| RUL-8 | Refund: >7 days before event = ticket price without fee; 2–7 days = 50% of price; <2 days = not allowed; cancelled event = 100% incl. fee | C2, C7 | `refund.unit` (boundaries), `refund.int` |
| RUL-9 | Reschedule: 14 days after the reschedule, full refund of price regardless of lead time | C2, C7 | `refund.unit`, `reschedule-refund.int` |
| RUL-10 | Payment after hold: seats still free → tickets issued; taken → full automatic refund | C7 | `late-payment.int` (ACC-7) |
| RUL-11 | Transfer not later than 1 h before start; new owner gets a new QR | C7 | `transfer.int` |
| RUL-12 | Waitlist: one offer at a time, 30 min; not paid → next | C7, C8 | `waitlist.int` |
| RUL-13 | Payout 3 days after event | C8 | `payout.int` |
| RUL-14 | QR signed by server; forged/modified = reject | C7 | `qr.unit`, `scan.adv` |
| RUL-15 | Money in UAH kopecks, integers (`bigint`/`number` safe ints, no floats; zod `int`) | C2 | `no-float.lint`, `ledger.int` |
| RUL-16 | Order statuses `holding awaiting_payment paid expired partially_refunded refunded`; event statuses `draft on_sale sold_out rescheduled cancelled finished paid_out`; transition tables (who, from which) in README | C2 (state machines in shared), C11 | `transitions.unit` (every illegal pair rejected), README check |
| RUL-17 | Order history: hold, payment, ticket issue, transfer, refunds, entries — who and when | C5, C7 | `order-history.int` |
| RUL-18 | Seed: 50 000 users, 30 halls (one with 10 000 seats incl. dance floor), 2 000 events (some with sales starting 10 min after launch), 1 000 000 sold tickets; logins in README | C3, C11 | `seed.int` (counts, ledger balanced), ACC-1 |

### 1.6 Payment stub (STUB)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| STUB-1 | Payment page with buttons "Success", "Failure", "Close without answer" | C6 | `stub-page.int`, `checkout.e2e` |
| STUB-2 | HMAC-signed webhook | C6 | `webhook-signature.int` |
| STUB-3 | Chaos mode (`.env` switch): duplicate webhook, delay up to 1 min, out of order (`failed` after `succeeded`), webhook never sent | C6 | `stub-chaos.int`, `payment-webhooks.adv` |
| STUB-4 | Accepts full and partial refunds, answers with a webhook | C6 | `stub-refund.int` |
| STUB-5 | ≤20 req/s globally (across both api copies); excess → 429; in chaos every 10th request → 503 | C6 | `stub-ratelimit.adv`, `stub-chaos.int` |
| STUB-6 | Payment and refund status via API; reconciliation uses it every minute to find stuck operations | C6, C8 | `reconcile-stuck.int` |

### 1.7 Invariants (INV) — each at concurrency, retry, process restart and Redis loss

| ID | Invariant | Block | Proof (all with `*.adv` real-stack unless marked) |
| --- | --- | --- | --- |
| INV-1 | Seat sold once: 200 concurrent holds of same seats → exactly one; multi-seat order all-or-nothing | C5 | `hold-race.adv`, `holds.int` |
| INV-2 | Limits hold under concurrency: per person, dance floor, promo (150 vs 100 → exactly 100) | C5 | `limits-race.adv`, `promo-race.adv`, `dancefloor-race.adv` |
| INV-3 | Hold by server clock; free after 10 min even with dead worker; late payment handled by RUL-10 without manual steps | C5, C7 | `hold-expiry-noworker.int`, `late-payment.int` |
| INV-4a | Every operation = entries summing to 0 (DB deferred constraint) | C2 | `ledger.int` (+ invoked after every scenario by `assertLedger()` helper) |
| INV-4b | Sum of refunds per order ≤ paid under parallel refund requests | C7 | `refund-race.adv` |
| INV-4c | Payout = sales − refunds − commission | C8 | `payout.int` |
| INV-5 | Payment/refund counted exactly once: duplicate, delay, reorder, bad signature (reject), lost webhook (found by reconciliation) | C6, C7 | `payment-webhooks.adv` |
| INV-6 | Idempotency-Key on hold, pay, refund, transfer: same key = same result; same key + different body = reject | C5, C7 | `idempotency.adv` |
| INV-7a | `kill -9` worker mid-task → completed after restart; no duplicate ticket/email/entry/refund | C8 | `worker-kill.adv` |
| INV-7b | Several worker copies never run a task twice | C8 | `worker-multi.adv` |
| INV-7c | Provider error → retry with backoff; exhausted → visible to finance | C8 | `jobs-retry.int`, `jobs-admin.int` |
| INV-8 | Mass cancel of 10 000 orders: sales/transfers stop at once; each order refunded exactly once; stub 20 rps respected, 429 never loses/duplicates; live progress; re-run duplicates nothing | C7, C8 | `mass-cancel.int` (500 orders, CI), `mass-cancel-10k.script` (ACC-11), `cancel-progress.e2e` |
| INV-9 | `FLUSHALL`/Redis restart: holds expire on time, payment deadlines and waitlist offers fire, mass cancel resumes, emails go out, nothing twice; queue restored in same order | C4, C8 | `redis-flush.adv` |
| INV-10 | Fair queue: strict join order; ≤200 selecting even across both api copies; reload / second tab ≠ second place | C4, C7 | `queue.adv` |
| INV-11 | Waitlist: one offer at a time; expired → next; seat reserved for the offer holder meanwhile | C7, C8 | `waitlist.adv` |
| INV-12 | One valid ticket: after transfer/refund the old QR is rejected; forged QR rejected; same ticket at two gates at once → one pass | C7 | `scan.adv` |
| INV-13a | Live updates through both api copies, <1 s | C7, C10 | `realtime.adv` |
| INV-13b | Reconnect catch-up by sequence number; no stale statuses shown | C7, C9 | `realtime.adv`, `seatmap-reducer.unit` |
| INV-13c | Queue position and personal notifications only reach the addressee | C7 | `realtime.adv` |
| INV-13d | Hold timer from server clock (client clock skewed 5 min still correct) | C5, C9 | `hold-timer.unit`, `clock-skew.e2e` |
| INV-14 | Permissions on server in every endpoint and socket: buyer sees only own orders/tickets; organizer only own events, no buyer data beyond entry needs; scanner only own event, no money; finance cannot change events | C5, C7 | `routes.adv` (route-table iteration), `idor.adv`, `socket-authz.adv` |
| INV-15 | Invalid input → clear coded error, one format in all endpoints, declared in OpenAPI; never "Internal server error" | C5 | `error-format.int`, `fuzz.adv`, `openapi-errors.unit` |
| INV-T | Time in jobs (10 min, 5/30 min, 2/7/14 d, 3 d) is mockable in tests | C2 | `app_now()` test clock — see A-07 — `clock.int` |

### 1.8 Deliverables (DEL)

| ID | Requirement | Block | Proof |
| --- | --- | --- | --- |
| DEL-1 | Repo: `apps/api`, `apps/worker`, `apps/web`, `packages/shared` | C1 | tree check |
| DEL-2 | `cp .env.example .env && docker compose up --build` | C1 (skeleton) … C10 (full) | ACC-1 |
| DEL-3 | Compose services: `postgres`, `redis`, `api`×2, `nginx`, `worker`, `web`, mail stub (SMTP in, web page out) | C10 (mailstub C6) | ACC-1 |
| DEL-4 | Migrations and seed run automatically; no other manual steps | C3, C10 | ACC-1 |
| DEL-5 | Swagger at `/docs`; generated client equals schema — CI check | C5, C9 | `api-client check` CI step |
| DEL-6 | Locales `uk`, `en`, `pl`: money (`1 234,50 ₴`), event date/time, plurals ("3 билета"/"5 билетов" style) | C9 | `format.unit` (3 locales), `i18n.e2e` |
| DEL-7 | 10 000-seat hall opens and scrolls without jank; seats selectable via keyboard | C9 | `seatmap-perf.e2e` (frame budget), `seatmap-keyboard.e2e` |
| DEL-8 | Forms show errors at fields; checkout completable by keyboard | C9 | `forms.e2e`, `checkout-keyboard.e2e` |
| DEL-9 | Event search and hall map with live statuses <200 ms on seed; organizer & finance reports over 90 days <500 ms | C3 (indexes), C7, C11 | `perf.script` (p95 over N runs) |
| DEL-10 | e2e #1: two browsers on one map — seat chosen in the first becomes unavailable in the second without reload | C10 | `two-browsers.e2e` |
| DEL-11 | e2e #2: hold expires → seats free for both | C10 | `hold-expiry.e2e` |
| DEL-12 | e2e #3: queue with limit 1: second buyer waits, then reaches seat selection after the first | C10 | `queue.e2e` |
| DEL-13 | e2e #4: seats → promo → stub payment → ticket → transfer → scanner accepts new QR, rejects old | C10 | `ticket-flow.e2e` |
| DEL-14 | README sections: run & tests; hold mechanics (locks, DB constraints, expiry); ledger scheme (accounts; payment, fee, refund, cancel, payout); background jobs (when queued, retries, duplicate protection, Redis-loss recovery); queue & mass cancel design; event delivery through two api copies; order & event status tables; DB indexes & constraints; decisions | C11 | README review vs behavior (ACC-20) |
| DEL-15 | CI on every commit | C1 | `.github/workflows/ci.yml` in first commit |
| DEL-16 | History organized by stages | all | commit plan |

### 1.9 Acceptance checks (ACC)

All run as automated tests or `scripts/acceptance/NN-*.sh|ts`; results recorded in §10.

| # | Check | Automated by | Block |
| --- | --- | --- | --- |
| 1 | `cp .env.example .env && docker compose up --build` comes up with no manual steps | `scripts/acceptance/01-compose-up.sh` (+ nginx smoke) | C10 |
| 2 | Typecheck, lint, client unchanged, tests, CI pass | CI; `scripts/verify.sh` | every commit |
| 3 | Two browsers on different api copies; seat in first visible to second <1 s | `two-browsers.e2e` (each browser pinned to a copy via `X-Api-Instance` debug header/ports) + `realtime.adv` latency assert | C10 |
| 4 | 200 concurrent holds of same seats: one wins, others clean refusal | `hold-race.adv` | C5/C10 |
| 5 | 10 parallel 2-ticket orders, limit 6 → 3 pass, 6 tickets | `limits-race.adv` | C5/C10 |
| 6 | 150 concurrent promo applications, limit 100 → 100; expired unpaid return usage | `promo-race.adv` | C5/C10 |
| 7 | Payment at 11 min: seats free → tickets; seats taken → full refund | `late-payment.int`, `late-payment.adv` | C7 |
| 8 | Payment + refund webhooks in chaos mode: counted once; unsigned rejected; lost one found by reconciliation | `payment-webhooks.adv` | C7/C10 |
| 9 | Two parallel refund requests: ≤ paid refunded | `refund-race.adv` | C7/C10 |
| 10 | `kill -9` worker mid mass-cancel; 3 worker copies → finishes, no dups | `worker-kill.adv` | C8/C10 |
| 11 | Cancel of event with 10 000 orders in chaos, then cancel again: each refunded once, 20 rps never exceeded, progress visible, sales stopped at once | `scripts/acceptance/11-mass-cancel-10k.ts` | C10 |
| 12 | `FLUSHALL` during sales and mass cancel, restart worker | `redis-flush.adv` | C10 |
| 13 | 1 000 people at sale start via both api copies: queue, ordered, ≤200 selecting, reload keeps place | `queue.adv` | C10 |
| 14 | Refund of sold-out ticket with waitlist: offer to first; unpaid after 30 min → second | `waitlist.adv` | C10 |
| 15 | Transfer; old/new QR at entrance | `scan.adv`, `ticket-flow.e2e` | C10 |
| 16 | One ticket at two gates at once → one pass | `scan.adv` | C10 |
| 17 | Foreign orders/tickets/events by direct request and via socket not visible | `idor.adv`, `socket-authz.adv` | C10 |
| 18 | Reconciliation after everything: sum zero, no differences | `scripts/acceptance/18-reconcile.ts` (run last) + `assertLedger()` in every suite | C10 |
| 19 | Search, 10 000-seat map, 90-day reports fast; reload / Back restores state from URL | `perf.script`, `search-url.e2e` | C10/C11 |
| 20 | uk/en/pl money, dates, plurals; README matches behavior | `format.unit`, `i18n.e2e`, README review | C9/C11 |

### 1.10 Non-functional (NFR)

| ID | Requirement | Proof |
| --- | --- | --- |
| NFR-1 | Perf budgets: search <200 ms; seat map with statuses <200 ms; 90-day reports <500 ms (p95 on the full seed) | `perf.script` |
| NFR-2 | 10 000-seat map scrolls smoothly: canvas rendering + viewport culling; ≤1 long task >50 ms during scripted pan/zoom | `seatmap-perf.e2e` |
| NFR-3 | Keyboard access: arrow-key seat focus, Enter/Space select, visible focus, checkout without mouse, `aria-live` status | `seatmap-keyboard.e2e`, `checkout-keyboard.e2e`, axe check |
| NFR-4 | Locales uk/en/pl, ICU plurals, `Intl` money/date formatting | `format.unit` |
| NFR-5 | One error format everywhere with a stable `code` | `error-format.int` |
| NFR-6 | Security baseline (CLAUDE.md): argon2id, rotating refresh with reuse detection, constant-time secret comparisons, generic auth errors, parameterised SQL only, body-size limits, helmet-style headers, CORS allowlist, no secrets in logs | `auth.adv`, `input.adv`, `headers.adv` |
| NFR-7 | Code rules: functional except Nest constructs, named exports, TS strict, no `!`, FSD boundary lint in web, files ≲200 lines | lint (`eslint-plugin-boundaries` + custom rule) |

---

## 2. Deviations

Assignment > CLAUDE.md > prompt. Only real conflicts are listed.

| # | Conflict | Resolution |
| --- | --- | --- |
| D-01 | Prompt asks for "about 10–12 commits" and, a few lines later, "stay within 6–8". Mutually exclusive. | Resolved by the user: the commit-count range does not matter. Keeping 11 commits (§8), one per complete block. |
| D-02 | Prompt/CLAUDE.md commit plan suggests a "redis infra" block and "nginx" block; assignment mandates them too — no conflict. Assignment forbids external services (mail/payments) → no Mailpit/Stripe images; mail stub is our own tiny SMTP service. | Own `infra/mailstub` (smtp-server + mailparser). |
| D-03 | CLAUDE.md default "React + Vite for web", "pnpm, Jest or Vitest" vs assignment names Next.js 15 / Vitest / Playwright. | Assignment wins: Next.js; Vitest everywhere. Vite not used. |
| D-04 | CLAUDE.md "no `class` outside Nest" vs Prisma/BullMQ/Socket.IO APIs that expose classes. | Third-party classes are *used*, never declared by us, except Nest constructs and zod-generated DTO classes (`nestjs-zod`) — allowed by CLAUDE.md. |
| D-05 | CLAUDE.md: jobs run in Redis/BullMQ; assignment: Redis loss must lose nothing. | BullMQ is only the *executor*; every scheduled task has a durable row in Postgres (`tasks`) and a rehydrator re-enqueues from PG (§4.4). BullMQ delays are wake-up hints; due-ness is decided by PG time. |
| D-06 | CLAUDE.md says to add a general limiter only as optional hardening; the skill demands the per-IP limiter attack suite. | Assignment mandates only stub 20 rps + queue. I add optional login throttling (env-driven, loose test profile) and the skill's limiter tests apply to it and to the stub's global limiter (§6). |
| D-07 | Assignment says "Time in tasks is mocked in tests"; CLAUDE.md says nothing. | Database-side test clock `app_now()` (A-07). |
| D-08 | Assignment's table says seed has 1 000 000 *sold tickets*; CLAUDE.md demands ledger balanced and DB the single truth. | Seed produces matching orders, payments (stub rows), ledger entries, rollups — not just ticket rows (A-14). |

---

## 3. Assumptions (also copied to README "Decisions")

| # | Gap / ambiguity | Decision |
| --- | --- | --- |
| A-01 | README language | English. |
| A-02 | Roles | `buyer`, `organizer`, `scanner`, `finance` (single role per user). Scanner is bound to events via `event_staff`; organizer assigns scanners by email. Registration creates only `buyer`; seed creates the other roles; organizer self-registration is not offered (documented seed logins). |
| A-03 | Auth | Email+password (argon2id). Access JWT 15 min; opaque rotating refresh token (hash in PG, family id, reuse ⇒ family revoked); web stores them in httpOnly cookies, API accepts Bearer. Socket auth via JWT in handshake. |
| A-04 | Currency/rounding | UAH, kopecks. Service fee per ticket = `max(2000, round_half_up(5% × list price))`. Commission = `floor(8% × net sales)` (floor ⇒ organizer's favour; computed once per event on net = sales − refunds at payout). |
| A-05 | Promo discount | Applies to ticket price only; funded by the organizer (reduces organizer sales, fee unchanged). Percent discount allocated to tickets by largest-remainder so cents sum exactly; fixed discount capped at ticket subtotal and allocated proportionally. Promo scoped to one event (or `NULL` = all events of that organizer). One promo per order. |
| A-06 | Per-person limit counts | Tickets in active holds + paid, non-refunded tickets by that user for that event, across all orders. Fully refunded tickets stop counting. Per-event limit set by organizer (default 6; max hold selection per order also 6). |
| A-07 | Mockable time | All time-dependent SQL uses `app_now()` = `clock_timestamp() + offset`, where `offset` comes from a one-row `test_clock` table. Writable only through a test-only controller registered when `TEST_CLOCK_ENABLED=true` (never in prod profile; `clock.int` and `routes.adv` assert 404 when disabled). App-side `Clock` reads the same offset. BullMQ delays are only hints; handlers re-check due-ness against PG. Server-clock expiry therefore cannot depend on workers. |
| A-08 | Hold expiry without worker | Seat/zone/promo/limit counters are reclaimed *lazily* inside the same transaction that needs them (predicate `hold_expires_at <= app_now()` + reclaim step under the row/advisory lock), and all read paths filter by `app_now()`. The worker job only cleans up, emits live events and promo/limit counters eagerly. |
| A-09 | Dance floor | Zone row `event_zones(capacity, sold, held)` with `CHECK (sold + held <= capacity)`; atomic conditional `UPDATE` with lazy reclaim. A hold stores quantity on `order_items`. |
| A-10 | Hold "10 minutes from first selected seat" | `orders.hold_expires_at` set when the first item is added; never changed. Payment must complete within the same window (payment deadline = hold expiry, no separate extension). Adding items after `awaiting_payment` is not allowed; user may go back (order returns `holding`) until the deadline. |
| A-11 | "Concurrent claimants > 500" | Claimants = users with a queue entry in `waiting/admitted/selecting` for that event. Queue mode turns on when claimants > `QUEUE_ACTIVATE_AT` (500, shared constant) and stays on until claimants = 0. Below the threshold users are admitted immediately (entry still recorded for the funnel). Cap of 200 selecting applies in queue mode. Join order = per-event PG sequence. |
| A-12 | Queue slot lifecycle | Admitted → must create a hold within 5 min else slot expires (next admitted). Slot is freed when the user's order is paid, expired, abandoned or after the hold TTL. ETA = `position / admission_rate` with rate observed over last 5 min (fallback 200 per 10 min). Admission SQL runs under per-event advisory lock and is invoked by api copies and the worker alike, so the 200 cap holds regardless of who calls. |
| A-13 | "Has seats" filter | `capacity − sold − blocked > 0` from maintained counters; holds ignored (cheap, <200 ms); the seat map itself shows exact live state. |
| A-14 | Seed realism | Set-based SQL (`INSERT … SELECT generate_series`) building users (one shared argon2id hash of a documented password), venues, events, event_seats, ~500k orders, 1M tickets, payments, ledger entries, rollups, queue-start events. Historical seed events sit in the past or future with legit state. Seed is idempotent (`seed_state` marker) and runs in the one-shot `migrate` service. |
| A-15 | Payout timing with reschedule | `payout_at = starts_at + 3 d` (new date). Refunds are impossible after event start (except cancelled events, which don't pay out), so the 14-day reschedule window is clipped to event start and can't collide with payout. |
| A-16 | Reschedule semantics | Status `rescheduled` remains purchasable (acts as on_sale); `rescheduled_at` column drives the 14-day window. Sold-out state is only entered from `on_sale`. Further reschedules reset the window. |
| A-17 | Refund granularity | Per ticket (each ticket refunded at most once, unique partial index). 7-day/2-day thresholds are measured against event `starts_at` at refund time; "more than 7 days" = `> 7×24 h`, "2–7 days" = `≥ 2 d and ≤ 7 d`, "<2 days" = rejected. Refund amount = price actually paid for the ticket (after promo), fee refunded only on cancellation or late-payment-lost-seat. 50% rounds half-up toward the buyer. |
| A-18 | Late payment after expiry | Under the order row lock: re-claim seats (and the promo use) via the same hold SQL; success ⇒ issue tickets; failure ⇒ order becomes `refunded` via full refund including fee. Promo exhausted counts as "failure" (limits never exceeded). |
| A-19 | Payment stub placement | Module inside `api` (`modules/payment-stub`, mounted at `/stub/*`, separate DB tables `stub_*`, own HMAC secret) so compose matches the assignment's service list. Our payment code talks to it only over HTTP (like a real provider), through nginx or the internal api URL. Webhook delivery and delays are executed by worker tasks (durable, survives restarts). 20 rps limit is a Redis Lua token bucket shared by both copies; Redis down ⇒ stub fails closed with 503; Redis flushed ⇒ bucket resets (≤1 s of drift, tolerated and documented). |
| A-20 | Stub idempotency | Stub accepts `Idempotency-Key` on payment & refund creation (needed for exactly-once refunds under 429/503 retry). Our refund id is the key. |
| A-21 | Mail | Own mail stub service: SMTP on 1025, web page + JSON on 8025. Email dedupe: `emails` table with `dedupe_key UNIQUE`, deterministic `Message-ID`; mail stub dedups by Message-ID ⇒ no duplicate mail even if the worker dies between SMTP send and DB mark. |
| A-22 | PDF | `pdfkit` + `qrcode` in worker (no external service). One PDF per order, one page per ticket. |
| A-23 | QR format | `v1.<base64url(ticketId.eventId.qrVersion)>.<base64url(HMAC-SHA256)>`; scan resolves to DB row; transfer bumps `qr_version`. Manual entry accepts the same string. Camera decode via `BarcodeDetector` with `jsqr` fallback. |
| A-24 | Scan atomicity | `UPDATE tickets SET entered_at = app_now(), gate = $g WHERE id=$1 AND status='valid' AND qr_version=$2 AND entered_at IS NULL RETURNING …` — at most one winner; reasons derived afterwards. |
| A-25 | Waitlist | Entry per (event, user), ordered by join sequence. A free seat (refund, expiry, cancellation of other's hold) creates an offer for the first waiting user *and reserves that seat for them* (`event_seats.reserved_for_offer_id`), so nobody else can hold it for 30 min. Offer pays through the normal hold→order path with the reserved seat. Dance-floor waitlist reserves quantity 1. |
| A-26 | Organizer data visibility | Organizer sees aggregates plus per-ticket `buyerRef` initials-free pseudonym (`ticket short id`) and masked email for entry needs only (no names, no phone, no payment data). |
| A-27 | Realtime ordering | Per-event `seat_seq` counter incremented in the same txn as the seat change (last statement); events stored in `seat_events` (PG). Emission after commit through Socket.IO Redis adapter; on reconnect the client sends `lastSeq` and receives missing rows from PG (or a full snapshot if gap > 5 000). Redis flush loses only in-flight pub/sub, which catch-up repairs. Seat state carries `heldUntil` so clients free expired holds locally by server-offset time. |
| A-28 | Server time for the timer | Every REST response and socket ack include `serverTime`; client computes offset and uses `heldUntil − (now + offset)`. |
| A-29 | Job durability | `tasks` table (kind, dedupe_key UNIQUE, run_at, status, attempts, max_attempts, last_error, lease_until, payload). BullMQ `jobId = dedupe_key`. Rehydrator at worker start and every 15 s re-enqueues due tasks. Handlers are idempotent against PG state and take a row lease; stalled-job recovery covers `kill -9`. Exhausted attempts ⇒ `failed` (visible, restartable by finance). |
| A-30 | Retry policy | Exponential backoff base 2 s, max 8 attempts (shared constants), jitter; provider 429 honours `Retry-After`. |
| A-31 | Mass-cancel rate | Worker-side Redis Lua token bucket at 15 req/s (under the stub's 20) shared by all worker copies, plus 429/503 backoff. Idempotency-Key on every refund call makes retries safe. Refund rows (one per order) are created in the same txn that flips the event to `cancelled`, so progress is accurate from the first instant and a re-run of "cancel" is a no-op. Full 10 000-order run takes ~12 min (not in per-commit CI; scripted for ACC-11, a 500-order variant is in CI). |
| A-32 | Reports | Maintained rollups `sales_hourly(event_id, zone_id, hour, tickets, gross, fees, refunds)` and `ledger_daily(account_id, day, debit, credit)` updated in the same txn as the money change (and filled by the seed); reconciliation verifies rollups equal raw data. |
| A-33 | Pagination | Cursor/offset capped (`limit ≤ 100`, `page ≥ 1`); invalid ⇒ `400 VALIDATION_FAILED`. |
| A-34 | Error format | `{ error: { code, message, details?, requestId } }`; `code` is one of a shared enum; every endpoint declares `400/401/403/404/409/422/429/500` where relevant via the shared schema. Unhandled exceptions are mapped to `INTERNAL` with no internals leaked. |
| A-35 | Instances in tests | `docker-compose.test.yml` runs nginx with `network_mode: host` so the real client IP (127.0.0.N) reaches nginx (Docker's userland proxy would hide it). Documented in README. |
| A-36 | Throttling | Optional login throttle: per-IP and per-(account, IP) windows, all values in env; fail-open with documented in-process fallback when Redis is down; *no* hard per-account lock ⇒ attacker cannot lock a victim out from another IP. nginx overwrites `X-Forwarded-For` with `$remote_addr`; api trusts only the proxy CIDR from env. Hold/order/pay/queue/scan/socket are *not* IP-throttled; sockets have per-connection message caps. |
| A-37 | Generated client | `@hey-api/openapi-ts` from `apps/api/openapi.json` into `apps/web/src/shared/api/generated`. Spec emitted by `pnpm gen:openapi` (boots the Nest module graph with lazy infra, no network). CI regenerates and runs `git diff --exit-code`. |
| A-38 | Prisma + raw SQL | Prisma owns schema and migrations (`prisma migrate`), raw SQL migration files add triggers, partial unique indexes, deferred constraints, `app_now()`. Hot paths use `$queryRaw` with parameters; simple CRUD uses the Prisma client. |
| A-39 | Perf measurement | `perf.script` runs on the full seed through nginx, 50 warm calls, asserts p95 under budget. |
| A-40 | Test profile | `.env` copy with loose limits for tests (`LOGIN_THROTTLE_*`), `STUB_CHAOS` toggled per suite by a test-only control endpoint on the stub (only when `TEST_CLOCK_ENABLED`). |
| A-41 | Venue JSON schema | `{ name, city, zones:[{id,name,kind:'seated'|'general', capacity?, rows:[{label, seats:[{number,x,y}]}]}] }`; limits: ≤12 000 seats, ≤200 zones, body ≤ 2 MB (zod + body limit). Prices assigned per zone on the event (price set can be per seat group: organizer selects seats on the map ⇒ `price_tiers` + `seat→tier`). Blocked seats = `event_seats.status='blocked'`. |
| A-42 | Web theme/other | Tailwind, light theme only, no UI kit dependency beyond small `shared/ui`. |

---

## 4. Architecture

### 4.1 Stack (all from assignment)

Node 24 (host) / Node 22 LTS in images, pnpm workspaces, TypeScript strict; NestJS 11; Prisma 6 + raw SQL; PostgreSQL 16; Redis 7; BullMQ; Socket.IO 4 + `@socket.io/redis-adapter`; `nestjs-zod`; argon2; Next.js 15 / React 19 / TanStack Query / React Hook Form / Tailwind / next-intl; Vitest (+`unplugin-swc`); Playwright; nginx; own mail stub (`smtp-server`, `mailparser`, `nodemailer` in worker); `pdfkit`, `qrcode`, `jsqr`; `@hey-api/openapi-ts`; `eslint-plugin-boundaries`.

Defaults used where the assignment is silent: pnpm workspaces, argon2id, helmet, eslint flat config, GitHub Actions.

### 4.2 Folder tree

```
.
├─ ASSIGNMENT.md  CLAUDE.md  plan.md  README.md
├─ .env.example                      every variable, commented
├─ docker-compose.yml                full stack
├─ docker-compose.test.yml           test override (host-net nginx, test clock, loose limits)
├─ .github/workflows/ci.yml          typecheck, lint, client diff, unit, integration, build, e2e/adv
├─ apps/
│  ├─ api/
│  │  ├─ prisma/                     schema.prisma + migrations (SQL for triggers/constraints)
│  │  ├─ scripts/                    emit-openapi.ts
│  │  ├─ src/config/env.ts           only reader of process.env
│  │  ├─ src/main.ts app.module.ts
│  │  ├─ src/infra/                  prisma, pg pool, redis, clock, socket adapter factories
│  │  ├─ src/common/                 guards (auth, roles), filters (error format), pipes, interceptors (idempotency, requestId)
│  │  ├─ src/modules/
│  │  │  auth/ users/               register, login, refresh rotation, roles
│  │  │  venues/                    JSON upload + validation
│  │  │  events/                    CRUD, search, status machine, price tiers, blocking
│  │  │  seatmap/                   live map snapshot + deltas
│  │  │  holds/                     hold SQL, reclaim, limits
│  │  │  orders/                    orders, history, checkout
│  │  │  promos/                    promo codes
│  │  │  payments/                  provider client, webhook intake, state machine
│  │  │  payment-stub/              the stub provider (page, API, webhooks, chaos, 20 rps)
│  │  │  refunds/                   refund policy application, parallel safety
│  │  │  ledger/                    posting functions, reconciliation
│  │  │  tickets/                   issue, QR, transfer, my tickets
│  │  │  scanning/                  scan, counters
│  │  │  queue/                     virtual queue (PG truth + Redis cache)
│  │  │  waitlist/                  offers
│  │  │  realtime/                  Socket.IO gateway, rooms, catch-up
│  │  │  reports/                   organizer & finance reports
│  │  │  jobs-admin/                finance view/restart of tasks
│  │  │  testkit/                   test clock/chaos controls (only if TEST_CLOCK_ENABLED)
│  │  └─ test/{attacker,adversarial,integration,helpers}
│  ├─ worker/
│  │  ├─ src/config/env.ts main.ts worker.module.ts
│  │  ├─ src/infra/                  bullmq, redis, pg, rehydrator
│  │  ├─ src/handlers/               one file per task kind (expiry, payment-deadline, waitlist-offer, mass-cancel, refund, payout, email, pdf, webhook-delivery, reconcile, queue-admit)
│  │  └─ test/
│  └─ web/
│     ├─ app/                        Next route files only (thin)
│     ├─ pages/README.md             keeps Next off src/pages
│     ├─ src/{app,pages,widgets,features,entities,shared}/   FSD
│     ├─ src/shared/api/generated/   generated client (never hand-edited)
│     ├─ src/config/env.ts           server + NEXT_PUBLIC validated separately
│     ├─ messages/{uk,en,pl}.json
│     └─ e2e/                        Playwright specs
├─ packages/shared/src/
│  ├─ schemas/                       zod: auth, venue, event, hold, order, refund, errors
│  ├─ rules/                         constants (TTLs, limits, thresholds, retry)
│  ├─ pricing/                       fee, discount allocation, commission
│  ├─ refund/                        refund policy
│  ├─ state/                         order & event transition tables
│  └─ errors/                        error code enum + schema
├─ infra/
│  ├─ nginx/nginx.conf               2 api upstreams, ws upgrade, XFF overwrite
│  ├─ db/init/                       extensions (pg_trgm, btree_gist)
│  ├─ redis/redis.conf               no persistence needed (appendonly no)
│  └─ mailstub/                      SMTP receiver + inbox page
├─ scripts/{verify.sh, acceptance/}
└─ docs/{BUGS_FOUND.md, SECURITY-TESTS.md, MUTATION-CHECK.md}
```

### 4.3 Data model (main tables; all money `bigint` kopecks)

`users, refresh_tokens(family_id, revoked)`, `venues, zones, seats`, `events, event_zones(capacity,sold,held CHECK), price_tiers, event_seats(status free|held|sold|blocked, hold_order_id, hold_expires_at, reserved_for_offer_id)`, `seat_events(event_id, seq)`, `promo_codes(used_count CHECK <= limit)`, `orders, order_items, order_history`, `payments, payment_events(provider_event_id UNIQUE)`, `refunds(UNIQUE per ticket+kind)`, `tickets(qr_version, status, entered_at)`, `ticket_transfers, ticket_scans`, `accounts, ledger_transactions, ledger_entries (append-only)`, `payouts`, `tasks`, `idempotency_keys`, `queue_entries(seq, status)`, `waitlist_entries, waitlist_offers`, `emails(dedupe_key UNIQUE)`, `event_staff`, `sales_hourly, ledger_daily`, `stub_payments, stub_refunds, stub_webhooks`, `test_clock`, `seed_state`.

### 4.4 Data flow

```
 browser ──HTTP/WS──► nginx ──round-robin──► api-1 / api-2 ──► postgres (truth)
                         │                      │  ▲              ▲
                         └──► web (Next SSR)    │  │ pub/sub      │ tasks, ledger
                                                ▼  │              │
                                              redis ◄── BullMQ ──► worker × N ──► mail stub (SMTP)
                                         (disposable: queue cache,                └─► payment stub (HTTP via api)
                                          bullmq, socket adapter,
                                          rate-limit buckets)
```
- **Write path:** api transaction in PG (state + ledger + `seat_events` + `tasks` rows) → commit → best-effort publish via Socket.IO Redis adapter and BullMQ add. If either publish is lost, the rehydrator (tasks) or the client catch-up (`seat_events`) repairs it.
- **Rehydration:** worker on boot and every 15 s: `SELECT … FROM tasks WHERE status IN ('pending','running') AND run_at <= app_now() + 30s` → `queue.add(jobId = dedupe_key)`. After `FLUSHALL` BullMQ is empty; the next tick restores everything; queue cache is rebuilt from `queue_entries`.
- **Ledger:** postings are SQL functions called inside the business txn; trigger rejects UPDATE/DELETE; deferred constraint trigger checks `SUM(amount)=0` per transaction.

### 4.5 Ledger scheme (preview for README)

Accounts: `provider_cash` (asset), `organizer_payable:{id}` (liability), `service_fee_revenue`, `commission_revenue`, `payout_cash`.  Entries signed (debit +, credit −).
- Payment succeeded (price P after promo, fee F): `provider_cash +P+F`, `organizer_payable −P`, `service_fee_revenue −F`.
- Refund (R of price, optional fee Rf): `organizer_payable +R`, `service_fee_revenue +Rf`, `provider_cash −(R+Rf)`.
- Event cancelled: per-order refund of P+F (same posting as refund, kind=cancel).
- Payout (net N = Σsales − Σrefunds, commission C = floor(8%·N), payout N−C): `organizer_payable +N`, `commission_revenue −C`, `payout_cash −(N−C)`.
- Promo: discount never posted as an entry (it is a price reduction; P is already net).

### 4.6 Hold SQL (preview)

One transaction: `pg_advisory_xact_lock(user, event)` → limit check (counts active holds + paid tickets) → `UPDATE event_seats SET status='held', hold_order_id=…, hold_expires_at=… WHERE (event_id, seat_id) IN (sorted ids) AND (status='free' OR (status='held' AND hold_expires_at <= app_now()))` and `rowcount = requested` else `ROLLBACK` (all-or-nothing) → zone counters → promo `UPDATE … WHERE used_count < limit` → `seat_seq` bump + `seat_events` rows. Constraints backstop: `CHECK`s, partial unique `tickets(event_seat_id) WHERE status IN ('valid')`, sorted lock order avoids deadlocks.

---

## 5. Env table

`S` = sensitive (no default; required; never logged). Non-sensitive have defaults in the app's `env.ts`. `.env.example` carries placeholders for every row.

| Variable | Purpose | S | Default | Used by |
| --- | --- | --- | --- | --- |
| NODE_ENV | mode | n | development | all |
| LOG_LEVEL | pino level | n | info | api, worker, web |
| POSTGRES_USER / POSTGRES_DB | compose DB init | n | tickets | compose |
| POSTGRES_PASSWORD | DB password | **y** | — | compose |
| DATABASE_URL | Prisma/pg connection (contains password) | **y** | — | api, worker, migrate |
| DB_POOL_MAX | pg pool size | n | 20 | api, worker |
| REDIS_URL | Redis connection | n (no auth in dev) | redis://redis:6379 | api, worker |
| API_PORT | listen port | n | 3001 | api |
| API_INSTANCE_ID | copy label (`api-1`/`api-2`), returned in `X-Api-Instance` | n | api-1 | api |
| API_PUBLIC_URL | base URL for stub redirects/webhooks/emails | n | http://localhost:8080 | api, worker |
| API_INTERNAL_URL | api URL for stub calls from worker/web SSR | n | http://nginx | worker, web |
| CORS_ORIGINS | allowlist | n | http://localhost:8080 | api |
| TRUSTED_PROXY_CIDRS | who may set client IP via XFF | n | 172.16.0.0/12,127.0.0.1/32 | api |
| BODY_LIMIT_BYTES | JSON body cap | n | 262144 | api |
| VENUE_UPLOAD_LIMIT_BYTES | venue JSON cap | n | 2097152 | api |
| JWT_ACCESS_SECRET | access token HMAC | **y** | — | api |
| JWT_REFRESH_PEPPER | refresh token hashing pepper | **y** | — | api |
| ACCESS_TTL_SECONDS / REFRESH_TTL_SECONDS | token lifetimes | n | 900 / 2592000 | api |
| QR_SIGNING_SECRET | QR HMAC | **y** | — | api, worker |
| STUB_WEBHOOK_SECRET | webhook HMAC shared with stub | **y** | — | api |
| STUB_CHAOS | chaos on/off | n | false | api (stub) |
| STUB_RPS_LIMIT | stub limit | n | 20 | api (stub) |
| STUB_CHAOS_MAX_DELAY_MS | webhook delay cap | n | 60000 | api, worker |
| PAYMENT_PROVIDER_URL | stub base URL used by payment client | n | http://nginx/stub | api, worker |
| WORKER_REFUND_RPS | worker-side refund call rate (<20) | n | 15 | worker |
| WORKER_CONCURRENCY | BullMQ concurrency | n | 10 | worker |
| WORKER_INSTANCE_ID | lease owner label | n | worker-1 | worker |
| REHYDRATE_INTERVAL_MS | rehydrator tick | n | 15000 | worker |
| RECONCILE_INTERVAL_MS | stuck-op reconciliation | n | 60000 | worker |
| SMTP_HOST / SMTP_PORT | mail stub target | n | mailstub / 1025 | worker, mailstub |
| MAIL_FROM | sender | n | tickets@example.test | worker |
| MAILSTUB_HTTP_PORT | inbox page | n | 8025 | mailstub |
| LOGIN_THROTTLE_IP_MAX / _ACCOUNT_IP_MAX / _WINDOW_SECONDS | optional login limiter (loose in test profile) | n | 20 / 5 / 60 | api |
| WS_MAX_MSGS_PER_SEC | per-socket inbound cap | n | 20 | api |
| TEST_CLOCK_ENABLED | registers test clock/chaos endpoints; **false** in prod profile | n | false | api |
| SEED_ON_START | run seed in `migrate` service | n | true | migrate |
| SEED_SCALE | `full` (50k/30/2000/1M) or `small` (CI) | n | full | migrate |
| SEED_USER_PASSWORD | shared password of seed accounts (documented) | **y** (placeholder in example) | — | migrate |
| WEB_PORT | Next port | n | 3000 | web |
| NEXT_PUBLIC_API_BASE | browser REST base | n | /api | web |
| NEXT_PUBLIC_WS_URL | browser WS base | n | / | web |
| DEFAULT_LOCALE | fallback locale | n | uk | web |
| NGINX_PORT | published port | n | 8080 | compose |

---

## 6. Threat model

**Assets:** seats (inventory), money ledger, ticket validity (QR), buyer PII/orders, organizer data, queue fairness, job integrity, availability.
**Attackers:** (a) anonymous internet client; (b) malicious buyer (scalper, IDOR, double-spender); (c) malicious organizer (reads buyers, touches others' events); (d) rogue scanner; (e) rogue finance; (f) network attacker forging webhooks/XFF; (g) infrastructure faults (worker kill, Redis flush, duplicates) — treated as adversaries for invariants.

| # | Abuse case | Mitigation | Test |
| --- | --- | --- | --- |
| T-01 | Brute-force/credential-stuffing login | per-IP and per-(account,IP) throttle in Redis (Lua), generic error | `auth.adv` |
| T-02 | User enumeration via login/registration | identical body/status, equalised timing (dummy hash) | `auth.adv` |
| T-03 | Token tampering, alg none, wrong secret, expired, nbf, missing claims, other user's token, refresh reuse, replay after logout | strict verify (HS256 pinned), refresh family revocation | `auth.adv` |
| T-04 | One IP floods limiter, innocent IPs locked out | key by real IP; Redis keys per IP; flood from IP X while Y/Z keep 2xx + p95 budget | `limiter.adv` |
| T-05 | Spoofed XFF/X-Real-IP/Forwarded, rotating values, framing victim IP | nginx overwrites XFF, api trusts only proxy CIDR | `limiter.adv` |
| T-06 | Limiter off-by-one/window edge/concurrency race, recovery; two api copies share limit | atomic Lua; flood through nginx, total ≤ limit | `limiter.adv` |
| T-07 | Redis down/slow behind limiter | documented fail-open + fallback; API does not hang | `limiter.adv` (stop/pause redis) |
| T-08 | Unbounded limiter keys (many IPs), IPv6/IPv4-mapped duplicates | TTL on every key; normalise to one bucket | `limiter.adv` |
| T-09 | Victim account lockout by attacker | no hard per-account lock (A-36) | `limiter.adv` |
| T-10 | Missing auth on any route | global guard default-deny + `@Public()` allowlist; test iterates OpenAPI route table | `routes.adv` |
| T-11 | IDOR on orders/tickets/events/refunds/venues/promos | ownership checks in SQL (`WHERE owner = $user`), 404 not 403 for foreign ids | `idor.adv` |
| T-12 | Role escalation/mass assignment (`role`, `userId`, `price`, `status` in bodies) | zod `.strict()` schemas | `idor.adv`, `input.adv` |
| T-13 | Scanner touching money or other events; finance changing events; organizer reading buyer PII | role guards + per-resource checks | `routes.adv` |
| T-14 | Double-spend/double-submit, parallel registration with same email, parallel refresh | idempotency, unique indexes, row locks | `auth.adv`, `idempotency.adv` |
| T-15 | Oversell via 200 concurrent holds | DB locks + constraints (§4.6) | `hold-race.adv` |
| T-16 | Limit bypass via parallel orders / different tabs / many accounts of one user | advisory lock per (user,event); counters with CHECK | `limits-race.adv` |
| T-17 | Promo over-redemption, release exploits | atomic UPDATE with CHECK, release only unpaid | `promo-race.adv` |
| T-18 | Forged/modified webhook; replay; reorder; duplicate | HMAC constant-time, timestamp tolerance, `provider_event_id UNIQUE`, monotonic payment state | `payment-webhooks.adv` |
| T-19 | Parallel refund requests over-refund | order row lock + unique per ticket + CHECK sum | `refund-race.adv` |
| T-20 | Idempotency-Key replay with different body; key reuse across users | stored request hash; key scoped to user+route | `idempotency.adv` |
| T-21 | Forged/tampered QR, old QR after transfer/refund, same QR at two gates | HMAC + version + atomic scan UPDATE | `scan.adv` |
| T-22 | Queue cheating: many tabs/accounts-per-IP reconnects, header spoofing, jump order, flood joiners from one IP | one entry per account (UNIQUE), seq assigned by PG, cap enforced in SQL; no IP throttle on queue | `queue.adv` |
| T-23 | Socket abuse: unauthenticated connect, subscribing to others' rooms, flood | handshake JWT, server-chosen rooms, per-socket cap, event-room authz for organizer rooms | `socket-authz.adv` |
| T-24 | SQLi, NoSQL operators, XSS (stored/reflected), traversal, null bytes, unicode tricks, huge/deep JSON, proto pollution, wrong content-type, duplicate keys, huge arrays | zod, parameterised SQL, body limit 413, output encoding, `Object.create(null)` parsing guard | `input.adv`, `fuzz.adv` |
| T-25 | Header injection (CRLF), odd methods, bad pagination, CORS, missing security headers, leaked stack traces | helmet, CORS allowlist, global exception filter | `headers.adv` |
| T-26 | Slowloris, many connections, keepalive abuse | nginx timeouts + header/body limits; api `server.headersTimeout`; check unrelated user latency | `resource.adv` |
| T-27 | Redis wipe during holds/queue/jobs | PG truth, rehydrator, queue rebuild | `redis-flush.adv` |
| T-28 | Worker kill mid-task; two workers same task | leases + idempotent handlers + stalled recovery | `worker-kill.adv`, `worker-multi.adv` |
| T-29 | Stub abuse: >20 rps; chaos 429/503 losing refunds | global bucket; Idempotency-Key refunds, retry | `stub-ratelimit.adv`, `mass-cancel.int` |
| T-30 | Test-only endpoints in prod | route registered only if `TEST_CLOCK_ENABLED`; test asserts 404 in prod profile | `routes.adv` |
| T-31 | Secrets in repo/logs | zod-required secrets, redaction, CI grep | CI `no-secrets` step, `logs.int` |
| T-32 | Ledger tampering (UPDATE/DELETE, unbalanced) | triggers + deferred constraint; test attempts raw tampering | `ledger.int` |

---

## 7. Test plan

**Unit (Vitest, no IO):** pricing (fee min 20 ₴, rounding, promo allocation, commission floor, property tests: sum of allocations = total), refund policy boundaries (exactly 7 d, 2 d, ±1 s, cancel, reschedule 14 d ±1 s), state machines (every illegal transition rejected), QR sign/verify (bit flips), venue schema, hold timer, seat-map reducer (out-of-order, stale), format (3 locales: money `1 234,50 ₴`, plurals, dates), scanner reason mapping, FSD boundary lint fixtures.

**Integration (real PG + Redis, Nest app in-process or booted):** constraints (CHECK, partial unique, append-only ledger, deferred zero-sum), holds/limits/promo (including sequential edge cases), orders and history, pay → ledger, late payment both branches via test clock, refunds all tiers, transfer rules, scan reasons, waitlist chain with clock, payout, reports vs raw data, rollup consistency, jobs retry/backoff/exhaust, rehydration after `FLUSHALL`, 500-order mass-cancel in chaos, error-format of every endpoint, seed counts and balanced ledger (small seed).

**Adversarial (`*.adv`, real stack via `docker-compose.test.yml`: nginx host-net → 2×api + 2×worker + PG + Redis + stub + mail stub; attacker harness in `apps/api/test/attacker/` with `client({sourceIp})`, `flood`, `slowRequest`, `raw`, `timed`).** Concrete attacks: 200 same-seat holds; 10×2-ticket orders at limit 6; 150 promo applies at limit 100; parallel refunds (2 and 50); webhook duplicate/reorder/delay/bad-signature/replay; stub 25 rps burst; `kill -9` worker during 500-order cancel with 3 copies; `FLUSHALL` mid-sale + restart; 1 000 queue joiners across both copies with periodic max-active sampling; reload/second-tab same account; waitlist chain with clock; transfer + old QR; same ticket scanned from 2 gates ×50; forged QR corpus; IDOR matrix (every role × every resource × direct and socket); route-table iteration for 401/403; limiter suite per the skill (flood A, victims B/C p95, spoofed headers, rotation, boundary, concurrency, Redis down, key TTL, IPv6, multi-copy); auth suite (token attacks, enumeration timing, refresh reuse, races); input suite (injection corpus, 413, CRLF, methods, pagination, proto pollution); resource suite (slowloris with others unaffected); socket suite (unauth, foreign rooms, flood, cross-copy delivery <1 s, catch-up).
**Rules for all:** per-test users/IPs/keys, polling with timeouts, `assertLedger()` after every money scenario, report in `docs/SECURITY-TESTS.md`, bugs in `docs/BUGS_FOUND.md`.

**E2E (Playwright, full compose):** DEL-10…13, plus search-in-URL reload/Back, i18n, keyboard checkout, clock-skew timer, seat-map perf probe, organizer pricing and cancel progress.

**Scripts:** `scripts/acceptance/01…20`, `perf.script` (p95), `verify.sh` (typecheck+lint+gen check+unit+int+build).

**Mutation check (at C11):** disable (1) login/IP limiter, (2) the global auth guard, (3) the hold `rowcount` check and one zod validator → corresponding tests must fail; record in `docs/MUTATION-CHECK.md`, restore.

---

## 8. Commit plan (11 commits; each CI-green, ships its tests)

| # | Commit | Contents | Tests shipped |
| --- | --- | --- | --- |
| C1 | `chore: repo scaffold, env, compose skeleton, shared skeleton, CI` | `git init`, pnpm workspace, TS/ESLint/Vitest base, `.env.example`, `docker-compose.yml` (postgres, redis), `packages/shared` skeleton (error codes, constants, money type), `env.ts` pattern per app (empty app shells compile), `.github/workflows/ci.yml` incl. client-diff step (no-op until C5, explicit message), `scripts/verify.sh`, `docs/` stubs | env parse/fail-fast tests, shared smoke, lint-rule fixtures |
| C2 | `feat(db): schema, migrations, ledger, constraints, shared rules` | Prisma schema + raw SQL migrations (all tables §4.3, triggers, deferred zero-sum, append-only, `app_now()`), shared pricing/refund/state/QR-format/schemas | pricing/refund/transitions unit; `schema.constraints.int`, `ledger.int`, `clock.int` |
| C3 | `feat(db): seed and read-path indexes` | set-based seed (full + small), `migrate` service, indexes, rollup fill | `seed.int`, query-plan/latency check on small + full |
| C4 | `feat(infra): redis, bullmq, task table, rehydrator lib, queue store, rate-limit lib` | Redis client factories, Lua limiters, `tasks` API, rehydrator function, queue cache with PG rebuild | `rehydrate-after-flush.int`, `limiter-lua.int`, `queue-rebuild.int` |
| C5 | `feat(api): core — auth, roles, venues, events, holds, orders, promos` | modules, error format, idempotency interceptor, OpenAPI emit + committed `openapi.json`, CI client-diff becomes active, login throttle | auth/holds/limits/promo/events int; `hold-race`, `limits-race`, `promo-race`, `auth`, `input`, `routes` adv (booted server, no nginx yet) |
| C6 | `feat(payments): payment stub and mail stub` | `payment-stub` module (page, HMAC webhooks, chaos, refunds, status API, 20 rps), `infra/mailstub`, compose service for mailstub | `stub-*.int`, `webhook-signature.int`, `stub-ratelimit` |
| C7 | `feat(api): money and ticket flows` | payment intake + state machine, ledger postings, late payment, refunds, reschedule/cancel (creating refund rows), tickets/QR/transfer/scan, waitlist, queue endpoints, realtime gateway, reports, reconciliation, jobs-admin | `late-payment`, `refund*`, `transfer`, `scan`, `waitlist`, `queue`, `reports`, `reconcile`, `realtime` int |
| C8 | `feat(worker): background tasks` | handlers (expiry, deadline, waitlist, mass cancel, refund, payout, email, PDF, webhook delivery, reconcile, queue admit), rehydrator wiring, leases, retry/backoff | `jobs-*.int`, `mass-cancel.int`, `payout.int`, `ticket-email.int`, `hold-expiry.int`; worker kill/multi in C10 |
| C9 | `feat(web): Next.js app (FSD), i18n, generated client` | FSD layers, boundary lint, generated client + CI check, pages for all roles, canvas seat map w/ keyboard, timer, queue page, scanner, finance, locales | `format.unit`, hold-timer/reducer/scanner unit, FSD lint fixtures, component flow tests |
| C10 | `feat(infra): nginx, two api copies, full compose; cross-stack adversarial, e2e` | nginx.conf, compose with `api-1/api-2`, worker, web, mailstub; `docker-compose.test.yml`; full adversarial suite on real stack; Playwright specs DEL-10…13 + others; CI e2e job; acceptance scripts 01–19 | all `*.adv`, `*.e2e`, `perf.script`, `mass-cancel-10k.script` |
| C11 | `docs: README, security report, bugs, mutation check` | README (all sections, tables, decisions), `docs/SECURITY-TESTS.md`, `BUGS_FOUND.md`, `MUTATION-CHECK.md`, acceptance results in plan.md, final clean-checkout run | docs-vs-behavior checks (`readme.test`: tables generated from shared state machines match README) |

Never push. Conventional Commits; footer per attribution rule. Before every commit: typecheck, lint, test, build (+ generated client diff once active) all green; tree contains only that block.

---

## 9. Risks to watch

1. Hot `events.seat_seq` row serialises holds per event → keep it the last statement of the txn; measure under ACC-4/13.
2. Seed time/size (1M tickets, ~2M ledger rows) → set-based SQL, `COPY`-style batches; `SEED_SCALE=small` for CI.
3. 10 000-order cancel takes ~12 min at 15 rps → scripted acceptance, 500-order CI variant.
4. Docker source-IP masking → host-net nginx in the test override (A-35).
5. Canvas seat map accessibility → separate roving-focus layer + `aria-live`.
6. Email exactly-once is impossible over SMTP → deterministic Message-ID + stub dedupe (A-21).

---

## 10. Progress checklist

- [x] C1 scaffold + CI
- [ ] C2 db schema, ledger, constraints, shared rules
- [ ] C3 seed + indexes
- [ ] C4 redis infra
- [ ] C5 api core
- [ ] C6 payment stub + mail stub
- [ ] C7 api money/ticket flows
- [ ] C8 worker
- [ ] C9 web
- [ ] C10 nginx + full compose + adversarial + e2e + perf
- [ ] C11 README + docs + mutation check

**Acceptance results** (filled during Phase 1): ACC-1 ☐ · 2 ☐ · 3 ☐ · 4 ☐ · 5 ☐ · 6 ☐ · 7 ☐ · 8 ☐ · 9 ☐ · 10 ☐ · 11 ☐ · 12 ☐ · 13 ☐ · 14 ☐ · 15 ☐ · 16 ☐ · 17 ☐ · 18 ☐ · 19 ☐ · 20 ☐

**Finish line:** matrix all pass · 20 acceptance run · CI green per commit · README complete · clean-checkout `typecheck lint test build adv` · `docker compose up` smoke through nginx · mutation check done · tree clean.
