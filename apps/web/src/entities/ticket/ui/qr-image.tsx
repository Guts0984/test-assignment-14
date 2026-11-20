'use client';

import { toCanvas } from 'qrcode';
import { useEffect, useRef } from 'react';

/** The QR of a server-signed ticket code, rendered in the browser. */
export const QrImage = ({ code, label, size = 180 }: { readonly code: string; readonly label: string; readonly size?: number }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void toCanvas(ref.current, code, { width: size, margin: 1, errorCorrectionLevel: 'M' });
  }, [code, size]);
  return <canvas ref={ref} role="img" aria-label={label} data-testid="ticket-qr" data-code={code} width={size} height={size} className="rounded border border-slate-200" />;
};
