-- Seeded payments get real records at the payment provider (the stub), so they can be refunded like any other payment.
-- The seed itself does the same (stages/provider.ts uses this exact SQL); on an existing database this converts the
-- old 'seed_<order>' ids. Idempotent: every statement only touches rows that are not converted yet.
CREATE OR REPLACE FUNCTION seed_provider_records() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE payments SET provider_payment_id = 'pay_' || left(md5('pp' || order_id::text), 24)
  WHERE provider_payment_id LIKE 'seed\_%';

  INSERT INTO stub_payments (id, amount, order_ref, status, idempotency_key, request_hash, created_at, updated_at)
  SELECT p.provider_payment_id, p.amount, p.order_id::text, 'succeeded', 'seed-' || p.id, 'seed', p.created_at, p.updated_at
  FROM payments p
  WHERE p.status = 'succeeded' AND p.provider_payment_id = 'pay_' || left(md5('pp' || p.order_id::text), 24)
    AND NOT EXISTS (SELECT 1 FROM stub_payments s WHERE s.id = p.provider_payment_id);

  UPDATE refunds SET provider_refund_id = 'ref_' || left(md5('pr' || id::text), 24)
  WHERE reason = 'seed' AND status = 'succeeded' AND provider_refund_id IS NULL;

  INSERT INTO stub_refunds (id, payment_id, amount, status, idempotency_key, request_hash, reference, created_at, updated_at)
  SELECT r.provider_refund_id, p.provider_payment_id, r.amount, 'succeeded', 'seed-' || r.id, 'seed', r.id::text, r.created_at, r.updated_at
  FROM refunds r JOIN payments p ON p.order_id = r.order_id AND p.status = 'succeeded'
  WHERE r.reason = 'seed' AND r.provider_refund_id = 'ref_' || left(md5('pr' || r.id::text), 24)
    AND NOT EXISTS (SELECT 1 FROM stub_refunds s WHERE s.id = r.provider_refund_id);
END $$;

SELECT seed_provider_records();
