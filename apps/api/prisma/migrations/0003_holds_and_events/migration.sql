-- Live change feed helpers. Each call advances the per-event sequence by the number of rows it writes.
CREATE FUNCTION emit_seat_events(p_event uuid, p_seats bigint[], p_status text, p_held_until timestamptz) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_n integer := COALESCE(array_length(p_seats, 1), 0);
  v_last bigint;
BEGIN
  IF v_n = 0 THEN RETURN NULL; END IF;
  UPDATE events SET seat_seq = seat_seq + v_n WHERE id = p_event RETURNING seat_seq INTO v_last;
  INSERT INTO seat_events (event_id, seq, seat_id, status, held_until)
  SELECT p_event, v_last - v_n + t.ord, t.seat, p_status, p_held_until FROM unnest(p_seats) WITH ORDINALITY AS t(seat, ord);
  RETURN v_last;
END $$;

CREATE FUNCTION emit_zone_event(p_event uuid, p_zone uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_last bigint;
  v_available integer;
BEGIN
  SELECT capacity - sold - held INTO v_available FROM event_zones WHERE event_id = p_event AND zone_id = p_zone;
  UPDATE events SET seat_seq = seat_seq + 1 WHERE id = p_event RETURNING seat_seq INTO v_last;
  INSERT INTO seat_events (event_id, seq, zone_id, status, available) VALUES (p_event, v_last, p_zone, 'zone', v_available);
  RETURN v_last;
END $$;

-- Ends an unpaid order: frees its seats, general-admission places and promo use. Idempotent and safe under
-- concurrency (row lock on the order). Without `p_force` it only acts when the hold really expired by the server clock.
CREATE FUNCTION release_order(p_order uuid, p_force boolean DEFAULT false) RETURNS boolean
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

  PERFORM emit_seat_events(o.event_id, v_freed, 'free', NULL);
  FOR z IN SELECT DISTINCT zone_id FROM order_items WHERE order_id = p_order AND seat_id IS NULL ORDER BY zone_id LOOP
    PERFORM emit_zone_event(o.event_id, z.zone_id);
  END LOOP;
  RETURN true;
END $$;

-- Orders whose hold ran out (by the database clock) and that were not released yet.
CREATE INDEX orders_unreleased_idx ON orders (event_id, hold_expires_at) WHERE status IN ('holding', 'awaiting_payment');
