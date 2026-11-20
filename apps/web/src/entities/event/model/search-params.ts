export interface EventFilters {
  readonly q: string;
  readonly city: string;
  readonly category: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly priceMin: string;
  readonly priceMax: string;
  readonly hasSeats: boolean;
  readonly sort: 'date' | 'price' | 'title';
  readonly order: 'asc' | 'desc';
  readonly page: number;
}

export const DEFAULT_FILTERS: EventFilters = { q: '', city: '', category: '', dateFrom: '', dateTo: '', priceMin: '', priceMax: '', hasSeats: false, sort: 'date', order: 'asc', page: 1 };

type Source = { get(name: string): string | null };

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T => allowed.find((a) => a === value) ?? fallback;

/** Filters, sorting and page live in the URL so reload, Back and shared links restore the same result list. */
export const parseFilters = (params: Source): EventFilters => {
  const page = Number(params.get('page'));
  return {
    q: params.get('q') ?? '',
    city: params.get('city') ?? '',
    category: params.get('category') ?? '',
    dateFrom: params.get('dateFrom') ?? '',
    dateTo: params.get('dateTo') ?? '',
    priceMin: params.get('priceMin') ?? '',
    priceMax: params.get('priceMax') ?? '',
    hasSeats: params.get('hasSeats') === 'true',
    sort: pick(params.get('sort'), ['date', 'price', 'title'] as const, 'date'),
    order: pick(params.get('order'), ['asc', 'desc'] as const, 'asc'),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
};

/** Only non-default values are written, keeping URLs short and stable. */
export const serializeFilters = (f: EventFilters): string => {
  const out = new URLSearchParams();
  (['q', 'city', 'category', 'dateFrom', 'dateTo', 'priceMin', 'priceMax'] as const).forEach((k) => {
    if (f[k] !== '') out.set(k, f[k]);
  });
  if (f.hasSeats) out.set('hasSeats', 'true');
  if (f.sort !== DEFAULT_FILTERS.sort) out.set('sort', f.sort);
  if (f.order !== DEFAULT_FILTERS.order) out.set('order', f.order);
  if (f.page !== 1) out.set('page', String(f.page));
  return out.toString();
};

const toIsoStart = (date: string): string | undefined => (date ? new Date(`${date}T00:00:00+02:00`).toISOString() : undefined);
const toIsoEnd = (date: string): string | undefined => (date ? new Date(`${date}T23:59:59+02:00`).toISOString() : undefined);
const toKopecks = (uah: string): number | undefined => {
  const n = Number(uah.replace(',', '.'));
  return uah !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
};

/** Filters as the api query (money in kopecks, dates as instants). */
export const toApiQuery = (f: EventFilters, pageSize = 12) => ({
  q: f.q || undefined,
  city: f.city || undefined,
  category: f.category || undefined,
  dateFrom: toIsoStart(f.dateFrom),
  dateTo: toIsoEnd(f.dateTo),
  priceMin: toKopecks(f.priceMin),
  priceMax: toKopecks(f.priceMax),
  hasSeats: f.hasSeats ? ('true' as const) : undefined,
  sort: f.sort,
  order: f.order,
  page: f.page,
  pageSize,
});
