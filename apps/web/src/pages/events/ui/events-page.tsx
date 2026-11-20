'use client';

import { useTranslations } from 'next-intl';
import { useQueryParams } from '@/shared/lib/use-query-params';
import { useState, type FormEvent } from 'react';
import { usePathname, useRouter } from '@/shared/i18n';
import { Alert, Button, Spinner, TextField, SelectField } from '@/shared/ui';
import { DEFAULT_FILTERS, EventCard, parseFilters, serializeFilters, useEventSearch, type EventFilters } from '@/entities/event';

const PAGE_SIZE = 12;

export const EventsPage = () => {
  const t = useTranslations('events');
  const params = useQueryParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = parseFilters(params);
  const query = useEventSearch(filters);
  const [draft, setDraft] = useState<EventFilters>(filters);

  const go = (next: EventFilters): void => {
    const qs = serializeFilters(next);
    router.push(`${pathname}${qs ? `?${qs}` : ''}`);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    go({ ...draft, page: 1 });
  };
  const set = <K extends keyof EventFilters>(key: K, value: EventFilters[K]): void => setDraft((d) => ({ ...d, [key]: value }));
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <form onSubmit={submit} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('filters')} data-testid="filters">
        <TextField label={t('q')} value={draft.q} onChange={(e) => set('q', e.target.value)} data-testid="filter-q" />
        <TextField label={t('city')} value={draft.city} onChange={(e) => set('city', e.target.value)} data-testid="filter-city" />
        <TextField label={t('category')} value={draft.category} onChange={(e) => set('category', e.target.value)} />
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" checked={draft.hasSeats} onChange={(e) => set('hasSeats', e.target.checked)} data-testid="filter-has-seats" />
            {t('hasSeats')}
          </label>
        </div>
        <TextField label={t('dateFrom')} type="date" value={draft.dateFrom} onChange={(e) => set('dateFrom', e.target.value)} />
        <TextField label={t('dateTo')} type="date" value={draft.dateTo} onChange={(e) => set('dateTo', e.target.value)} />
        <TextField label={t('priceMin')} inputMode="decimal" value={draft.priceMin} onChange={(e) => set('priceMin', e.target.value)} />
        <TextField label={t('priceMax')} inputMode="decimal" value={draft.priceMax} onChange={(e) => set('priceMax', e.target.value)} />
        <SelectField label={t('sort')} value={draft.sort} onChange={(e) => set('sort', e.target.value as EventFilters['sort'])} data-testid="filter-sort">
          <option value="date">{t('sortDate')}</option>
          <option value="price">{t('sortPrice')}</option>
          <option value="title">{t('sortTitle')}</option>
        </SelectField>
        <SelectField label={t('order')} value={draft.order} onChange={(e) => set('order', e.target.value as EventFilters['order'])}>
          <option value="asc">{t('asc')}</option>
          <option value="desc">{t('desc')}</option>
        </SelectField>
        <div className="flex items-end gap-2 sm:col-span-2">
          <Button type="submit" data-testid="filter-apply">
            {t('apply')}
          </Button>
          <Button variant="secondary" onClick={() => { setDraft(DEFAULT_FILTERS); go(DEFAULT_FILTERS); }}>
            {t('reset')}
          </Button>
        </div>
      </form>
      {query.isLoading ? <Spinner label={t('loading')} /> : null}
      {query.isError ? <Alert tone="error">{t('failed')}</Alert> : null}
      {query.data ? (
        <>
          <p className="text-sm text-slate-600" data-testid="result-count">
            {t('found', { count: total })}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {query.data.items.map((e) => (
              <li key={e.id}>
                <EventCard event={e} />
              </li>
            ))}
          </ul>
          {query.data.items.length === 0 ? <Alert tone="info">{t('none')}</Alert> : null}
          <nav aria-label={t('pagination')} className="flex items-center gap-3">
            <Button variant="secondary" disabled={filters.page <= 1} onClick={() => go({ ...filters, page: filters.page - 1 })} data-testid="page-prev">
              {t('prev')}
            </Button>
            <span data-testid="page-indicator">{t('page', { page: filters.page, pages })}</span>
            <Button variant="secondary" disabled={filters.page >= pages} onClick={() => go({ ...filters, page: filters.page + 1 })} data-testid="page-next">
              {t('next')}
            </Button>
          </nav>
        </>
      ) : null}
    </div>
  );
};
