'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useQueryParams } from '@/shared/lib/use-query-params';
import { usePathname, useRouter } from '@/shared/i18n';
import { LOCALES } from '@/shared/lib/format';

export const LocaleSwitcher = () => {
  const t = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useQueryParams();
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="sr-only">{t('language')}</span>
      <select
        value={locale}
        aria-label={t('language')}
        className="rounded border border-slate-300 bg-white px-2 py-1"
        onChange={(e) => router.replace(`${pathname}${params.size > 0 ? `?${params.toString()}` : ''}`, { locale: e.target.value })}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {l.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
};
