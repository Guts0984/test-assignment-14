-- ============================================================================
-- Ledger integrity
-- ============================================================================

-- Rows of the journal are append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: the table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER order_history_append_only BEFORE UPDATE OR DELETE ON order_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ticket_scans_append_only BEFORE UPDATE OR DELETE ON ticket_scans
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every transaction must sum to zero and have at least two entries. Checked at COMMIT.
CREATE FUNCTION check_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_sum bigint;
  v_count integer;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO v_sum, v_count FROM ledger_entries WHERE txn_id = NEW.txn_id;
  IF v_sum <> 0 OR v_count < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%, entries=%)', NEW.txn_id, v_sum, v_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_txn_balanced();

-- Balances and the daily rollup are maintained from the entries only.
CREATE FUNCTION ledger_entry_applied() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  INSERT INTO ledger_daily (account_id, day, debit, credit)
  VALUES (NEW.account_id, (NEW.created_at AT TIME ZONE 'UTC')::date, GREATEST(NEW.amount, 0), GREATEST(-NEW.amount, 0))
  ON CONFLICT (account_id, day) DO UPDATE
    SET debit = ledger_daily.debit + EXCLUDED.debit, credit = ledger_daily.credit + EXCLUDED.credit;
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_applied();

-- Balances can only change as a consequence of a ledger entry (trigger depth > 1).
CREATE FUNCTION guard_account_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'account balance may only change through ledger entries' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account_balance();

-- ---------------------------------------------------------------------------
-- Posting functions. Idempotent: one ledger transaction per (kind, ref_id).
-- Entries: debit positive, credit negative.
--   entries = [{account, kind, amount, event_id, order_id}]
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_post(p_kind text, p_ref uuid, p_entries jsonb) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_txn uuid;
BEGIN
  INSERT INTO ledger_transactions (kind, ref_id) VALUES (p_kind, p_ref)
  ON CONFLICT (kind, ref_id) DO NOTHING RETURNING id INTO v_txn;
  IF v_txn IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO accounts (code, kind)
  SELECT DISTINCT e->>'account', e->>'kind' FROM jsonb_array_elements(p_entries) e
  ORDER BY 1
  ON CONFLICT (code) DO NOTHING;

  -- consistent account order avoids deadlocks between concurrent postings
  INSERT INTO ledger_entries (txn_id, account_id, amount, event_id, order_id)
  SELECT v_txn, a.id, (e->>'amount')::bigint, NULLIF(e->>'event_id', '')::uuid, NULLIF(e->>'order_id', '')::uuid
  FROM jsonb_array_elements(p_entries) e
  JOIN accounts a ON a.code = e->>'account'
  WHERE (e->>'amount')::bigint <> 0
  ORDER BY a.code;
  RETURN true;
END $$;

CREATE FUNCTION post_payment(p_payment uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_event events%ROWTYPE;
  v_amount integer;
  v_price bigint;
  v_fee bigint;
  v_posted boolean;
BEGIN
  SELECT amount INTO v_amount FROM payments WHERE id = p_payment;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment; END IF;
  SELECT o.* INTO v_order FROM orders o JOIN payments p ON p.order_id = o.id WHERE p.id = p_payment;
  SELECT * INTO v_event FROM events WHERE id = v_order.event_id;
  SELECT COALESCE(SUM(price - discount), 0), COALESCE(SUM(fee), 0) INTO v_price, v_fee FROM order_items WHERE order_id = v_order.id;
  IF v_amount <> v_price + v_fee THEN
    RAISE EXCEPTION 'payment amount % does not match order items %', v_amount, v_price + v_fee;
  END IF;

  v_posted := ledger_post('payment', p_payment, jsonb_build_array(
    jsonb_build_object('account', 'provider_cash', 'kind', 'asset', 'amount', v_price + v_fee, 'event_id', v_event.id, 'order_id', v_order.id),
    jsonb_build_object('account', 'organizer_payable:' || v_event.organizer_id, 'kind', 'liability', 'amount', -v_price, 'event_id', v_event.id, 'order_id', v_order.id),
    jsonb_build_object('account', 'service_fee_revenue', 'kind', 'revenue', 'amount', -v_fee, 'event_id', v_event.id, 'order_id', v_order.id)
  ));

  IF v_posted THEN
    INSERT INTO sales_hourly (event_id, zone_id, hour, organizer_id, tickets, gross, fees)
    SELECT v_event.id, i.zone_id, date_trunc('hour', app_now()), v_event.organizer_id, COUNT(*), SUM(i.price - i.discount), SUM(i.fee)
    FROM order_items i WHERE i.order_id = v_order.id GROUP BY i.zone_id
    ORDER BY i.zone_id
    ON CONFLICT (event_id, zone_id, hour) DO UPDATE
      SET tickets = sales_hourly.tickets + EXCLUDED.tickets, gross = sales_hourly.gross + EXCLUDED.gross, fees = sales_hourly.fees + EXCLUDED.fees;
  END IF;
  RETURN v_posted;
END $$;

CREATE FUNCTION post_refund(p_refund uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_refund refunds%ROWTYPE;
  v_event events%ROWTYPE;
  v_posted boolean;
BEGIN
  SELECT * INTO v_refund FROM refunds WHERE id = p_refund;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund % not found', p_refund; END IF;
  SELECT e.* INTO v_event FROM events e JOIN orders o ON o.event_id = e.id WHERE o.id = v_refund.order_id;

  v_posted := ledger_post('refund', p_refund, jsonb_build_array(
    jsonb_build_object('account', 'organizer_payable:' || v_event.organizer_id, 'kind', 'liability', 'amount', v_refund.price_amount, 'event_id', v_event.id, 'order_id', v_refund.order_id),
    jsonb_build_object('account', 'service_fee_revenue', 'kind', 'revenue', 'amount', v_refund.fee_amount, 'event_id', v_event.id, 'order_id', v_refund.order_id),
    jsonb_build_object('account', 'provider_cash', 'kind', 'asset', 'amount', -v_refund.amount, 'event_id', v_event.id, 'order_id', v_refund.order_id)
  ));

  IF v_posted THEN
    INSERT INTO sales_hourly (event_id, zone_id, hour, organizer_id, refunded_tickets, refunds)
    SELECT v_event.id, i.zone_id, date_trunc('hour', app_now()), v_event.organizer_id, COUNT(*), SUM(ri.price_amount + ri.fee_amount)
    FROM refund_items ri JOIN order_items i ON i.id = ri.order_item_id
    WHERE ri.refund_id = p_refund GROUP BY i.zone_id
    ORDER BY i.zone_id
    ON CONFLICT (event_id, zone_id, hour) DO UPDATE
      SET refunded_tickets = sales_hourly.refunded_tickets + EXCLUDED.refunded_tickets, refunds = sales_hourly.refunds + EXCLUDED.refunds;
  END IF;
  RETURN v_posted;
END $$;

CREATE FUNCTION post_payout(p_payout uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_payout payouts%ROWTYPE;
BEGIN
  SELECT * INTO v_payout FROM payouts WHERE id = p_payout;
  IF NOT FOUND THEN RAISE EXCEPTION 'payout % not found', p_payout; END IF;
  RETURN ledger_post('payout', p_payout, jsonb_build_array(
    jsonb_build_object('account', 'organizer_payable:' || v_payout.organizer_id, 'kind', 'liability', 'amount', v_payout.sales - v_payout.refunds, 'event_id', v_payout.event_id),
    jsonb_build_object('account', 'commission_revenue', 'kind', 'revenue', 'amount', -v_payout.commission, 'event_id', v_payout.event_id),
    jsonb_build_object('account', 'payout_cash', 'kind', 'asset', 'amount', -v_payout.amount, 'event_id', v_payout.event_id)
  ));
END $$;

-- ============================================================================
-- Refund guards: a ticket's refund can never exceed what was paid for it
-- ============================================================================
CREATE FUNCTION guard_refund_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_item order_items%ROWTYPE;
  v_order_id uuid;
  v_order_total integer;
  v_active bigint;
BEGIN
  SELECT * INTO v_item FROM order_items WHERE id = NEW.order_item_id;
  SELECT order_id INTO v_order_id FROM refunds WHERE id = NEW.refund_id;
  IF v_item.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'refund item does not belong to the refund order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.price_amount > v_item.price - v_item.discount OR NEW.fee_amount > v_item.fee THEN
    RAISE EXCEPTION 'refund item exceeds the amount paid for the ticket' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT total INTO v_order_total FROM orders WHERE id = v_order_id;
  SELECT COALESCE(SUM(ri.price_amount + ri.fee_amount), 0) INTO v_active
  FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
  WHERE r.order_id = v_order_id AND ri.active AND ri.id <> NEW.id;
  IF NEW.active AND v_active + NEW.price_amount + NEW.fee_amount > v_order_total THEN
    RAISE EXCEPTION 'refunds exceed the amount paid for the order' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refund_items_guard BEFORE INSERT ON refund_items
  FOR EACH ROW EXECUTE FUNCTION guard_refund_item();

-- ============================================================================
-- State machine guards (mirror packages/shared/src/state/transitions.ts; a test compares both)
-- ============================================================================
CREATE FUNCTION guard_order_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('holding', 'awaiting_payment'), ('awaiting_payment', 'holding'), ('holding', 'expired'),
      ('awaiting_payment', 'expired'), ('awaiting_payment', 'paid'), ('expired', 'paid'),
      ('expired', 'refunded'), ('paid', 'partially_refunded'), ('paid', 'refunded'),
      ('partially_refunded', 'refunded')
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

CREATE TRIGGER orders_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_update();

CREATE FUNCTION guard_event_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('draft', 'on_sale'), ('draft', 'cancelled'), ('on_sale', 'sold_out'), ('sold_out', 'on_sale'),
      ('on_sale', 'rescheduled'), ('sold_out', 'rescheduled'), ('on_sale', 'cancelled'),
      ('sold_out', 'cancelled'), ('rescheduled', 'cancelled'), ('on_sale', 'finished'),
      ('sold_out', 'finished'), ('rescheduled', 'finished'), ('finished', 'paid_out')
    ) AS allowed(f, t) WHERE allowed.f = OLD.status::text AND allowed.t = NEW.status::text
  ) THEN
    RAISE EXCEPTION 'illegal event transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_guard BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION guard_event_update();
