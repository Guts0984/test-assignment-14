'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { lifecycleControllerProgressOptions } from '@/shared/api/generated/@tanstack/react-query.gen';
import { formatMoney, type AppLocale } from '@/shared/lib/format';
import { getSocket } from '@/shared/lib/socket';
import { useSession } from '@/shared/lib/session';
import { Alert } from '@/shared/ui';
import { useCancellationProgress } from '@/entities/event';

/** Live progress of the background refund of a cancelled event: pushed over the socket, polled as a fallback. */
export const CancellationProgress = ({ eventId }: { readonly eventId: string }) => {
  const t = useTranslations('organizer');
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const qc = useQueryClient();
  const progress = useCancellationProgress(eventId, true);
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onProgress = (m: { eventId?: string }): void => {
      if (m.eventId === eventId) void qc.invalidateQueries({ queryKey: lifecycleControllerProgressOptions({ path: { id: eventId } }).queryKey });
    };
    socket.on('cancellation.progress', onProgress);
    return () => void socket.off('cancellation.progress', onProgress);
  }, [token, eventId, qc]);
  const p = progress.data;
  if (!p || p.total === 0) return null;
  const done = p.succeeded + p.failed;
  const percent = Math.round((done / p.total) * 100);
  return (
    <section aria-label={t('refundProgress')} className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4" data-testid="cancellation-progress">
      <h2 className="font-semibold">{t('refundProgress')}</h2>
      <div className="h-3 w-full overflow-hidden rounded bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('refundProgress')}>
        <div className="h-full bg-emerald-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm" data-testid="progress-numbers">
        {t('refundCounts', { done: p.succeeded, total: p.total, pending: p.requested + p.pending, failed: p.failed })}
      </p>
      <p className="text-sm text-slate-600">{t('refundAmounts', { refunded: formatMoney(p.amountRefunded, locale), total: formatMoney(p.amountTotal, locale) })}</p>
      {done === p.total ? <Alert tone="success">{t('refundDone')}</Alert> : null}
    </section>
  );
};
