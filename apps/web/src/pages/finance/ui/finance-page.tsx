'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useQueryParams } from '@/shared/lib/use-query-params';
import { useRef, useState } from 'react';
import { toProblem } from '@/shared/api/problem';
import { Link, usePathname, useRouter } from '@/shared/i18n';
import { formatDateTime, formatMoney, type AppLocale } from '@/shared/lib/format';
import { useSession } from '@/shared/lib/session';
import { Alert, Badge, Button, Card, Spinner, TextField } from '@/shared/ui';
import { useFailedRefunds, useFinanceReport, useJobs, useManualRefund, useRetryRefund, useReconciliation, useRestartJob, useRunReconciliation } from '@/entities/finance';

const TABS = ['report', 'reconciliation', 'jobs', 'refund'] as const;
type Tab = (typeof TABS)[number];

const ReportTab = () => {
  const t = useTranslations('finance');
  const locale = useLocale() as AppLocale;
  const params = useQueryParams();
  const router = useRouter();
  const pathname = usePathname();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const report = useFinanceReport(from ? new Date(`${from}T00:00:00+02:00`).toISOString() : undefined, to ? new Date(`${to}T23:59:59+02:00`).toISOString() : undefined);
  const [draft, setDraft] = useState({ from, to });
  const apply = (): void => {
    const q = new URLSearchParams(params.toString());
    q.set('tab', 'report');
    if (draft.from) q.set('from', draft.from); else q.delete('from');
    if (draft.to) q.set('to', draft.to); else q.delete('to');
    router.push(`${pathname}?${q.toString()}`);
  };
  const r = report.data;
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); apply(); }} aria-label={t('period')}>
        <TextField label={t('from')} type="date" value={draft.from} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} data-testid="period-from" />
        <TextField label={t('to')} type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} data-testid="period-to" />
        <Button type="submit" data-testid="period-apply">{t('apply')}</Button>
      </form>
      {report.isLoading ? <Spinner label={t('loading')} /> : null}
      {r ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-5" data-testid="report-totals">
            {([['sales', r.sales], ['serviceFees', r.serviceFees], ['commission', r.commission], ['refunds', r.refunds], ['payouts', r.payouts]] as const).map(([k, v]) => (
              <Card key={k}>
                <dt className="text-sm text-slate-600">{t(k)}</dt>
                <dd className="text-lg font-semibold" data-testid={`total-${k}`}>{formatMoney(v, locale)}</dd>
              </Card>
            ))}
          </dl>
          <table className="w-full text-sm" data-testid="by-organizer">
            <caption className="mb-1 text-left font-semibold">{t('byOrganizer')}</caption>
            <thead>
              <tr className="text-left"><th>{t('organizer')}</th><th className="text-right">{t('sales')}</th><th className="text-right">{t('refunds')}</th><th className="text-right">{t('commission')}</th><th className="text-right">{t('payouts')}</th></tr>
            </thead>
            <tbody>
              {r.byOrganizer.map((o) => (
                <tr key={o.organizerId}><td>{o.organizerName}</td><td className="text-right">{formatMoney(o.sales, locale)}</td><td className="text-right">{formatMoney(o.refunds, locale)}</td><td className="text-right">{formatMoney(o.commission, locale)}</td><td className="text-right">{formatMoney(o.payouts, locale)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
};

const ReconciliationTab = () => {
  const t = useTranslations('finance');
  const rec = useReconciliation();
  const run = useRunReconciliation();
  const r = rec.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button onClick={() => run.mutate()} busy={run.isPending} data-testid="recon-run">{t('runReconciliation')}</Button>
        {run.data ? <span className="text-sm">{t('found', { count: run.data.found })}</span> : null}
      </div>
      {rec.isLoading ? <Spinner label={t('loading')} /> : null}
      {r ? (
        <Card className="flex flex-col gap-2" data-testid="recon">
          <Alert tone={r.ok ? 'success' : 'error'} data-testid="recon-ok">{r.ok ? t('allBalanced') : t('mismatch')}</Alert>
          <p>{t('ledgerSum', { sum: r.ledgerSum })}</p>
          <p>{t('unbalanced', { count: r.unbalancedTransactions })} · {t('balanceMismatches', { count: r.balanceMismatches.length })} · {t('rollupMismatches', { count: r.rollupMismatches })}</p>
          <p>{t('stuck', { payments: r.stuck.pendingPayments, refunds: r.stuck.pendingRefunds, failed: r.stuck.failedRefunds })}</p>
          <h3 className="font-semibold">{t('providerDifferences')}</h3>
          <ul className="text-sm" data-testid="findings">
            {r.providerFindings.map((f) => (<li key={`${f.kind}-${f.ref}`}>{f.kind} · {f.ref} · {f.resolved ? <Badge tone="good">{t('resolved')}</Badge> : <Badge tone="bad">{t('open')}</Badge>}</li>))}
            {r.providerFindings.length === 0 ? <li>{t('noDifferences')}</li> : null}
          </ul>
        </Card>
      ) : null}
    </div>
  );
};

const JobsTab = () => {
  const t = useTranslations('finance');
  const locale = useLocale() as AppLocale;
  const [status, setStatus] = useState<'failed' | 'stuck' | 'all'>('all');
  const jobs = useJobs(status);
  const restart = useRestartJob();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="group" aria-label={t('jobFilter')}>
        {(['all', 'failed', 'stuck'] as const).map((s) => (
          <Button key={s} variant={status === s ? 'primary' : 'secondary'} onClick={() => setStatus(s)} aria-pressed={status === s}>{t(`filter.${s}`)}</Button>
        ))}
      </div>
      {restart.error ? <Alert tone="error">{toProblem(restart.error).message}</Alert> : null}
      <table className="w-full text-sm" data-testid="jobs">
        <thead><tr className="text-left"><th>{t('kind')}</th><th>{t('status')}</th><th>{t('attempts')}</th><th>{t('error')}</th><th>{t('updated')}</th><th /></tr></thead>
        <tbody>
          {jobs.data?.items.map((j) => (
            <tr key={j.id} data-testid="job-row">
              <td>{j.kind}<br /><span className="text-xs text-slate-500">{j.dedupeKey}</span></td>
              <td><Badge tone={j.status === 'failed' ? 'bad' : 'warn'}>{j.stuck && j.status !== 'failed' ? t('stuckLabel') : j.status}</Badge></td>
              <td>{j.attempts}/{j.maxAttempts}</td>
              <td className="max-w-xs truncate">{j.lastError}</td>
              <td>{formatDateTime(j.updatedAt, locale)}</td>
              <td><Button variant="secondary" busy={restart.isPending && restart.variables === j.id} onClick={() => restart.mutate(j.id)} data-testid="job-restart">{t('restart')}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {jobs.data?.items.length === 0 ? <Alert tone="success">{t('noJobs')}</Alert> : null}
    </div>
  );
};

const FailedRefunds = () => {
  const t = useTranslations('finance');
  const locale = useLocale() as AppLocale;
  const list = useFailedRefunds();
  const retry = useRetryRefund();
  if (list.isLoading) return <Spinner label={t('loading')} />;
  const items = list.data?.items ?? [];
  return (
    <section aria-label={t('failedRefunds')} className="flex flex-col gap-2" data-testid="failed-refunds">
      <h2 className="font-semibold">{t('failedRefunds')}</h2>
      {items.length === 0 ? <p className="text-sm text-slate-600">{t('noFailedRefunds')}</p> : null}
      <ul className="flex flex-col gap-2">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 p-2 text-sm" data-testid="failed-refund">
            <span>
              {r.eventTitle} · {formatMoney(r.amount, locale)} · {t('order')} <code>{r.orderId}</code> · {formatDateTime(r.updatedAt, locale)}
              {r.attempt > 0 ? ` · ${t('attemptN', { n: r.attempt + 1 })}` : ''}
            </span>
            <Button variant="secondary" busy={retry.isPending && retry.variables === r.id} onClick={() => retry.mutate(r.id)} data-testid="retry-refund">
              {t('retryRefund')}
            </Button>
          </li>
        ))}
      </ul>
      {retry.error ? <Alert tone="error">{toProblem(retry.error).message}</Alert> : null}
    </section>
  );
};

const RefundTab = () => (
  <div className="flex flex-col gap-6">
    <FailedRefunds />
    <ManualRefund />
  </div>
);

const ManualRefund = () => {
  const t = useTranslations('finance');
  const refund = useManualRefund();
  const key = useRef(crypto.randomUUID());
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('');
  const problem = refund.error ? toProblem(refund.error) : null;
  return (
    <form className="flex max-w-lg flex-col gap-3" onSubmit={(e) => { e.preventDefault(); refund.mutate({ orderId: orderId.trim(), reason: reason.trim(), key: key.current }, { onError: () => { key.current = crypto.randomUUID(); } }); }} aria-label={t('manualRefund')}>
      <TextField label={t('orderId')} value={orderId} onChange={(e) => setOrderId(e.target.value)} data-testid="refund-order" />
      <TextField label={t('reason')} value={reason} onChange={(e) => setReason(e.target.value)} hint={t('reasonHint')} error={reason !== '' && reason.trim().length < 3 ? t('reasonShort') : undefined} data-testid="refund-reason" />
      <Button type="submit" busy={refund.isPending} disabled={reason.trim().length < 3 || orderId.trim() === ''} data-testid="refund-submit">{t('refundDo')}</Button>
      {problem ? <Alert tone="error">{problem.message}</Alert> : null}
      {refund.data ? <Alert tone="success" data-testid="refund-ok">{t('refundCreated', { id: refund.data.id })}</Alert> : null}
    </form>
  );
};

export const FinancePage = () => {
  const t = useTranslations('finance');
  const session = useSession();
  const params = useQueryParams();
  const tab: Tab = (TABS.find((x) => x === params.get('tab')) ?? 'report') as Tab;
  if (session.status === 'anonymous') return <Alert tone="info"><Link href="/login?next=/finance" className="underline">{t('loginRequired')}</Link></Alert>;
  if (session.status === 'loading') return <Spinner label={t('loading')} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <nav aria-label={t('tabs')} className="flex gap-2">
        {TABS.map((x) => (
          <Link key={x} href={`/finance?tab=${x}`} aria-current={tab === x ? 'page' : undefined} className={`rounded-md px-3 py-1 text-sm ${tab === x ? 'bg-indigo-600 text-white' : 'bg-white text-slate-800 border border-slate-300'}`} data-testid={`tab-${x}`}>
            {t(`tab.${x}`)}
          </Link>
        ))}
      </nav>
      {tab === 'report' ? <ReportTab /> : tab === 'reconciliation' ? <ReconciliationTab /> : tab === 'jobs' ? <JobsTab /> : <RefundTab />}
    </div>
  );
};
