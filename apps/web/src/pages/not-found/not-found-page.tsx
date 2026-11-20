import { useTranslations } from 'next-intl';
import { Link } from '@/shared/i18n';

export const NotFoundPage = () => {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">{t('notFoundTitle')}</h1>
      <Link href="/" className="text-indigo-700 underline">
        {t('home')}
      </Link>
    </div>
  );
};
