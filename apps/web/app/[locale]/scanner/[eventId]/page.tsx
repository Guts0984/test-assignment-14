import { ScannerEvent } from '@/pages/scanner';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <ScannerEvent id={eventId} />;
}
