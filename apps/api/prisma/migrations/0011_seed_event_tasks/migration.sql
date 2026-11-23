-- Events that were not created through the API (the seed) need the same end-of-life tasks that scheduleEventTasks gives
-- every API-created event: mark it finished at its start, pay the organizer 3 days later. Keys and payloads match the API's.
CREATE OR REPLACE FUNCTION seed_event_tasks() RETURNS void LANGUAGE sql AS $$
  INSERT INTO tasks (kind, dedupe_key, payload, run_at)
  SELECT 'event_finish', 'event_finish:' || e.id || ':' || floor(extract(epoch FROM e.starts_at) * 1000)::bigint,
         jsonb_build_object('eventId', e.id, 'startsAtMs', floor(extract(epoch FROM e.starts_at) * 1000)::bigint),
         GREATEST(app_now(), e.starts_at)
  FROM events e WHERE e.status IN ('on_sale', 'sold_out', 'rescheduled')
  ON CONFLICT (dedupe_key) DO NOTHING;
  INSERT INTO tasks (kind, dedupe_key, payload, run_at)
  SELECT 'payout', 'payout:' || e.id || ':' || floor(extract(epoch FROM e.starts_at) * 1000)::bigint,
         jsonb_build_object('eventId', e.id, 'startsAtMs', floor(extract(epoch FROM e.starts_at) * 1000)::bigint),
         GREATEST(app_now(), e.starts_at + interval '3 days')
  FROM events e
  WHERE e.status IN ('on_sale', 'sold_out', 'rescheduled', 'finished')
    AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.event_id = e.id)
  ON CONFLICT (dedupe_key) DO NOTHING;
$$;
SELECT seed_event_tasks();
