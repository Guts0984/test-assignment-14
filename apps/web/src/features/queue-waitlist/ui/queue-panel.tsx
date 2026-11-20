'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import '@/shared/api/client';
import { queueControllerJoin, queueControllerLeave, queueControllerView, waitlistControllerJoin, waitlistControllerLeave, waitlistControllerStatus } from '@/shared/api/generated/sdk.gen';
import type { QueueViewDto, WaitlistStatusDto } from '@/shared/api/generated/types.gen';
import { observeServerTime } from '@/shared/lib/server-clock';
import { getSocket } from '@/shared/lib/socket';
import { useSession } from '@/shared/lib/session';
import { remainingMs } from '@/shared/lib/server-clock';
import { formatCountdown, formatDateTime, type AppLocale } from '@/shared/lib/format';
import { Alert, Button } from '@/shared/ui';
import { useLocale } from 'next-intl';

const useQueueView = (eventId: string, enabled: boolean) => {
  const qc = useQueryClient();
  const session = useSession();
  const query = useQuery({
    queryKey: ['queue', eventId],
    queryFn: async (): Promise<QueueViewDto | null> => {
      const res = await queueControllerView({ path: { eventId }, throwOnError: false });
      if (res.response.status === 404) return null;
      if (!res.data) throw new Error('queue unavailable');
      observeServerTime(res.data.serverTime);
      return res.data;
    },
    enabled,
    refetchInterval: (q) => (q.state.data?.status === 'waiting' ? 2_000 : q.state.data?.status === 'admitted' ? 5_000 : false),
  });
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onUpdate = (m: { eventId?: string }): void => {
      if (m.eventId === eventId) void qc.invalidateQueries({ queryKey: ['queue', eventId] });
    };
    socket.on('queue.update', onUpdate);
    return () => void socket.off('queue.update', onUpdate);
  }, [token, eventId, qc]);
  return query;
};

/** Virtual queue: join once, see the position and estimated wait, get access when it is your turn. A reload keeps the place. */
export const QueuePanel = ({ eventId, queueActive, onAdmitted }: { readonly eventId: string; readonly queueActive: boolean; readonly onAdmitted?: (admitted: boolean) => void }) => {
  const t = useTranslations('queue');
  const qc = useQueryClient();
  const session = useSession();
  const view = useQueueView(eventId, session.status === 'authenticated');
  const join = useMutation({
    mutationFn: async () => (await queueControllerJoin({ path: { eventId }, throwOnError: true })).data,
    onSuccess: (v) => qc.setQueryData(['queue', eventId], v),
  });
  const leave = useMutation({
    mutationFn: async () => (await queueControllerLeave({ path: { eventId }, throwOnError: true })).data,
    onSuccess: (v) => qc.setQueryData(['queue', eventId], v),
  });
  const status = view.data?.status;
  const admitted = status === 'admitted' || status === 'selecting';
  useEffect(() => onAdmitted?.(admitted), [admitted, onAdmitted]);
  if (session.status !== 'authenticated') return null;
  if (!queueActive && !view.data) return null;
  const deadline = view.data?.mustStartBefore;
  return (
    <section aria-label={t('title')} className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3" data-testid="queue-panel">
      <h2 className="font-semibold">{t('title')}</h2>
      {!view.data || status === 'expired' || status === 'left' || status === 'done' ? (
        <>
          <p className="text-sm">{t('explain')}</p>
          <Button onClick={() => join.mutate()} busy={join.isPending} data-testid="queue-join">
            {t('join')}
          </Button>
        </>
      ) : status === 'waiting' ? (
        <>
          <p data-testid="queue-position" className="text-lg font-semibold">
            {t('position', { position: view.data.position ?? 0 })}
          </p>
          <p className="text-sm">{t('eta', { minutes: Math.max(1, Math.ceil((view.data.etaSeconds ?? 0) / 60)) })}</p>
          <p className="text-xs text-slate-600">{t('keepOpen')}</p>
          <Button variant="secondary" onClick={() => leave.mutate()} busy={leave.isPending}>
            {t('leave')}
          </Button>
        </>
      ) : (
        <Alert tone="success" data-testid="queue-admitted">
          {t('admitted')}
          {deadline ? ` ${t('startWithin', { time: formatCountdown(remainingMs(deadline)) })}` : ''}
        </Alert>
      )}
    </section>
  );
};

/** Waitlist for sold-out events: one offer at a time, valid for 30 minutes. */
export const WaitlistPanel = ({ eventId }: { readonly eventId: string }) => {
  const t = useTranslations('waitlist');
  const locale = useLocale() as AppLocale;
  const qc = useQueryClient();
  const session = useSession();
  const status = useQuery({
    queryKey: ['waitlist', eventId],
    queryFn: async (): Promise<WaitlistStatusDto> => {
      const r = (await waitlistControllerStatus({ path: { eventId }, throwOnError: true })).data;
      observeServerTime(r.serverTime);
      return r;
    },
    enabled: session.status === 'authenticated',
    refetchInterval: 10_000,
  });
  const token = session.status === 'authenticated' ? session.accessToken : null;
  useEffect(() => {
    if (!token) return;
    const socket = getSocket(token);
    const onOffer = (m: { eventId?: string }): void => {
      if (m.eventId === eventId) void qc.invalidateQueries({ queryKey: ['waitlist', eventId] });
    };
    socket.on('waitlist.offer', onOffer);
    return () => void socket.off('waitlist.offer', onOffer);
  }, [token, eventId, qc]);
  const join = useMutation({
    mutationFn: async () => (await waitlistControllerJoin({ path: { eventId }, body: { zoneId: null }, throwOnError: true })).data,
    onSuccess: (v) => qc.setQueryData(['waitlist', eventId], v),
  });
  const leave = useMutation({
    mutationFn: async () => (await waitlistControllerLeave({ path: { eventId }, throwOnError: true })).data,
    onSuccess: (v) => qc.setQueryData(['waitlist', eventId], v),
  });
  if (session.status !== 'authenticated') return <Alert tone="info">{t('loginFirst')}</Alert>;
  const s = status.data;
  return (
    <section aria-label={t('title')} className="flex flex-col gap-2 rounded-lg border border-sky-300 bg-sky-50 p-3" data-testid="waitlist-panel">
      <h2 className="font-semibold">{t('title')}</h2>
      {s?.offer ? (
        <Alert tone="success" data-testid="waitlist-offer">
          {t('offer', { until: formatDateTime(s.offer.expiresAt, locale) })}
        </Alert>
      ) : s?.joined ? (
        <>
          <p data-testid="waitlist-position">{t('position', { position: s.position ?? 0 })}</p>
          <Button variant="secondary" onClick={() => leave.mutate()} busy={leave.isPending}>
            {t('leave')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm">{t('soldOut')}</p>
          <Button onClick={() => join.mutate()} busy={join.isPending} data-testid="waitlist-join">
            {t('join')}
          </Button>
        </>
      )}
    </section>
  );
};
