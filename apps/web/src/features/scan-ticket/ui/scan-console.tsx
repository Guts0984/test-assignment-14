'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState, type FormEvent } from 'react';
import { toProblem } from '@/shared/api/problem';
import { Alert, Button, Card, TextField } from '@/shared/ui';
import { useScan, useScanStats } from '@/entities/scan';
import { CameraReader } from './camera-reader';

/** Entrance check: scan with the camera or type the code; a big green "pass" or the reason for the refusal, and live counters. */
export const ScanConsole = ({ eventId }: { readonly eventId: string }) => {
  const t = useTranslations('scanner');
  const scan = useScan(eventId);
  const stats = useScanStats(eventId);
  const [code, setCode] = useState('');
  const [gate, setGate] = useState('1');
  const run = useCallback((value: string) => scan.mutate({ code: value.trim(), gate }), [scan, gate]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (code.trim()) run(code);
  };
  const r = scan.data;
  const problem = scan.error ? toProblem(scan.error) : null;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
      <div className="flex flex-col gap-4">
        <CameraReader onCode={run} />
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={t('manual')}>
          <div className="min-w-64 flex-1">
            <TextField label={t('code')} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" data-testid="scan-code" />
          </div>
          <div className="w-24">
            <TextField label={t('gate')} value={gate} onChange={(e) => setGate(e.target.value)} data-testid="scan-gate" />
          </div>
          <Button type="submit" busy={scan.isPending} data-testid="scan-submit">
            {t('check')}
          </Button>
        </form>
        <div aria-live="assertive" role="status" data-testid="scan-result-live">
          {r ? (
            <div data-testid="scan-result" data-result={r.result} data-reason={r.reason} className={`rounded-lg p-6 text-center text-2xl font-bold text-white ${r.result === 'allow' ? 'bg-emerald-600' : 'bg-red-600'}`}>
              <p>{r.result === 'allow' ? t('pass') : t('deny')}</p>
              <p className="mt-2 text-base font-medium">
                {r.reason === 'already_entered' && r.enteredAt
                  ? t('reason.already_entered', { time: r.enteredAt.slice(11, 16), gate: r.gate ?? '?' })
                  : t(`reason.${r.reason}`)}
              </p>
              {r.ticket ? <p className="mt-1 text-base">{r.ticket.row ? t('seatInfo', { zone: r.ticket.zoneName, row: r.ticket.row, seat: r.ticket.seat ?? 0 }) : r.ticket.zoneName}</p> : null}
            </div>
          ) : null}
          {problem ? <Alert tone="error">{problem.message}</Alert> : null}
        </div>
      </div>
      <Card className="flex flex-col gap-1" data-testid="scan-stats">
        <h2 className="font-semibold">{t('counters')}</h2>
        <p className="text-3xl font-bold" data-testid="stat-entered">{stats.data?.entered ?? 0}</p>
        <p className="text-sm text-slate-600">{t('entered')}</p>
        <p className="mt-2 text-2xl font-semibold" data-testid="stat-expected">{stats.data?.expected ?? 0}</p>
        <p className="text-sm text-slate-600">{t('expected')}</p>
      </Card>
    </div>
  );
};
