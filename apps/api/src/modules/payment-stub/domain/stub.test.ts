import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chaosModeFor, isUnavailableRequest, planDeliveries } from './chaos.js';
import { paymentPage } from './page.js';
import { signWebhook, verifyWebhook } from './signature.js';

const SECRET = 'unit-test-webhook-secret-0123456789';

describe('webhook signature', () => {
  const body = '{"id":"evt_1","type":"payment.succeeded"}';
  const now = 1_800_000_000;
  const good = signWebhook(SECRET, body, now);

  it('accepts a correct signature', () => {
    expect(verifyWebhook(SECRET, good, body, now)).toBe('ok');
  });
  it('rejects a changed body, a different secret and an altered timestamp', () => {
    expect(verifyWebhook(SECRET, good, `${body} `, now)).toBe('mismatch');
    expect(verifyWebhook('another-secret-0123456789-0123456789', good, body, now)).toBe('mismatch');
    expect(verifyWebhook(SECRET, good.replace(`t=${now}`, `t=${now + 1}`), body, now)).toBe('mismatch');
  });
  it('rejects missing and malformed headers', () => {
    for (const header of [undefined, '', 'garbage', 't=1,v1=abc', `t=${now},v1=${'z'.repeat(64)}`, `v1=${'a'.repeat(64)}`]) {
      expect(verifyWebhook(SECRET, header, body, now)).toBe('malformed');
    }
  });
  it('rejects replays outside the tolerance window but accepts delayed deliveries inside it', () => {
    expect(verifyWebhook(SECRET, good, body, now + 599)).toBe('ok');
    expect(verifyWebhook(SECRET, good, body, now + 601)).toBe('stale');
    expect(verifyWebhook(SECRET, good, body, now - 601)).toBe('stale');
  });
  it('property: any single-character change in the body invalidates the signature', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), fc.nat(79), (text, pos) => {
        const header = signWebhook(SECRET, text, now);
        const i = pos % text.length;
        const changed = `${text.slice(0, i)}${text[i] === 'x' ? 'y' : 'x'}${text.slice(i + 1)}`;
        expect(verifyWebhook(SECRET, header, changed, now)).toBe('mismatch');
      }),
    );
  });
});

describe('chaos plan', () => {
  it('cycles through every mode so each failure is exercised regularly', () => {
    expect(Array.from({ length: 5 }, (_, i) => chaosModeFor(i))).toEqual(['normal', 'duplicate', 'delayed', 'out_of_order', 'lost']);
    expect(chaosModeFor(5)).toBe('normal');
    expect(chaosModeFor(-1)).toBe('lost');
  });
  it('each mode produces the documented deliveries', () => {
    expect(planDeliveries('normal', 60_000, 0.5)).toEqual([{ kind: 'primary', delayMs: 0 }]);
    expect(planDeliveries('lost', 60_000, 0.5)).toEqual([]);
    expect(planDeliveries('duplicate', 60_000, 0.5).map((d) => d.kind)).toEqual(['primary', 'duplicate']);
    expect(planDeliveries('out_of_order', 60_000, 0.5).map((d) => d.kind)).toEqual(['primary', 'stale_failed']);
    expect(planDeliveries('out_of_order', 60_000, 0.5)[1]?.delayMs).toBeGreaterThan(0);
  });
  it('property: delayed deliveries never exceed the cap (a minute by default)', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 0.9999999, noNaN: true }), (r) => {
      expect(planDeliveries('delayed', 60_000, r)[0]?.delayMs).toBeLessThanOrEqual(60_000);
    }));
  });
  it('every tenth request is unavailable', () => {
    expect(Array.from({ length: 30 }, (_, i) => i + 1).filter(isUnavailableRequest)).toEqual([10, 20, 30]);
  });
});

describe('payment page', () => {
  it('shows the three buttons for a pending payment and none for a final one', () => {
    const pending = paymentPage({ id: 'pay_1', amount: 123_450, orderRef: 'o-1', status: 'pending' });
    expect(pending).toContain('Success');
    expect(pending).toContain('Failure');
    expect(pending).toContain('Close without answer');
    expect(pending).toContain('1234,50 UAH');
    expect(paymentPage({ id: 'pay_1', amount: 100, orderRef: 'o-1', status: 'succeeded' })).not.toContain('<button');
  });
  it('escapes hostile order references', () => {
    const page = paymentPage({ id: 'pay_1', amount: 100, orderRef: '<script>alert(1)</script>"', status: 'pending' });
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
  });
});
