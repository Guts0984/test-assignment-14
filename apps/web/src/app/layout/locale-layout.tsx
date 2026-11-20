import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/widgets/site-header';
import { QueryProvider } from '../providers/query-provider';
import { SessionBootstrap } from '../providers/session-bootstrap';
import { routing } from '@/shared/i18n/routing';
import '../styles/globals.css';

export const generateLocaleParams = (): { locale: string }[] => routing.locales.map((locale) => ({ locale }));

export const LocaleLayout = async ({ children, params }: { readonly children: ReactNode; readonly params: Promise<{ locale: string }> }) => {
  const { locale } = await params;
  if (!routing.locales.some((l) => l === locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <QueryProvider>
            <SessionBootstrap>
              <SiteHeader />
              <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6">
                {children}
              </main>
            </SessionBootstrap>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
};
