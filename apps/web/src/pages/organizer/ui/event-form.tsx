'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { applyFieldErrors, toProblem } from '@/shared/api/problem';
import { useRouter } from '@/shared/i18n';
import { Alert, Button, SelectField, TextAreaField, TextField } from '@/shared/ui';
import { useCreateEvent } from '@/entities/event';
import { useMyVenues, useVenueGeometry } from '@/entities/venue';
import { PricingEditor, type PricingPayload } from '@/widgets/pricing-editor';

const schema = z.object({
  venueId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5_000),
  category: z.string().trim().min(1).max(40),
  startsAt: z.string().min(1),
  salesStartAt: z.string().min(1),
  perPersonLimit: z.coerce.number().int().min(1).max(50),
});
type Values = z.infer<typeof schema>;

const toIso = (local: string): string => new Date(local).toISOString();

export const EventForm = () => {
  const t = useTranslations('organizer');
  const router = useRouter();
  const venues = useMyVenues();
  const create = useCreateEvent();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { venueId: '', title: '', description: '', category: '', startsAt: '', salesStartAt: '', perPersonLimit: 6 } });
  const venueId = form.watch('venueId');
  const geometry = useVenueGeometry(venueId || null);
  const [pricing, setPricing] = useState<PricingPayload | null>(null);
  const onPayload = useCallback((p: PricingPayload | null) => setPricing(p), []);
  const e = form.formState.errors;
  const problem = create.error ? toProblem(create.error) : null;

  return (
    <form
      noValidate
      aria-label={t('newEvent')}
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit((v) => {
        if (!pricing) return;
        create.mutate(
          { venueId: v.venueId, title: v.title, description: v.description, category: v.category, startsAt: toIso(v.startsAt), salesStartAt: toIso(v.salesStartAt), perPersonLimit: v.perPersonLimit, pricing },
          { onSuccess: (r) => router.push(`/organizer/events/${r.id}`), onError: (err) => applyFieldErrors(toProblem(err), form.setError) },
        );
      })}
    >
      <h1 className="text-2xl font-semibold">{t('newEvent')}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label={t('venue')} error={e.venueId ? t('required') : undefined} {...form.register('venueId')} data-testid="event-venue">
          <option value="">{t('chooseVenue')}</option>
          {venues.data?.items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.city})
            </option>
          ))}
        </SelectField>
        <TextField label={t('eventTitle')} error={e.title ? t('required') : undefined} {...form.register('title')} data-testid="event-title-input" />
        <TextField label={t('category')} error={e.category ? t('required') : undefined} {...form.register('category')} />
        <TextField label={t('limit')} type="number" min={1} max={50} error={e.perPersonLimit ? t('invalidNumber') : undefined} {...form.register('perPersonLimit')} />
        <TextField label={t('startsAt')} type="datetime-local" error={e.startsAt ? t('required') : undefined} {...form.register('startsAt')} data-testid="event-starts" />
        <TextField label={t('salesStartAt')} type="datetime-local" error={e.salesStartAt ? t('required') : undefined} {...form.register('salesStartAt')} data-testid="event-sales-start" />
      </div>
      <TextAreaField label={t('description')} rows={3} {...form.register('description')} />
      {geometry.data ? (
        <section aria-label={t('pricing')} className="flex flex-col gap-2">
          <h2 className="font-semibold">{t('pricing')}</h2>
          <PricingEditor geometry={geometry.data} onPayload={onPayload} />
        </section>
      ) : (
        <Alert tone="info">{t('pickVenueFirst')}</Alert>
      )}
      {problem ? <Alert tone="error">{problem.message}</Alert> : null}
      <div>
        <Button type="submit" busy={create.isPending} disabled={!pricing} data-testid="event-create">
          {t('createDraft')}
        </Button>
      </div>
    </form>
  );
};
