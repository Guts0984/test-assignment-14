# Bugs found by tests

| # | Attack / scenario | Impact | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- |
| 1 | Deeply nested JSON body (`[` x 100 000 or 20 000 nested objects) | HTTP 500 "Internal error" from a body-parser stack overflow instead of a clear client error (violates INV-15) | The `RangeError` raised by `JSON.parse` is not a `SyntaxError`, so body-parser did not map it to a 400 and the error middleware treated it as unexpected | `toErrorBody` maps the stack-overflow `RangeError` to `400 VALIDATION_FAILED` | `apps/api/test/adversarial/input.adv.test.ts` (deeply nested JSON) |
| 2 | Hold request with a seat id of 2^53 (`9007199254740992`) | Passed validation (`int()`), silently lost precision and was looked up as another seat id; answered 409 instead of 400 | `z.number().int()` accepts integers beyond `Number.MAX_SAFE_INTEGER` | Shared `seatIdSchema` = `int().safe().positive()` used by every seat-id field | `apps/api/test/adversarial/input.adv.test.ts` (hold requests with SQL, floats, ...) |
