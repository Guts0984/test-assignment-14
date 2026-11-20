'use client';

import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@/shared/ui';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<readonly { rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

/** Reads QR codes from the camera: the browser's BarcodeDetector when present, jsQR otherwise. Each code is reported once per 3 seconds. */
export const CameraReader = ({ onCode }: { readonly onCode: (code: string) => void }) => {
  const t = useTranslations('scanner');
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const seen = new Map<string, number>();
    const canvas = document.createElement('canvas');
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
    const report = (code: string): void => {
      const last = seen.get(code) ?? 0;
      if (Date.now() - last < 3_000) return;
      seen.set(code, Date.now());
      onCode(code);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (s) => {
        stream = s;
        const el = video.current;
        if (!el) return;
        el.srcObject = s;
        await el.play();
        timer = setInterval(async () => {
          if (el.videoWidth === 0) return;
          if (detector) {
            const found = await detector.detect(el).catch(() => []);
            if (found[0]) report(found[0].rawValue);
            return;
          }
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(el, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const hit = jsQR(img.data, img.width, img.height);
          if (hit) report(hit.data);
        }, 300);
      })
      .catch(() => {
        setError(t('cameraDenied'));
        setActive(false);
      });
    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [active, onCode, t]);

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" onClick={() => setActive((a) => !a)} data-testid="camera-toggle">
        {active ? t('cameraStop') : t('cameraStart')}
      </Button>
      {error ? <Alert tone="warning">{error}</Alert> : null}
      {active ? <video ref={video} muted playsInline aria-label={t('cameraLabel')} className="max-h-72 w-full rounded-lg bg-black" /> : null}
    </div>
  );
};
