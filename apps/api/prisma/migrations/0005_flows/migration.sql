-- Orders never go back from awaiting_payment to holding (the buyer pays or the hold expires).
CREATE OR REPLACE FUNCTION guard_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('holding', 'awaiting_payment'), ('holding', 'expired'),
      ('awaiting_payment', 'expired'), ('awaiting_payment', 'paid'), ('expired', 'paid'),
      ('expired', 'refunded'), ('paid', 'partially_refunded'), ('paid', 'refunded'),
      ('partially_refunded', 'refunded'), ('awaiting_payment', 'refunded')
    ) AS allowed(f, t) WHERE allowed.f = OLD.status::text AND allowed.t = NEW.status::text
  ) THEN
    RAISE EXCEPTION 'illegal order transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.hold_expires_at IS NOT NULL AND NEW.hold_expires_at IS DISTINCT FROM OLD.hold_expires_at THEN
    RAISE EXCEPTION 'hold_expires_at is fixed once set (adding seats never extends the hold)' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := app_now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Waitlist: one offer at a time per event, 30 minutes (RULES.waitlistOfferTtlMs, checked by a test), and the
-- offered seat is reserved for that person while the offer is alive.
-- ---------------------------------------------------------------------------
CREATE FUNCTION waitlist_offer_next(p_event uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_entry waitlist_entries%ROWTYPE;
  v_seat bigint;
  v_zone uuid;
  v_offer uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('waitlist:' || p_event, 0));

  WITH stale AS (
    UPDATE waitlist_offers SET status = 'expired' WHERE event_id = p_event AND status = 'active' AND expires_at <= app_now() RETURNING id, entry_id
  ), unreserve AS (
    UPDATE event_seats SET reserved_for_offer_id = NULL WHERE event_id = p_event AND reserved_for_offer_id IN (SELECT id FROM stale) RETURNING 1
  )
  UPDATE waitlist_entries SET status = 'left' WHERE id IN (SELECT entry_id FROM stale);

  IF EXISTS (SELECT 1 FROM waitlist_offers WHERE event_id = p_event AND status = 'active') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event AND status IN ('on_sale', 'sold_out', 'rescheduled')) THEN RETURN NULL; END IF;

  FOR v_entry IN SELECT * FROM waitlist_entries WHERE event_id = p_event AND status = 'waiting' ORDER BY seq FOR UPDATE SKIP LOCKED LOOP
    v_seat := NULL;
    v_zone := NULL;
    SELECT es.seat_id INTO v_seat FROM event_seats es
    WHERE es.event_id = p_event AND (v_entry.zone_id IS NULL OR es.zone_id = v_entry.zone_id)
      AND es.reserved_for_offer_id IS NULL
      AND (es.status = 'free' OR (es.status = 'held' AND es.hold_expires_at <= app_now()))
    ORDER BY es.seat_id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF v_seat IS NULL THEN
      SELECT ez.zone_id INTO v_zone FROM event_zones ez JOIN zones z ON z.id = ez.zone_id
      WHERE ez.event_id = p_event AND z.kind = 'general' AND (v_entry.zone_id IS NULL OR ez.zone_id = v_entry.zone_id)
        AND ez.capacity - ez.sold - ez.held > 0 LIMIT 1;
    END IF;
    IF v_seat IS NULL AND v_zone IS NULL THEN RETURN NULL; END IF;

    INSERT INTO waitlist_offers (entry_id, event_id, user_id, seat_id, zone_id, expires_at)
    VALUES (v_entry.id, p_event, v_entry.user_id, v_seat, v_zone, app_now() + interval '30 minutes') RETURNING id INTO v_offer;
    IF v_seat IS NOT NULL THEN
      UPDATE event_seats SET reserved_for_offer_id = v_offer WHERE event_id = p_event AND seat_id = v_seat;
    END IF;
    UPDATE waitlist_entries SET status = 'offered' WHERE id = v_entry.id;
    INSERT INTO tasks (kind, dedupe_key, run_at, payload)
    VALUES ('waitlist_expire', 'waitlist_expire:' || v_offer, app_now() + interval '30 minutes', jsonb_build_object('eventId', p_event, 'offerId', v_offer))
    ON CONFLICT (dedupe_key) DO NOTHING;
    INSERT INTO tasks (kind, dedupe_key, payload)
    VALUES ('email', 'email:waitlist:' || v_offer, jsonb_build_object('template', 'waitlist_offer', 'userId', v_entry.user_id, 'eventId', p_event, 'offerId', v_offer))
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN v_offer;
  END LOOP;
  RETURN NULL;
END $$;

-- release_order now also offers the freed seat to the waitlist.
CREATE OR REPLACE FUNCTION release_order(p_order uuid, p_force boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  v_freed bigint[];
  z record;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR o.status NOT IN ('holding', 'awaiting_payment') THEN RETURN false; END IF;
  IF NOT p_force AND (o.hold_expires_at IS NULL OR o.hold_expires_at > app_now()) THEN RETURN false; END IF;

  WITH freed AS (
    UPDATE event_seats SET status = 'free', hold_order_id = NULL, hold_expires_at = NULL
    WHERE hold_order_id = p_order RETURNING seat_id
  ) SELECT array_agg(seat_id ORDER BY seat_id) INTO v_freed FROM freed;

  FOR z IN SELECT zone_id, COUNT(*)::int AS n FROM order_items WHERE order_id = p_order AND seat_id IS NULL GROUP BY zone_id ORDER BY zone_id LOOP
    UPDATE event_zones SET held = GREATEST(0, held - z.n) WHERE event_id = o.event_id AND zone_id = z.zone_id;
  END LOOP;

  IF o.promo_held AND o.promo_id IS NOT NULL THEN
    UPDATE promo_codes SET used_count = used_count - 1 WHERE id = o.promo_id AND used_count > 0;
  END IF;

  UPDATE orders SET status = 'expired', promo_held = false WHERE id = p_order;
  INSERT INTO order_history (order_id, actor_role, type, data)
  VALUES (p_order, 'system', CASE WHEN p_force THEN 'hold_released' ELSE 'hold_expired' END, '{}');
  UPDATE queue_entries SET status = 'done', finished_at = app_now() WHERE event_id = o.event_id AND user_id = o.user_id AND status = 'selecting';

  PERFORM emit_seat_events(o.event_id, v_freed, 'free', NULL);
  FOR z IN SELECT DISTINCT zone_id FROM order_items WHERE order_id = p_order AND seat_id IS NULL ORDER BY zone_id LOOP
    PERFORM emit_zone_event(o.event_id, z.zone_id);
  END LOOP;
  IF EXISTS (SELECT 1 FROM waitlist_entries WHERE event_id = o.event_id AND status = 'waiting') THEN
    PERFORM waitlist_offer_next(o.event_id);
  END IF;
  RETURN true;
END $$;

CREATE INDEX tickets_scan_idx ON tickets (event_id) WHERE status = 'valid' AND entered_at IS NULL;
CREATE INDEX refunds_event_idx ON refunds (order_id, status);
