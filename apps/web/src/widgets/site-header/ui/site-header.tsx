'use client';

import { useTranslations } from 'next-intl';
import { useSession, type Role } from '@/shared/lib/session';
import { Link, usePathname, useRouter } from '@/shared/i18n';
import { Button } from '@/shared/ui';
import { useLogout } from '@/entities/user';
import { LocaleSwitcher } from './locale-switcher';

const links: readonly { readonly href: string; readonly key: string; readonly roles: readonly Role[] | null }[] = [
  { href: '/', key: 'events', roles: null },
  { href: '/tickets', key: 'tickets', roles: ['buyer'] },
  { href: '/orders', key: 'orders', roles: ['buyer'] },
  { href: '/organizer', key: 'organizer', roles: ['organizer'] },
  { href: '/scanner', key: 'scanner', roles: ['scanner'] },
  { href: '/finance', key: 'finance', roles: ['finance'] },
];

export const SiteHeader = () => {
  const t = useTranslations('nav');
  const session = useSession();
  const logout = useLogout();
  const router = useRouter();
  const pathname = usePathname();
  const role = session.status === 'authenticated' ? session.user.role : null;
  return (
    <header className="border-b border-slate-200 bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2">
        {t('skip')}
      </a>
      <nav aria-label={t('main')} className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
        <Link href="/" className="text-lg font-semibold text-indigo-700">
          {t('brand')}
        </Link>
        <ul className="flex flex-wrap gap-3 text-sm">
          {links
            .filter((l) => l.roles === null || (role !== null && l.roles.includes(role)))
            .map((l) => (
              <li key={l.href}>
                <Link href={l.href} aria-current={pathname === l.href ? 'page' : undefined} className="rounded px-2 py-1 hover:bg-slate-100">
                  {t(l.key)}
                </Link>
              </li>
            ))}
        </ul>
        <div className="ml-auto flex items-center gap-3">
          <LocaleSwitcher />
          {session.status === 'authenticated' ? (
            <>
              <span className="text-sm text-slate-600" data-testid="current-user">
                {session.user.displayName}
              </span>
              <Button variant="secondary" busy={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => router.push('/login') })}>
                {t('logout')}
              </Button>
            </>
          ) : session.status === 'anonymous' ? (
            <>
              <Link href="/login" className="text-sm font-medium text-indigo-700">
                {t('login')}
              </Link>
              <Link href="/register" className="text-sm font-medium text-indigo-700">
                {t('register')}
              </Link>
            </>
          ) : null}
        </div>
      </nav>
    </header>
  );
};
