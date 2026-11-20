import { describe, expect, it } from 'vitest';
import {
  ACTORS,
  EVENT_STATUSES,
  EVENT_TRANSITIONS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  canTransition,
} from './transitions.js';

describe('transition tables', () => {
  it('order: every (from,to,actor) not listed is rejected, every listed one is allowed', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        for (const actor of ACTORS) {
          const listed = ORDER_TRANSITIONS.some((r) => r.from === from && r.to === to && r.actors.includes(actor));
          expect(canTransition(ORDER_TRANSITIONS, from, to, actor), `${from}->${to} by ${actor}`).toBe(listed);
        }
      }
    }
  });
  it('event: same exhaustive check', () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        for (const actor of ACTORS) {
          const listed = EVENT_TRANSITIONS.some((r) => r.from === from && r.to === to && r.actors.includes(actor));
          expect(canTransition(EVENT_TRANSITIONS, from, to, actor)).toBe(listed);
        }
      }
    }
  });
  it('terminal states have no way out', () => {
    for (const to of EVENT_STATUSES) {
      for (const actor of ACTORS) {
        expect(canTransition(EVENT_TRANSITIONS, 'cancelled', to, actor)).toBe(false);
        expect(canTransition(EVENT_TRANSITIONS, 'paid_out', to, actor)).toBe(false);
      }
    }
    for (const to of ORDER_STATUSES) expect(canTransition(ORDER_TRANSITIONS, 'refunded', to, 'system')).toBe(false);
  });
  it('permissions: finance never changes events, scanners change nothing', () => {
    for (const row of EVENT_TRANSITIONS) {
      expect(row.actors).not.toContain('finance');
      expect(row.actors).not.toContain('scanner');
      expect(row.actors).not.toContain('buyer');
    }
    for (const row of ORDER_TRANSITIONS) {
      expect(row.actors).not.toContain('scanner');
      expect(row.actors).not.toContain('organizer');
    }
  });
  it('a buyer cannot mark an order paid', () => {
    expect(canTransition(ORDER_TRANSITIONS, 'awaiting_payment', 'paid', 'buyer')).toBe(false);
  });
});
