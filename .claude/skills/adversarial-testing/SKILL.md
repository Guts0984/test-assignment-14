Adversarial testing
Goal: find bugs and security holes, not confirm the happy path. Think like an attacker. Every test must be able to fail.

Stack note
Postgres, Redis and nginx below are the default stack. Use whatever the assignment's stack actually is. If a component is absent (for example no Redis, so the limiter store is in-memory or the db), run every scenario against the real replacement. Skip a scenario only if it has no equivalent, and say so in docs/SECURITY-TESTS.md. "Redis down" becomes "the limiter's store is unavailable, slow or reset", for example an app restart wiping in-memory counters. If there is no reverse proxy, test the app's own trusted-proxy and client-IP logic directly.

Setup
Bring up real dependencies: postgres and redis (docker compose or testcontainers). Never mock the db or redis here.
Start the real API as an actual listening server on an ephemeral port, with the same config as production (.env.example values). For IP and rate-limit tests, put real nginx in front, exactly as deployed.
Build a small attacker harness in apps/api/test/attacker/ as functional helpers:
client({ sourceIp }) sends real HTTP requests with a distinct source IP. On Linux all of 127.0.0.0/8 is loopback, so bind per client with localAddress: '127.0.0.N', or use docker network containers.
flood({ client, path, rps, durationMs }), slowRequest(...), raw(...) for malformed bytes.
timed(fn) to measure latency.
Rate limiter: the key scenario
Attacker A (IP X) floods a limited endpoint far above the limit.
While the flood runs, innocent users B and C (IPs Y, Z) call the same endpoints at normal speed.
Assert BOTH: A gets 429 after the limit, with a correct Retry-After, AND B and C keep receiving 2xx with p95 latency under a stated budget. One IP must never take down everyone else.
Also test:
Spoofed X-Forwarded-For, X-Real-IP and Forwarded headers from an untrusted client must NOT evade A's limit and must NOT put victim IP Y into A's bucket (no way to frame or lock out another IP).
Rotating spoofed header values on every request cannot reset the counter.
Window boundaries: burst at the edge of a window, off-by-one at exactly the limit, and recovery after the window.
Concurrency: N parallel requests at once cannot exceed the limit (atomicity, no check-then-set race).
Per-account limits: attacker locking out a victim's account by failing logins from another IP. Assert the documented behavior and that the victim can still log in or recover.
Redis down or slow: behavior matches the documented fail-open or fail-closed choice, and the API does not hang or crash.
Limiter memory and key growth: many unique IPs do not leak unbounded keys (TTL is set).
IPv6 and IPv4-mapped addresses are normalized to one bucket.
Multi-instance, queues and money
Run two api copies behind nginx plus the worker (two workers for job tests). Rate limits must hold across copies: flood through nginx and assert the total allowed never exceeds the limit, not the limit per copy.
Redis wipe test: during active holds, queued users and pending jobs, run FLUSHALL (and also restart Redis). Assert that no order, money or queue position is lost, and that the system recovers on its own (jobs and the virtual queue are rebuilt from Postgres).
Concurrency on scarce resources: hundreds of parallel requests for the last item or seat must never oversell or double book. Compare counts in Postgres afterwards.
Idempotency: replay the same request with the same key, and process the same job twice or on two workers at once. The effect must happen exactly once (one refund, one payout, one email).
Ledger invariants: after every scenario, total debits equal total credits, no row is updated or deleted, and no balance goes negative where it must not.
Expiry and timing: holds expire exactly once, an order paid at the moment its hold expires resolves deterministically, and mass cancellation with refunds is safe if the worker crashes midway and restarts.
Virtual queue: one client cannot hold many positions, cannot jump the queue by reconnecting or spoofing headers, and a flood of joiners from one IP does not block the others.
Socket.IO: unauthenticated connections are rejected, a client cannot subscribe to another user's rooms, and message floods are throttled. Events reach clients connected to either api copy.
Auth
Brute force and credential stuffing hit lockout or throttling. Failed-login responses are identical for a wrong password and an unknown user (body, status and timing within tolerance).
Token attacks: tampered payload, alg: none, wrong secret, expired, not-yet-valid, missing claims, a token for another user, refresh-token reuse after rotation (must revoke the whole family), replay after logout.
Privilege: IDOR (user A reads or edits user B's resources), role escalation, mass assignment (extra fields like role, id, isAdmin in bodies), missing-auth on every route (iterate over the route table and assert each protected route returns 401 without a token).
Race conditions: parallel registration with the same email, double-spend or double-submit, parallel refresh.
Input and transport
SQL injection strings, NoSQL operators, XSS payloads (stored and reflected), path traversal, null bytes, unicode normalization tricks, very long strings, deeply nested JSON, prototype pollution (**proto**, constructor), wrong content-types, malformed JSON, duplicate keys, huge arrays.
Oversized body returns 413. Header injection (CRLF). Unexpected HTTP methods. Invalid or negative pagination values.
Resource exhaustion: slowloris-style slow headers or body, many open connections, huge numbers of keep-alive requests. The server must stay responsive for other clients.
CORS: disallowed origin gets no Access-Control-Allow-Origin. Security headers present. No stack traces, SQL errors or internal paths in error bodies.
Rules for every test
Assert on status, body shape, headers, side effects in db/redis, AND that unrelated users are unaffected.
Deterministic: poll with a timeout, never fixed sleeps. Each test uses its own IPs, users and keys, so tests run in parallel without interfering.
Mutation check (mandatory): after the suite is green, temporarily disable the limiter, the auth guard, and one validator. The matching tests MUST fail. Restore the code. Note the check in docs.
When a test finds a bug: keep the failing test, fix the code, and add a row to docs/BUGS_FOUND.md (attack, impact, root cause, fix, test file).
Report
Maintain docs/SECURITY-TESTS.md, a table of: attack, expected behavior, actual result, test file, status.
