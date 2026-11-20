export interface Money {
  readonly kopecks: number;
}

/** `1 234,50 UAH` style amount for plain-text mails. */
export const formatUah = (kopecks: number): string => {
  const whole = Math.floor(kopecks / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${whole},${String(kopecks % 100).padStart(2, '0')} UAH`;
};

export interface Mail {
  readonly subject: string;
  readonly text: string;
}

const when = (iso: Date): string => iso.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export const ticketsMail = (e: { title: string; startsAt: Date; venue: string; count: number; total: number }): Mail => ({
  subject: `Your tickets for ${e.title}`,
  text: `Thank you for your purchase!\n\n${e.title}\n${e.venue}, ${when(e.startsAt)}\nTickets: ${e.count}\nPaid: ${formatUah(e.total)}\n\nYour tickets with QR codes are attached as a PDF. You can also find them in your account.`,
});

export const refundMail = (e: { title: string; amount: number }): Mail => ({
  subject: `Refund for ${e.title}`,
  text: `Your refund of ${formatUah(e.amount)} for "${e.title}" has been processed and is on its way back to you.`,
});

export const cancelledMail = (e: { title: string; startsAt: Date; amount: number }): Mail => ({
  subject: `${e.title} was cancelled - full refund`,
  text: `Unfortunately "${e.title}" (${when(e.startsAt)}) was cancelled.\nYour order is refunded in full, including the service fee: ${formatUah(e.amount)}. You do not need to do anything.`,
});

export const rescheduledMail = (e: { title: string; oldStart: Date | null; newStart: Date }): Mail => ({
  subject: `${e.title} has a new date`,
  text: `"${e.title}" was moved${e.oldStart ? ` from ${when(e.oldStart)}` : ''} to ${when(e.newStart)}.\nYour tickets stay valid. If the new date does not suit you, you can return your tickets for a full refund within 14 days.`,
});

export const transferInMail = (e: { title: string; startsAt: Date; from: string }): Mail => ({
  subject: `${e.from} sent you a ticket for ${e.title}`,
  text: `${e.from} transferred a ticket for "${e.title}" (${when(e.startsAt)}) to you.\nThe new ticket with its own QR code is attached; the old code no longer works.`,
});

export const transferOutMail = (e: { title: string; to: string }): Mail => ({
  subject: `You sent a ticket for ${e.title}`,
  text: `Your ticket for "${e.title}" was transferred to ${e.to}. The code you had no longer works.`,
});

export const waitlistMail = (e: { title: string; expiresAt: Date }): Mail => ({
  subject: `A seat is available for ${e.title}`,
  text: `A seat for "${e.title}" is reserved for you until ${when(e.expiresAt)} (30 minutes). Open the event page to choose it and pay; after that the seat goes to the next person.`,
});

export const payoutMail = (e: { title: string; amount: number }): Mail => ({
  subject: `Payout for ${e.title}`,
  text: `The payout for "${e.title}" is ${formatUah(e.amount)} (sales minus refunds minus commission).`,
});
