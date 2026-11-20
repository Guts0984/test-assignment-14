import { EventPage } from '@/pages/event';

export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventPage id={id} />;
}
