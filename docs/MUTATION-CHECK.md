# Mutation check

After the suites were green, each protection was disabled in the source, the matching tests were run, and the code was restored
(verified with `git diff`). A test that stays green when its protection is removed would be worthless; all of these went red.

| # | Protection removed | Change | Tests run | Result with the mutation |
| --- | --- | --- | --- | --- |
| 1 | Default-deny auth guard | `AuthGuard` returns `true` for every route | `routes.adv`, `idor.adv` | 2 failed (protected routes answered without a token; IDOR reads succeeded) |
| 2a | Login throttle | the `RATE_LIMITED` branch in `AuthService.login` never fires | `auth.adv` | 3 failed (brute force, spoofed-header and concurrency scenarios) |
| 2b | Payment stub 20 req/s limiter | the `!decision.allowed` branch in `StubGuard` never fires | `payment-stub.adv` | 2 failed (25 rps burst accepted; limit shared across copies) |
| 3 | One validator | `seatIdSchema` loses `.safe()` | `input.adv` | 1 failed (seat id 2^53 accepted) |

Restored afterwards: all suites above are green again.
