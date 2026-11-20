export type AppLocale = 'uk' | 'en' | 'pl';
export const LOCALES: readonly AppLocale[] = ['uk', 'en', 'pl'];

/** Events happen in Ukraine: all event times are shown in Kyiv time whatever the browser says. */
export const EVENT_TIME_ZONE = 'Europe/Kyiv';

/** Kopecks to a localised amount: `1 234,50 ₴` (uk, pl), `₴1,234.50` (en). Display only, never used for arithmetic. */
export const formatMoney = (kopecks: number, locale: AppLocale): string =>
  new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'UAH',
    currencyDisplay: 'narrowSymbol',
    useGrouping: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(kopecks / 100);

export const formatDateTime = (iso: string, locale: AppLocale): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: EVENT_TIME_ZONE }).format(new Date(iso));

export const formatDate = (iso: string, locale: AppLocale): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: EVENT_TIME_ZONE }).format(new Date(iso));

export const formatTime = (iso: string, locale: AppLocale): string =>
  new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: EVENT_TIME_ZONE }).format(new Date(iso));

/** `mm:ss` for the hold timer. */
export const formatCountdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
