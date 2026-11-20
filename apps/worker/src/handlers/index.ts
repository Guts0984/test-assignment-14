import type { TaskHandler } from '@ticketing/platform';
import type { HandlerDeps } from './deps.js';
import { emailHandler } from './email.js';
import { eventFinish, payout } from './finish-payout.js';
import { holdExpire, waitlistExpire } from './orders-and-offers.js';
import { massCancelNotice, refundExecute } from './refund.js';

/** Every task kind that can exist in the `tasks` table. An unknown kind fails loudly instead of being dropped. */
export const buildHandlers = (d: HandlerDeps): Readonly<Record<string, TaskHandler>> => ({
  hold_expire: holdExpire(d),
  waitlist_expire: waitlistExpire(d),
  refund_execute: refundExecute(d),
  mass_cancel_notice: massCancelNotice(d),
  email: emailHandler(d),
  event_finish: eventFinish(d),
  payout: payout(d),
});
