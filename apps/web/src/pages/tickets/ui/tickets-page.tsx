'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { transferRequestSchema } from '@ticketing/shared';
import type { TicketDto } from '@/shared/api/generated/types.gen';
import { applyFieldErrors, toProblem } from '@/shared/api/problem';
import { Link } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Badge, Button, Card, Spinner, TextField } from '@/shared/ui';
import { QrImage, useMyTickets, useRefund, useRefundQuote, useTransfer } from '@/entities/ticket';

type TransferValues = z.infer<typeof transferRequestSchema>;

const TransferForm = ({ ticket, onDone }: { readonly ticket: TicketDto; readonly onDone: () => void }) => {
  const t = useTranslations('tickets');
  const transfer = useTransfer();
  const key = useRef(crypto.randomUUID());
  const form = useForm<TransferValues>({ resolver: zodResolver(transferRequestSchema), defaultValues: { email: '' } });
  const problem = transfer.error ? toProblem(transfer.error) : null;
  return (
    <form
      noValidate
      aria-label={t('transferTitle')}
      className="flex flex-col gap-2"
      onSubmit={form.handleSubmit((v) =>
        transfer.mutate({ ticketId: ticket.id, email: v.email, key: key.current }, { onSuccess: onDone, onError: (e) => { key.current = crypto.randomUUID(); applyFieldErrors(toProblem(e), form.setError); } }),
      )}
    >
      <TextField label={t('recipientEmail')} type="email" error={form.formState.errors.email ? t('invalidEmail') : undefined} {...form.register('email')} />
      {problem ? <Alert tone="error" data-testid="transfer-error">{problem.code === 'TRANSFER_NOT_ALLOWED' ? t(`transferReason.${String(problem.details?.['reason'] ?? 'other')}`) : problem.message}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" busy={transfer.isPending} data-testid="transfer-submit">{t('transfer')}</Button>
        <Button variant="secondary" onClick={onDone}>{t('cancel')}</Button>
      </div>
    </form>
  );
};

const RefundBox = ({ ticket, onDone }: { readonly ticket: TicketDto; readonly onDone: () => void }) => {
  const t = useTranslations('tickets');
  const locale = useLocale() as AppLocale;
  const quote = useRefundQuote(ticket.orderId);
  const refund = useRefund();
  const key = useRef(crypto.randomUUID());
  const mine = quote.data?.items.find((i) => i.refundable);
  const problem = refund.error ? toProblem(refund.error) : null;
  return (
    <div className="flex flex-col gap-2" data-testid="refund-box">
      {quote.isLoading ? <Spinner label={t('loading')} /> : mine ? <p className="text-sm">{t('refundAmount', { amount: formatMoney(mine.price + mine.fee, locale) })}</p> : <Alert tone="warning">{t('notRefundable')}</Alert>}
      {problem ? <Alert tone="error">{problem.message}</Alert> : null}
      <div className="flex gap-2">
        {mine ? <Button variant="danger" busy={refund.isPending} onClick={() => refund.mutate({ orderId: ticket.orderId, itemIds: [mine.itemId], key: key.current }, { onSuccess: onDone })} data-testid="refund-confirm">{t('refundConfirm')}</Button> : null}
        <Button variant="secondary" onClick={onDone}>{t('cancel')}</Button>
      </div>
    </div>
  );
};

const TicketCard = ({ ticket }: { readonly ticket: TicketDto }) => {
  const t = useTranslations('tickets');
  const locale = useLocale() as AppLocale;
  const [mode, setMode] = useState<'view' | 'transfer' | 'refund'>('view');
  const valid = ticket.status === 'valid';
  return (
    <Card className="flex flex-col gap-3 sm:flex-row" data-testid="ticket">
      <div className={valid ? '' : 'opacity-40'}>
        <QrImage code={ticket.code} label={t('qrLabel', { title: ticket.eventTitle })} />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{ticket.eventTitle}</h2>
          <Badge tone={valid ? 'good' : 'bad'}>{t(`status.${ticket.status}`)}</Badge>
          {ticket.enteredAt ? <Badge tone="neutral">{t('entered')}</Badge> : null}
        </div>
        <p className="text-sm text-slate-700">{formatDateTime(ticket.startsAt, locale)} · {ticket.venueName}</p>
        <p className="text-sm">{ticket.row && ticket.seat ? t('seatInfo', { zone: ticket.zoneName, row: ticket.row, seat: ticket.seat }) : t('floorInfo', { zone: ticket.zoneName })}</p>
        {valid && !ticket.enteredAt && mode === 'view' ? (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setMode('transfer')} data-testid="transfer-open">{t('transfer')}</Button>
            <Button variant="secondary" onClick={() => setMode('refund')} data-testid="refund-open">{t('refund')}</Button>
          </div>
        ) : null}
        {mode === 'transfer' ? <TransferForm ticket={ticket} onDone={() => setMode('view')} /> : null}
        {mode === 'refund' ? <RefundBox ticket={ticket} onDone={() => setMode('view')} /> : null}
      </div>
    </Card>
  );
};

export const TicketsPage = () => {
  const t = useTranslations('tickets');
  const session = useSession();
  const tickets = useMyTickets();
  if (session.status === 'anonymous') return <Alert tone="info"><Link href="/login?next=/tickets" className="underline">{t('loginRequired')}</Link></Alert>;
  if (tickets.isLoading) return <Spinner label={t('loading')} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      {tickets.data?.items.length === 0 ? <Alert tone="info">{t('none')}</Alert> : null}
      <ul className="flex flex-col gap-3">
        {tickets.data?.items.map((tk) => (
          <li key={tk.id}>
            <TicketCard ticket={tk} />
          </li>
        ))}
      </ul>
    </div>
  );
};
