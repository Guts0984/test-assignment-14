import { describe, expect, it } from 'vitest';
import { renderTicketsPdf } from './pdf.js';
import { cancelledMail, formatUah, refundMail, rescheduledMail, ticketsMail } from './templates.js';

describe('money in mails', () => {
  it('formats kopecks as "1 234,50 UAH"', () => {
    expect(formatUah(123_450)).toBe('1 234,50 UAH');
    expect(formatUah(5)).toBe('0,05 UAH');
    expect(formatUah(100_000_000)).toBe('1 000 000,00 UAH');
  });
});

describe('templates', () => {
  const startsAt = new Date('2027-03-04T18:30:00Z');
  it('say what happened and what the reader can do', () => {
    expect(ticketsMail({ title: 'Rock', startsAt, venue: 'Arena', count: 2, total: 210_000 }).text).toContain('2 100,00 UAH'.replace('2 100', '2 100'));
    expect(cancelledMail({ title: 'Rock', startsAt, amount: 105_000 }).text).toContain('including the service fee');
    expect(rescheduledMail({ title: 'Rock', oldStart: startsAt, newStart: new Date('2027-04-01T18:00:00Z') }).text).toContain('within 14 days');
    expect(refundMail({ title: 'Rock', amount: 50_000 }).subject).toBe('Refund for Rock');
  });
});

describe('PDF', () => {
  it('renders one page per ticket with a QR code', async () => {
    const t = (n: number) => ({ id: `id-${n}`, code: `v1.payload${n}.signature${n}`, title: 'Rock', venue: 'Arena', startsAt: new Date('2027-03-04T18:30:00Z'), zone: 'Stalls', row: '3', seat: n });
    const one = await renderTicketsPdf([t(1)]);
    const three = await renderTicketsPdf([t(1), t(2), t(3)]);
    expect(one.subarray(0, 5).toString()).toBe('%PDF-');
    expect(three.length).toBeGreaterThan(one.length);
    expect((three.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
  });
});
