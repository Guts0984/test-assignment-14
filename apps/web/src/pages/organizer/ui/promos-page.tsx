'use client';

import { useTranslations } from 'next-intl';
import { PromoCreate, PromoList } from './event-manage';

export const PromosPage = () => {
  const t = useTranslations('organizer');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('promos')}</h1>
      <PromoCreate eventId={null} />
      <PromoList />
    </div>
  );
};
