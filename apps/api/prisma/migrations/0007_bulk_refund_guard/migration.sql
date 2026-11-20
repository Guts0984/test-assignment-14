-- Event cancellation inserts tens of thousands of refund items in one statement, built from rows that cannot
-- violate the rules (only unrefunded items, exact paid amounts). It switches the per-row guard off for its own
-- transaction (`SET LOCAL`) and re-checks the order-level sums itself afterwards. The unique index and CHECK
-- constraints stay in force.
CREATE OR REPLACE FUNCTION guard_refund_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_item order_items%ROWTYPE;
  v_order_id uuid;
  v_order_total integer;
  v_active bigint;
BEGIN
  IF current_setting('app.trusted_bulk', true) = 'on' THEN RETURN NEW; END IF;
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
