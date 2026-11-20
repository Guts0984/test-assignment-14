export interface SearchParams {
  readonly q?: string | undefined;
  readonly city?: string | undefined;
  readonly category?: string | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly priceMin?: number | undefined;
  readonly priceMax?: number | undefined;
  readonly hasSeats?: boolean | undefined;
  readonly sort: 'date' | 'price' | 'title';
  readonly order: 'asc' | 'desc';
  readonly page: number;
  readonly pageSize: number;
}

export interface BuiltQuery {
  readonly where: string;
  readonly params: readonly unknown[];
  readonly orderBy: string;
  readonly limit: number;
  readonly offset: number;
}

const ORDER_COLUMNS = { date: 'e.starts_at', price: 'e.min_price', title: 'lower(e.title)' } as const;

/** Escapes LIKE wildcards so user text is matched literally. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Builds a fully parameterised public search. Column names come from a fixed whitelist, never from input. */
export const buildSearch = (p: SearchParams): BuiltQuery => {
  const params: unknown[] = [];
  const conditions = [`e.status IN ('on_sale', 'sold_out', 'rescheduled')`, `e.starts_at > app_now()`];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (p.q) add(`e.title ILIKE '%' || ? || '%' ESCAPE '\\'`, escapeLike(p.q));
  if (p.city) add('lower(e.city) = lower(?)', p.city);
  if (p.category) add('e.category = ?', p.category);
  if (p.dateFrom) add('e.starts_at >= ?::timestamptz', p.dateFrom);
  if (p.dateTo) add('e.starts_at <= ?::timestamptz', p.dateTo);
  if (p.priceMin !== undefined) add('e.max_price >= ?', p.priceMin);
  if (p.priceMax !== undefined) add('e.min_price <= ?', p.priceMax);
  if (p.hasSeats === true) conditions.push('e.sold_count + e.blocked_count < e.capacity');
  const direction = p.order === 'desc' ? 'DESC' : 'ASC';
  return {
    where: conditions.join(' AND '),
    params,
    orderBy: `${ORDER_COLUMNS[p.sort]} ${direction} NULLS LAST, e.id`,
    limit: p.pageSize,
    offset: (p.page - 1) * p.pageSize,
  };
};
