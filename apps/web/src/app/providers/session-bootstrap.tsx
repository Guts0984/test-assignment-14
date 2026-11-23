'use client';

import { useEffect, type ReactNode } from 'react';
import '@/shared/api/client';
import { refreshSession } from '@/shared/api/client';
import { clearSession, getSession, restoreSession } from '@/shared/lib/session';

/** On load, a still-valid saved access token, or else the refresh cookie, silently signs the user back in (a reload keeps the session). */
export const SessionBootstrap = ({ children }: { readonly children: ReactNode }) => {
  useEffect(() => {
    if (getSession().status !== 'loading' || restoreSession()) return;
    void refreshSession().then((ok) => {
      if (!ok) clearSession();
    });
  }, []);
  return <>{children}</>;
};
