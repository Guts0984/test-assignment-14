export const ORDER_STATUSES = ['holding', 'awaiting_payment', 'paid', 'expired', 'partially_refunded', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const EVENT_STATUSES = ['draft', 'on_sale', 'sold_out', 'rescheduled', 'cancelled', 'finished', 'paid_out'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ACTORS = ['buyer', 'organizer', 'scanner', 'finance', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export interface Transition<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly actors: readonly Actor[];
  readonly note: string;
}

const t = <S extends string>(from: S, to: S, actors: readonly Actor[], note: string): Transition<S> => ({ from, to, actors, note });

export const ORDER_TRANSITIONS: readonly Transition<OrderStatus>[] = [
  t('holding', 'awaiting_payment', ['buyer'], 'checkout started, payment created'),
  t('awaiting_payment', 'holding', ['buyer'], 'buyer went back to change seats before the deadline'),
  t('holding', 'expired', ['buyer', 'system'], 'buyer abandoned or hold timer ran out'),
  t('awaiting_payment', 'expired', ['system'], 'hold timer ran out before payment'),
  t('awaiting_payment', 'paid', ['system'], 'succeeded payment confirmed (webhook or reconciliation)'),
  t('expired', 'paid', ['system'], 'late payment and the seats were still free'),
  t('expired', 'refunded', ['system'], 'late payment and the seats were taken: full automatic refund'),
  t('paid', 'partially_refunded', ['buyer', 'finance', 'system'], 'some tickets refunded'),
  t('paid', 'refunded', ['buyer', 'finance', 'system'], 'all tickets refunded (also event cancellation)'),
  t('partially_refunded', 'partially_refunded', ['buyer', 'finance', 'system'], 'another subset refunded'),
  t('partially_refunded', 'refunded', ['buyer', 'finance', 'system'], 'remaining tickets refunded'),
];

export const EVENT_TRANSITIONS: readonly Transition<EventStatus>[] = [
  t('draft', 'on_sale', ['organizer'], 'published (purchases open at the sales start time)'),
  t('draft', 'cancelled', ['organizer'], 'discarded before publication'),
  t('on_sale', 'sold_out', ['system'], 'no seats left'),
  t('sold_out', 'on_sale', ['system'], 'a seat was released'),
  t('on_sale', 'rescheduled', ['organizer'], 'new date, buyers notified, 14 day full refund window'),
  t('sold_out', 'rescheduled', ['organizer'], 'new date, buyers notified'),
  t('rescheduled', 'rescheduled', ['organizer'], 'rescheduled again, window restarts'),
  t('on_sale', 'cancelled', ['organizer'], 'sales stop at once, all orders refunded in the background'),
  t('sold_out', 'cancelled', ['organizer'], 'as above'),
  t('rescheduled', 'cancelled', ['organizer'], 'as above'),
  t('on_sale', 'finished', ['system'], 'event date passed'),
  t('sold_out', 'finished', ['system'], 'event date passed'),
  t('rescheduled', 'finished', ['system'], 'event date passed'),
  t('finished', 'paid_out', ['system'], 'payout executed 3 days after the event'),
];

export const canTransition = <S extends string>(
  table: readonly Transition<S>[],
  from: S,
  to: S,
  actor: Actor,
): boolean => table.some((row) => row.from === from && row.to === to && row.actors.includes(actor));
