'use client';

import { useTranslations } from 'next-intl';
import { useQueryParams } from '@/shared/lib/use-query-params';
import { Link } from '@/shared/i18n';
import { LoginForm, RegisterForm } from '@/features/auth';

export const LoginPage = () => {
  const t = useTranslations('auth');
  const next = useQueryParams().get('next') ?? undefined;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('loginTitle')}</h1>
      <LoginForm next={next} />
      <p className="text-sm">
        {t('noAccount')} <Link href="/register" className="text-indigo-700 underline">{t('register')}</Link>
      </p>
    </div>
  );
};

export const RegisterPage = () => {
  const t = useTranslations('auth');
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('registerTitle')}</h1>
      <RegisterForm />
      <p className="text-sm">
        {t('haveAccount')} <Link href="/login" className="text-indigo-700 underline">{t('login')}</Link>
      </p>
    </div>
  );
};
