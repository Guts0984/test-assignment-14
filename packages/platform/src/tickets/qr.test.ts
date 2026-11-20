import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTicketCode, signTicketCode } from './qr.js';

const SECRET = 'qr-unit-test-secret-0123456789-0123456789';
const code = { ticketId: '11111111-2222-4333-8444-555555555555', eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 3 };

describe('ticket codes', () => {
  it('round-trip', () => {
    expect(parseTicketCode(SECRET, signTicketCode(SECRET, code))).toEqual(code);
  });
  it('the version is part of the signature: another version is another code', () => {
    expect(signTicketCode(SECRET, { ...code, version: 4 })).not.toBe(signTicketCode(SECRET, code));
  });
  it('property: changing any single character of a code makes it invalid', () => {
    const valid = signTicketCode(SECRET, code);
    fc.assert(
      fc.property(fc.nat(valid.length - 1), (i) => {
        const swapped = valid[i] === 'A' ? 'B' : 'A';
        expect(parseTicketCode(SECRET, `${valid.slice(0, i)}${swapped}${valid.slice(i + 1)}`)).toBeNull();
      }),
    );
  });
  it('rejects another secret, garbage, truncation, extension, wrong prefix and absurd input', () => {
    const valid = signTicketCode(SECRET, code);
    expect(parseTicketCode('another-secret-0123456789-0123456789-x', valid)).toBeNull();
    for (const bad of ['', 'v1', 'v1..', 'v1.a.b', valid.slice(0, -1), `${valid}A`, valid.replace('v1.', 'v2.'), 'x'.repeat(5_000), `${valid}.extra`]) {
      expect(parseTicketCode(SECRET, bad), bad.slice(0, 30)).toBeNull();
    }
  });
  it('a validly signed payload with malformed ids is still refused', () => {
    // A correctly signed but nonsensical payload can only come from our own signer; the parser still validates its shape.
    expect(parseTicketCode(SECRET, signTicketCode(SECRET, { ticketId: 'not-a-uuid', eventId: code.eventId, version: 1 }))).toBeNull();
  });
});
