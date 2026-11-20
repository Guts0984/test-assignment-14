import { useEffect, useState } from 'react';
import { remainingMs } from '@/shared/lib/server-clock';

/** Milliseconds left on the hold, ticking every 250 ms, always measured on the server clock. */
export const useHoldRemaining = (expiresAt: string | null | undefined): number | null => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, remainingMs(expiresAt, now)) : null;
};
