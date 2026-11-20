# Concert ticket service

Seat selling with live seat maps, a virtual queue, a double-entry ledger, background jobs and an internal payment stub.
Stack: PostgreSQL 16 (+ Prisma for schema, raw SQL where locks matter), Redis 7 + BullMQ, NestJS 11 (`api` x2 and `worker`),
Socket.IO with a Redis adapter, Next.js 15 / React 19, nginx, a mail stub. Languages: `uk`, `en`, `pl`.

Layout: `apps/api`, `apps/worker`, `apps/web`, `packages/shared` (zod schemas, rules, pricing, refund maths, status tables; no IO),
`packages/platform` (IO shared by api and worker), `packages/testkit` (test harness), `infra/{nginx,db,redis,mailstub}`, `docs/`, `plan.md`.

## Run

```bash
cp .env.example .env
docker compose up --build
```

Nothing else is needed: the one-shot `migrate` service applies migrations and then the seed (50 000 users, 30 halls with one of
10 000 seats incl. a dance floor, 2 000 events, 1 000 000 sold tickets; about 2 minutes the first time). Open `http://localhost:8080`.

| What | Where |
| --- | --- |
| Shop | `http://localhost:8080` |
| Swagger | `http://localhost:8080/docs` |
| Payment stub (hosted page) | `http://localhost:8080/stub/pay/<id>` |
| Mail inbox | `http://localhost:8025` |

Seed logins, password is `SEED_USER_PASSWORD` from `.env` (default `Passw0rd-dev-seed`): `buyer<N>@example.test`, `organizer<N>@example.test`,
`scanner<N>@example.test`, `finance<N>@example.test`. Registration creates buyers only.

## Tests

```bash
pnpm install --frozen-lockfile
pnpm verify          # install, typecheck, lint (incl. FSD boundaries), secrets check, build, generated client == schema, unit tests
pnpm test:int        # integration + adversarial tests: real Postgres + Redis (docker compose up -d postgres redis), real listening servers
pnpm stack:up        # full stack in its test profile (host-network nginx, test clock, loose throttles)
pnpm --filter @ticketing/api test:stack   # attacks against the deployed stack through nginx
pnpm e2e             # Playwright against the stack (two phases: real rules, then a queue limit of 1)
pnpm --filter @ticketing/api test:acc     # long acceptance scenarios on the stack (mass cancel with kill -9, Redis wipe, ...)
```

CI (`.github/workflows/ci.yml`) runs the same on every commit. Reports: `docs/SECURITY-TESTS.md` (attack table),
`docs/BUGS_FOUND.md` (bugs the tests found), `docs/MUTATION-CHECK.md`, acceptance results in `plan.md`.

## How seat holding works

* A hold is one SQL transaction. It takes a shared advisory lock on the event (so a cancellation can take it exclusively), a per
  (user, event) advisory lock (so one buyer's parallel orders are serialised and the per-person limit cannot be raced), then claims
  seats with `UPDATE event_seats SET status='held' ... WHERE status='free' OR hold expired` and checks the affected row count.
  Seat, dance-floor (`CHECK (sold + held <= capacity)`) and promo (`CHECK (used_count <= usage_limit)`) counters are conditional updates,
  so overselling is impossible regardless of how many requests race.
* The hold lasts 10 minutes from the first seat and is never extended. Expiry is **lazy and exact**: every statement judges
  `hold_expires_at <= app_now()` (the database clock), so a seat is free the instant it expires, with or without a worker. The worker
  additionally releases expired orders (task `hold_expire`, plus a 20 s sweep as safety net) which frees promo uses and tells the owner.
* `app_now()` is `clock_timestamp()` plus an offset from the one-row `test_clock` table; a test-only endpoint (only with
  `TEST_CLOCK_ENABLED`) moves it, which is how 10-minute, 30-minute, 7-day and 14-day rules are tested.
* Every state-changing request takes an `Idempotency-Key`; the key is committed in the same transaction as its effect.

## Ledger

Money is integer kopecks. Every movement is a balanced set of `ledger_entries` (debits = credits) written by SQL functions, once per
(kind, reference) - replaying a payment, refund or payout posts nothing new. Rows are append-only (triggers reject UPDATE/DELETE) and a
deferred constraint rejects an unbalanced transaction at commit.

| Event | Entries |
| --- | --- |
| Payment received | `provider_cash` +(price+fee); `organizer_payable:<org>` -price; `service_fee_revenue` -fee |
| Refund | `organizer_payable` +price part; `service_fee_revenue` +fee part (fee returned with the ticket); `provider_cash` -amount |
| Event cancelled | one full refund per order through the refund path (fee included) |
| Payout (3 days after the event) | `organizer_payable` +(sales - refunds); `commission_revenue` -commission (8 % of net sales, floored); `payout_cash` -payout |

Service fee per ticket: `max(20.00 UAH, 5 %)`, rounded half up. Refunds: more than 7 days before the event 100 % of the ticket price,
2-7 days 50 %, less than 2 days none; the fee is returned only when the ticket is returned in full. After a reschedule there is a 14 day
full-refund window.

## Background jobs

Postgres is the source of truth; BullMQ is only the executor. Every scheduled task is a row in `tasks`
(`kind`, unique `dedupe_key`, `run_at`, `status`, `attempts`, lease). A rehydrator re-adds due rows to BullMQ at worker start and every 15 s,
so after `FLUSHALL` or a Redis restart nothing is lost. Every handler re-checks due-ness against the database clock; a stale, early or
duplicate job simply fails its claim.

| Task | Queued when | Effect |
| --- | --- | --- |
| `hold_expire` | a hold is created | release an unpaid order at expiry |
| `waitlist_expire` | an offer is made | offer expires after 30 min, next person gets it |
| `refund_execute` | a refund is requested / event cancelled | call the provider with the refund id as Idempotency-Key |
| `mass_cancel_notice` | an event is cancelled | progress and organizer/buyer notices |
| `email` | tickets issued, transfer, refund, reschedule | mail with PDF tickets; deterministic Message-ID, `emails.dedupe_key UNIQUE` |
| `event_finish` | event creation | status `finished` after the date |
| `payout` | event finished | posts once (`payouts.event_id` unique), waits for outstanding refunds |

Retries: exponential backoff from 2 s with jitter, 8 attempts; provider `429` is honoured through `Retry-After` and does not burn attempts.
Exhausted tasks become `failed`, are visible to finance (`/api/finance/jobs`) and can be restarted. A claim takes a 30 s lease with
heartbeat, so a `kill -9` leaves a task another worker picks up after the lease; several worker copies never run one task twice.
Periodic loops: queue admission (1 s), expiry sweep (20 s), provider reconciliation (60 s).

## Virtual queue and mass cancellation

**Queue.** Entries live in `queue_entries` (unique per event and user, order = a Postgres sequence); Redis only caches positions and is
rebuilt from Postgres when empty. Below 500 simultaneous claimants people walk in, but never more than 200 may be selecting at once; the
500-claimant threshold turns the queue on (also earlier if all 200 slots are full). Admission runs under a per-event advisory lock from both
api copies and the worker, so the cap holds across copies. An admitted person who does not start selecting within 5 minutes loses the slot
to the next. Reloading or a second tab returns the same place.

**Mass cancel.** One transaction under the exclusive event lock flips the event to `cancelled` (sales and transfers stop at once),
invalidates tickets and creates one refund row plus one task per order, so progress is exact from the first instant and a second cancel is
a no-op. Workers drain the tasks; refund calls take evenly spaced slots (`1000/15 ms`, shared through Redis) under the stub's 20 req/s and a
`429` is simply retried. Progress is shown live (`/organizer/events/<id>`).

## Events through two api copies

Seat changes write `seat_events` with a per-event sequence number in the same transaction. After commit the changed event is published through
the Socket.IO Redis adapter, so a client connected to either copy receives it. A reconnecting client sends its last sequence and receives the
missed changes (or a fresh snapshot). Rooms are chosen by the server (`user:`, `event:`, `admin:`); every connection is authenticated, so
queue positions and personal notices reach only their owner. The hold timer uses the server clock (every response carries `serverTime`).

## Status tables

Both are generated from `packages/shared/src/state/transitions.ts`, which the database guard triggers mirror.

**Order**

| From | To | Who | Note |
| --- | --- | --- | --- |
| holding | awaiting_payment | buyer | checkout started, payment created |
| holding | expired | buyer, system | abandoned or hold timer ran out |
| awaiting_payment | expired | system | hold timer ran out before payment |
| awaiting_payment | paid | system | succeeded payment confirmed (webhook or reconciliation) |
| expired | paid | system | late payment and the seats were still free |
| expired | refunded | system | late payment and the seats were taken: full automatic refund |
| awaiting_payment | refunded | system | payment arrived after the event was cancelled |
| paid | partially_refunded | buyer, finance, system | some tickets refunded |
| paid | refunded | buyer, finance, system | all tickets refunded (also event cancellation) |
| partially_refunded | partially_refunded | buyer, finance, system | another subset refunded |
| partially_refunded | refunded | buyer, finance, system | remaining tickets refunded |

**Event**

| From | To | Who | Note |
| --- | --- | --- | --- |
| draft | on_sale | organizer | published (purchases open at the sales start time) |
| draft | cancelled | organizer | discarded before publication |
| on_sale | sold_out | system | no seats left |
| sold_out | on_sale | system | a seat was released |
| on_sale, sold_out | rescheduled | organizer | new date, buyers notified, 14 day full-refund window |
| rescheduled | rescheduled | organizer | rescheduled again, window restarts |
| on_sale, sold_out, rescheduled | cancelled | organizer | sales stop at once, all orders refunded in the background |
| on_sale, sold_out, rescheduled | finished | system | event date passed |
| finished | paid_out | system | payout 3 days after the event |

## Database indexes and constraints (the ones that carry correctness)

* `event_seats (event_id, seat_id)` primary key and a partial index on held seats by expiry; `event_zones CHECK (sold + held <= capacity)`.
* `promo_codes CHECK (used_count <= usage_limit)`; `queue_entries UNIQUE (event_id, user_id)`.
* `refund_items` unique active index per order item (no double refund); webhook events unique by provider event id (exactly-once);
  `payouts` unique per event; `emails` and `tasks` unique `dedupe_key`; idempotency keys unique per user and key.
* `ledger_entries` append-only triggers, deferred zero-sum constraint, unique `(kind, ref_id)` per transaction.
* Guard triggers enforce the order and event transition tables above; `tickets` scan is a single conditional `UPDATE` (one winner at two gates).
* Search/report indexes: `events (status, starts_at)`, trigram on title, `sales_hourly (event_id, hour)`, `ledger_daily (account_id, day)` (maintained rollups keep reports under 500 ms).

## Decisions on ambiguous points

The full list with reasons is `plan.md` (assumptions A-01 ... A-52, deviations D-01 ... D-09). The ones that change behaviour:

* README language English; one role per user; scanner is bound to events by the organizer (by email); registration creates buyers only.
* Service fee `max(20 UAH, 5 %)` per ticket, commission 8 % of net sales floored; a promo discount reduces the ticket price only and is funded by the organizer.
* Per-person limit (default 6) counts active holds plus paid, non-refunded tickets across orders; fully refunded tickets stop counting.
* Hold: 10 minutes from the first seat, never extended; payment must finish inside it. A payment after expiry re-acquires the places (and the promo use) or is refunded in full automatically.
* Refund is per ticket; a reschedule gives 14 days of full refunds, clipped to the new event start.
* Waitlist: one offer at a time, valid 30 minutes, the seat is reserved for the offered person.
* Transfer needs an existing account (by email); ownership moves at once and the QR version is bumped, so the old code is refused.
* The payment stub is a module inside `api` (`/stub`), so compose matches the required services; it signs webhooks (HMAC), delivers them from a durable outbox, and its chaos mode (duplicate, delayed, out-of-order, lost, every 10th request `503`) is deterministic. The 20 requests per second limit is global across both api copies (Redis sliding window, fail-closed).
* Optional login throttling (all limits in env, fail-open when Redis is down, no hard account lock so nobody can lock a victim out); hold, order, payment, queue, scan and realtime flows are not IP-throttled.
* Time: all rules use the database clock `app_now()`, mockable in tests.
* Emails are plain English text plus a PDF per order; exactly-once over SMTP is impossible, so a deterministic Message-ID and dedupe in the mail stub make duplicates invisible.
* The 10 000-order cancel takes about 12 minutes at 15 refunds per second; CI runs a 500-order version, the acceptance suite scales it with `ACC_ORDERS`.
