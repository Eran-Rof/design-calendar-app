-- supabase/seed.sql
--
-- Staging / local-dev seed for design-calendar-app.
-- Applied automatically by: npx supabase db reset
-- Also applied non-interactively by: node scripts/staging-setup.mjs
-- Idempotent for rows with explicit ids; rows without explicit ids will
-- duplicate on re-run (that's tolerable for staging).
--
-- Does NOT touch auth.users — run scripts/staging-setup.mjs after db reset
-- to create vendor auth users and link them via vendor_users.

DO $$
DECLARE
  -- v_entity_id is resolved at runtime: Phase 8's entity_scoping migration
  -- seeds a "Ring of Fire" row with a random UUID, so we look it up by
  -- slug and fall back to the canonical UUID if no migration-seeded row
  -- exists (e.g. a db reset before the Phase 8 migration ran).
  v_entity_id    uuid;

  v_vendor_a     uuid := 'a0000000-0000-0000-0000-000000000001'::uuid;  -- Sunrise Apparel Co.
  v_vendor_b     uuid := 'a0000000-0000-0000-0000-000000000002'::uuid;  -- Pacific Thread Works
  v_vendor_c     uuid := 'a0000000-0000-0000-0000-000000000003'::uuid;  -- Atlas Manufacturing

  v_po_a1        uuid := 'b0000000-0000-0000-0000-000000000001'::uuid;
  v_po_a2        uuid := 'b0000000-0000-0000-0000-000000000002'::uuid;
  v_po_b1        uuid := 'b0000000-0000-0000-0000-000000000003'::uuid;
  v_po_b2        uuid := 'b0000000-0000-0000-0000-000000000004'::uuid;
  v_po_c1        uuid := 'b0000000-0000-0000-0000-000000000005'::uuid;

  v_line_a1_1    uuid := 'c0000000-0000-0000-0000-000000000001'::uuid;
  v_line_a1_2    uuid := 'c0000000-0000-0000-0000-000000000002'::uuid;
  v_line_a2_1    uuid := 'c0000000-0000-0000-0000-000000000003'::uuid;
  v_line_b1_1    uuid := 'c0000000-0000-0000-0000-000000000004'::uuid;
  v_line_b1_2    uuid := 'c0000000-0000-0000-0000-000000000005'::uuid;
  v_line_b2_1    uuid := 'c0000000-0000-0000-0000-000000000006'::uuid;
  v_line_c1_1    uuid := 'c0000000-0000-0000-0000-000000000007'::uuid;

  v_ship_a1      uuid := 'd0000000-0000-0000-0000-000000000001'::uuid;
  v_ship_a2      uuid := 'd0000000-0000-0000-0000-000000000002'::uuid;
  v_ship_b1      uuid := 'd0000000-0000-0000-0000-000000000003'::uuid;
  v_ship_c1      uuid := 'd0000000-0000-0000-0000-000000000004'::uuid;

  v_inv_a1       uuid := 'f0000000-0000-0000-0000-000000000001'::uuid;
  v_inv_a2       uuid := 'f0000000-0000-0000-0000-000000000002'::uuid;
  v_inv_b1       uuid := 'f0000000-0000-0000-0000-000000000003'::uuid;
  v_inv_b2       uuid := 'f0000000-0000-0000-0000-000000000004'::uuid;
  v_inv_c1       uuid := 'f0000000-0000-0000-0000-000000000005'::uuid;

  v_contract_a   uuid := 'cc000000-0000-0000-0000-000000000001'::uuid;
  v_contract_b   uuid := 'cc000000-0000-0000-0000-000000000002'::uuid;
  v_dispute_1    uuid := 'dd000000-0000-0000-0000-000000000001'::uuid;
  -- Prefixes must be valid hex; "rr" and "ww" were silently invalid
  -- (Postgres rejects them as uuid). Using 9a/9b in their place.
  v_rfq_1        uuid := '9a000000-0000-0000-0000-000000000001'::uuid;
  v_workspace_1  uuid := '9b000000-0000-0000-0000-000000000001'::uuid;

BEGIN

-- ════════════════════════════════════════════════════════════════════════════
-- 1. ENTITY (buyer) — resolve by slug so we reuse the Phase 8 migration row
-- ════════════════════════════════════════════════════════════════════════════
SELECT id INTO v_entity_id FROM entities WHERE slug = 'ring-of-fire' LIMIT 1;
IF v_entity_id IS NULL THEN
  v_entity_id := 'e0000000-0000-0000-0000-000000000001'::uuid;
  INSERT INTO entities (id, name, slug, status)
  VALUES (v_entity_id, 'Ring of Fire Clothing', 'ring-of-fire', 'active');
END IF;

INSERT INTO entity_branding (entity_id, logo_url, primary_color, secondary_color)
VALUES (v_entity_id, '/logo.png', '#1a1a2e', '#e94560')
ON CONFLICT (entity_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. VENDORS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO vendors (id, legacy_blob_id, name, country, transit_days, categories, contact, email, moq)
VALUES
  (v_vendor_a, 'stg-vendor-a', 'Sunrise Apparel Co.',   'CN', 28, '{tops,knitwear}',    'Li Wei',        'li.wei@sunriseapparel.cn',    500),
  (v_vendor_b, 'stg-vendor-b', 'Pacific Thread Works',  'VN', 21, '{bottoms,denim}',    'Nguyen Thi Ha', 'ha@pacificthread.vn',         300),
  (v_vendor_c, 'stg-vendor-c', 'Atlas Manufacturing',   'BD', 35, '{outerwear,fleece}', 'Farhan Ahmed',  'farhan@atlasbd.com',          1000)
ON CONFLICT (id) DO NOTHING;

-- Entity ↔ Vendor links
INSERT INTO entity_vendors (entity_id, vendor_id, relationship_status)
SELECT v_entity_id, vid, 'active'
FROM (VALUES (v_vendor_a), (v_vendor_b), (v_vendor_c)) AS t(vid)
WHERE NOT EXISTS (
  SELECT 1 FROM entity_vendors ev
  WHERE ev.entity_id = v_entity_id AND ev.vendor_id = t.vid
);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PURCHASE ORDERS (tanda_pos)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO tanda_pos (uuid_id, po_number, vendor_id, entity_id, buyer_po, data)
SELECT * FROM (VALUES
  (v_po_a1, 'STG-PO-1001', v_vendor_a, v_entity_id, 'ROF-PO-1001',
   '{"PONumber":"STG-PO-1001","VendorName":"Sunrise Apparel Co.","StatusName":"Approved","TotalAmount":10000,"Currency":"USD","DateOrdered":"2026-02-01"}'::jsonb),
  (v_po_a2, 'STG-PO-1002', v_vendor_a, v_entity_id, 'ROF-PO-1002',
   '{"PONumber":"STG-PO-1002","VendorName":"Sunrise Apparel Co.","StatusName":"Approved","TotalAmount":7492.50,"Currency":"USD","DateOrdered":"2026-03-01"}'::jsonb),
  (v_po_b1, 'STG-PO-2001', v_vendor_b, v_entity_id, 'ROF-PO-2001',
   '{"PONumber":"STG-PO-2001","VendorName":"Pacific Thread Works","StatusName":"Approved","TotalAmount":29995,"Currency":"USD","DateOrdered":"2026-02-15"}'::jsonb),
  (v_po_b2, 'STG-PO-2002', v_vendor_b, v_entity_id, 'ROF-PO-2002',
   '{"PONumber":"STG-PO-2002","VendorName":"Pacific Thread Works","StatusName":"Approved","TotalAmount":18000,"Currency":"USD","DateOrdered":"2026-03-10"}'::jsonb),
  (v_po_c1, 'STG-PO-3001', v_vendor_c, v_entity_id, 'ROF-PO-3001',
   '{"PONumber":"STG-PO-3001","VendorName":"Atlas Manufacturing","StatusName":"Approved","TotalAmount":18750,"Currency":"USD","DateOrdered":"2026-01-20"}'::jsonb)
) AS t(uuid_id, po_number, vendor_id, entity_id, buyer_po, data)
WHERE NOT EXISTS (SELECT 1 FROM tanda_pos WHERE uuid_id = t.uuid_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. PO LINE ITEMS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO po_line_items (id, po_id, line_index, item_number, description, qty_ordered, unit_price)
VALUES
  (v_line_a1_1, v_po_a1, 0, 'TOPS-BLK-M', 'Classic Tee Black M',  300, 20.00),
  (v_line_a1_2, v_po_a1, 1, 'TOPS-BLK-L', 'Classic Tee Black L',  200, 20.00),
  (v_line_a2_1, v_po_a2, 0, 'HOOD-GRY-M', 'Hoodie Grey M',         150, 49.95),
  (v_line_b1_1, v_po_b1, 0, 'DENIM-30',   'Slim Jean W30',         250, 59.99),
  (v_line_b1_2, v_po_b1, 1, 'DENIM-32',   'Slim Jean W32',         250, 59.99),
  (v_line_b2_1, v_po_b2, 0, 'CHINO-30',   'Chino W30',             300, 60.00),
  (v_line_c1_1, v_po_c1, 0, 'FLEECE-BLK-M','Fleece Jacket Black M',150,125.00)
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. SHIPMENTS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO shipments (id, vendor_id, po_number, number, number_type, sealine_scac, sealine_name,
                       pol_locode, pod_locode, eta, ata, current_status)
VALUES
  (v_ship_a1, v_vendor_a, 'STG-PO-1001', 'MAEU123456789', 'BL', 'MAEU', 'Maersk',
   'CNSHA', 'USLAX', now() - interval '10 days', now() - interval '8 days', 'Delivered'),
  (v_ship_a2, v_vendor_a, 'STG-PO-1002', 'COSU987654321', 'BL', 'COSU', 'COSCO',
   'CNNGB', 'USLAX', now() + interval '12 days', null, 'In Transit'),
  (v_ship_b1, v_vendor_b, 'STG-PO-2001', 'HLCU555123456', 'BL', 'HLCU', 'Hapag-Lloyd',
   'VNSGU', 'USLAX', now() - interval '5 days', now() - interval '3 days', 'Delivered'),
  (v_ship_c1, v_vendor_c, 'STG-PO-3001', 'YMLU789012345', 'BL', 'YMLU', 'Yang Ming',
   'BDCGP', 'USLAX', now() + interval '20 days', null, 'In Transit')
ON CONFLICT (id) DO NOTHING;

-- shipment_lines: no semantic unique constraint; guard with NOT EXISTS
INSERT INTO shipment_lines (shipment_id, po_line_item_id, quantity_shipped)
SELECT * FROM (VALUES
  (v_ship_a1, v_line_a1_1, 300::numeric),
  (v_ship_a1, v_line_a1_2, 200::numeric),
  (v_ship_b1, v_line_b1_1, 250::numeric),
  (v_ship_b1, v_line_b1_2, 250::numeric)
) AS t(shipment_id, po_line_item_id, quantity_shipped)
WHERE NOT EXISTS (
  SELECT 1 FROM shipment_lines sl
  WHERE sl.shipment_id = t.shipment_id AND sl.po_line_item_id = t.po_line_item_id
);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. INVOICES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO invoices (id, vendor_id, po_id, invoice_number, invoice_date, due_date,
                      subtotal, tax, total, currency, status, submitted_at)
VALUES
  (v_inv_a1, v_vendor_a, v_po_a1, 'SUN-INV-2026-001', '2026-03-20', '2026-05-20',
   10000.00, 0, 10000.00, 'USD', 'approved',      now() - interval '30 days'),
  (v_inv_a2, v_vendor_a, v_po_a2, 'SUN-INV-2026-002', '2026-04-05', '2026-06-05',
   7492.50,  0,  7492.50, 'USD', 'submitted',     now() - interval '5 days'),
  (v_inv_b1, v_vendor_b, v_po_b1, 'PAC-INV-2026-001', '2026-04-01', '2026-06-01',
   35994.00, 0, 35994.00, 'USD', 'under_review',  now() - interval '15 days'),
  (v_inv_b2, v_vendor_b, v_po_b2, 'PAC-INV-2026-002', '2026-04-10', '2026-06-10',
   18000.00, 0, 18000.00, 'USD', 'approved',      now() - interval '8 days'),
  (v_inv_c1, v_vendor_c, v_po_c1, 'ATL-INV-2026-001', '2026-04-15', '2026-06-30',
   18750.00, 0, 18750.00, 'USD', 'submitted',     now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- invoice_line_items: line_index is NOT NULL; numbered within invoice.
-- No semantic unique; guard with NOT EXISTS on (invoice_id, line_index).
INSERT INTO invoice_line_items (invoice_id, po_line_item_id, line_index, description, quantity_invoiced, unit_price, line_total)
SELECT * FROM (VALUES
  (v_inv_a1, v_line_a1_1, 0, 'Classic Tee Black M', 300::numeric, 20.00::numeric, 6000.00::numeric),
  (v_inv_a1, v_line_a1_2, 1, 'Classic Tee Black L', 200::numeric, 20.00::numeric, 4000.00::numeric),
  (v_inv_a2, v_line_a2_1, 0, 'Hoodie Grey M',        150::numeric, 49.95::numeric, 7492.50::numeric),
  (v_inv_b1, v_line_b1_1, 0, 'Slim Jean W30',        300::numeric, 59.99::numeric,17997.00::numeric),  -- qty discrepancy
  (v_inv_b1, v_line_b1_2, 1, 'Slim Jean W32',        300::numeric, 59.99::numeric,17997.00::numeric),  -- qty discrepancy
  (v_inv_b2, v_line_b2_1, 0, 'Chino W30',            300::numeric, 60.00::numeric,18000.00::numeric),
  (v_inv_c1, v_line_c1_1, 0, 'Fleece Jacket Black M',150::numeric,125.00::numeric,18750.00::numeric)
) AS t(invoice_id, po_line_item_id, line_index, description, quantity_invoiced, unit_price, line_total)
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_line_items ili
  WHERE ili.invoice_id = t.invoice_id AND ili.line_index = t.line_index
);

-- receipts: actual schema is (vendor_id, po_id, shipment_id, receipt_number,
-- received_date, status, xoro_synced_at, ...). No po_line_item_id; line-level
-- qty comes from tanda_pos/po_line_items.qty_received rollup, not this table.
INSERT INTO receipts (vendor_id, po_id, shipment_id, receipt_number, received_date, status, xoro_synced_at)
SELECT * FROM (VALUES
  (v_vendor_a, v_po_a1, v_ship_a1, 'STG-GRN-1001', (now() - interval '42 days')::timestamptz, 'received', now()),
  (v_vendor_b, v_po_b1, v_ship_b1, 'STG-GRN-2001', (now() - interval '28 days')::timestamptz, 'received', now())
) AS t(vendor_id, po_id, shipment_id, receipt_number, received_date, status, xoro_synced_at)
WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.receipt_number = t.receipt_number);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. ONBOARDING
-- onboarding_workflows has no unique on vendor_id; guard with NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO onboarding_workflows (vendor_id, status, current_step, completed_steps,
                                  started_at, completed_at, approved_by)
SELECT * FROM (VALUES
  (v_vendor_a, 'approved',    6, '["company_info","banking","tax","compliance_docs","portal_tour","agreement"]'::jsonb,
   now() - interval '90 days', now() - interval '85 days', 'internal-admin'),
  (v_vendor_b, 'approved',    6, '["company_info","banking","tax","compliance_docs","portal_tour","agreement"]'::jsonb,
   now() - interval '60 days', now() - interval '55 days', 'internal-admin'),
  (v_vendor_c, 'in_progress', 3, '["company_info","banking","tax"]'::jsonb,
   now() - interval '14 days', null, null)
) AS t(vendor_id, status, current_step, completed_steps, started_at, completed_at, approved_by)
WHERE NOT EXISTS (SELECT 1 FROM onboarding_workflows ow WHERE ow.vendor_id = t.vendor_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 8. BANKING DETAILS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO banking_details (vendor_id, account_name, bank_name,
                              account_number_encrypted, account_number_last4,
                              routing_number_encrypted, account_type, currency,
                              verified, verified_at, verified_by)
SELECT * FROM (VALUES
  (v_vendor_a, 'Sunrise Apparel Co.', 'Bank of China',
   '000000000000000000000000:00000000000000000000000000000000:00000000000000000000000000000000', '1234',
   '000000000000000000000000:00000000000000000000000000000000:00000000000000000000000000000000',
   'wire', 'USD', true, now() - interval '80 days', 'internal-admin'),
  (v_vendor_b, 'Pacific Thread Works', 'Vietcombank',
   '111111111111111111111111:11111111111111111111111111111111:11111111111111111111111111111111', '5678',
   '111111111111111111111111:11111111111111111111111111111111:11111111111111111111111111111111',
   'wire', 'USD', true, now() - interval '50 days', 'internal-admin')
) AS t(vendor_id, account_name, bank_name, account_number_encrypted, account_number_last4,
        routing_number_encrypted, account_type, currency, verified, verified_at, verified_by)
WHERE NOT EXISTS (SELECT 1 FROM banking_details bd WHERE bd.vendor_id = t.vendor_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 9. COMPLIANCE DOCUMENTS
-- compliance_document_types has a unique on `code`, not a composite. Use it.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO compliance_document_types (id, code, name, description, required, expiry_required, reminder_days_before, sort_order, active)
VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid, 'factory_audit',     'Factory Audit',      'Annual factory audit report',      true,  true,  30, 1, true),
  ('00000000-0000-0000-0000-000000000002'::uuid, 'oeko_tex',          'OEKO-TEX Certificate','Chemical safety certification',    true,  true,  60, 2, true),
  ('00000000-0000-0000-0000-000000000003'::uuid, 'social_compliance', 'Social Compliance',  'BSCI / SA8000 compliance report',  false, false, 30, 3, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO compliance_documents (vendor_id, document_type_id, status, expiry_date, file_url, notes)
SELECT * FROM (VALUES
  (v_vendor_a, '00000000-0000-0000-0000-000000000001'::uuid, 'approved',
   (CURRENT_DATE + interval '6 months')::date, '/staging/vendor-a-audit.pdf', 'Annual audit 2026'),
  (v_vendor_a, '00000000-0000-0000-0000-000000000002'::uuid, 'approved',
   (CURRENT_DATE + interval '1 year')::date,   '/staging/vendor-a-oeko.pdf',  'OEKO-TEX Standard 100'),
  (v_vendor_b, '00000000-0000-0000-0000-000000000001'::uuid, 'under_review',
   null::date, '/staging/vendor-b-audit.pdf', 'Submitted for review'),
  (v_vendor_c, '00000000-0000-0000-0000-000000000003'::uuid, 'pending',
   null::date, '/staging/vendor-c-social.pdf', 'Requested but not yet submitted')
) AS t(vendor_id, document_type_id, status, expiry_date, file_url, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM compliance_documents cd
  WHERE cd.vendor_id = t.vendor_id AND cd.document_type_id = t.document_type_id
);

-- ════════════════════════════════════════════════════════════════════════════
-- 10. CONTRACTS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO contracts (id, vendor_id, title, status, contract_type,
                       start_date, end_date, value, currency, internal_owner)
VALUES
  (v_contract_a, v_vendor_a, 'Master Vendor Agreement — Sunrise Apparel 2026', 'signed',
   'master_services', '2026-01-01', '2026-12-31', 500000.00, 'USD', 'internal-admin'),
  (v_contract_b, v_vendor_b, 'Master Vendor Agreement — Pacific Thread 2026',  'signed',
   'master_services', '2026-01-01', '2026-12-31', 350000.00, 'USD', 'internal-admin')
ON CONFLICT (id) DO NOTHING;

-- contract_versions: no unique on (contract_id, version_number); guard NOT EXISTS.
INSERT INTO contract_versions (contract_id, version_number, file_url, notes,
                                uploaded_by_type, uploaded_by_internal_id)
SELECT * FROM (VALUES
  (v_contract_a, 1, '/staging/contract-a-v1.pdf', 'Initial execution', 'internal', 'internal-admin'),
  (v_contract_b, 1, '/staging/contract-b-v1.pdf', 'Initial execution', 'internal', 'internal-admin')
) AS t(contract_id, version_number, file_url, notes, uploaded_by_type, uploaded_by_internal_id)
WHERE NOT EXISTS (
  SELECT 1 FROM contract_versions cv
  WHERE cv.contract_id = t.contract_id AND cv.version_number = t.version_number
);

-- ════════════════════════════════════════════════════════════════════════════
-- 11. DISPUTES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO disputes (id, vendor_id, invoice_id, type, status, priority,
                      subject, raised_by_type, raised_by_internal_id)
VALUES
  (v_dispute_1, v_vendor_b, v_inv_b1, 'invoice_discrepancy', 'open', 'high',
   'Qty discrepancy on STG-PO-2001 — invoiced 600 vs 500 received',
   'internal', 'internal-admin')
ON CONFLICT (id) DO NOTHING;

-- dispute_messages: no natural unique; guard via body prefix for re-run safety.
INSERT INTO dispute_messages (dispute_id, sender_type, sender_internal_id, sender_name, body)
SELECT v_dispute_1, 'internal', 'internal-admin', 'Buyer Ops',
       'GRN #STG-GRN-2001 shows 250 received on each line. Please issue a revised invoice for 250 units each.'
WHERE NOT EXISTS (
  SELECT 1 FROM dispute_messages dm
  WHERE dm.dispute_id = v_dispute_1 AND dm.body LIKE 'GRN #STG-GRN-2001%'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 12. VENDOR SCORECARDS
-- No unique on (vendor_id, period_start, period_end); guard NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO vendor_scorecards (vendor_id, period_start, period_end,
                                on_time_delivery_pct, invoice_accuracy_pct,
                                avg_acknowledgment_hours, po_count, invoice_count,
                                discrepancy_count, composite_score)
SELECT * FROM (VALUES
  (v_vendor_a, '2026-01-01'::date, '2026-03-31'::date, 94.0::numeric, 99.0::numeric, 4.5::numeric,  12,  12, 0, 96.0::numeric),
  (v_vendor_b, '2026-01-01'::date, '2026-03-31'::date, 88.0::numeric, 82.0::numeric, 12.0::numeric, 10,  10, 2, 85.0::numeric),
  (v_vendor_c, '2026-01-01'::date, '2026-03-31'::date, 78.0::numeric, 91.0::numeric, 8.0::numeric,   6,   5, 0, 83.0::numeric)
) AS t(vendor_id, period_start, period_end, on_time_delivery_pct, invoice_accuracy_pct,
        avg_acknowledgment_hours, po_count, invoice_count, discrepancy_count, composite_score)
WHERE NOT EXISTS (
  SELECT 1 FROM vendor_scorecards vs
  WHERE vs.vendor_id = t.vendor_id AND vs.period_start = t.period_start AND vs.period_end = t.period_end
);

-- ════════════════════════════════════════════════════════════════════════════
-- 13. CURRENCY RATES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO currency_rates (from_currency, to_currency, rate, source, snapshotted_at)
SELECT * FROM (VALUES
  ('USD', 'EUR', 0.92150000::numeric, 'manual', now()),
  ('USD', 'CNY', 7.24800000::numeric, 'manual', now()),
  ('USD', 'GBP', 0.78900000::numeric, 'manual', now()),
  ('USD', 'VND', 24850.00000000::numeric, 'manual', now()),
  ('USD', 'BDT', 109.50000000::numeric,   'manual', now()),
  ('EUR', 'USD', 1.08510000::numeric, 'manual', now()),
  ('CNY', 'USD', 0.13800000::numeric, 'manual', now())
) AS t(from_currency, to_currency, rate, source, snapshotted_at)
WHERE NOT EXISTS (
  SELECT 1 FROM currency_rates cr
  WHERE cr.from_currency = t.from_currency
    AND cr.to_currency   = t.to_currency
    AND cr.source        = t.source
    AND cr.snapshotted_at::date = t.snapshotted_at::date
);

-- ════════════════════════════════════════════════════════════════════════════
-- 14. TAX RULES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO tax_rules (entity_id, jurisdiction, tax_type, rate_pct, applies_to, effective_from)
SELECT * FROM (VALUES
  (v_entity_id, 'US-CA', 'sales_tax',   7.25::numeric, 'goods',    '2026-01-01'::date),
  (v_entity_id, 'US',    'withholding', 0.00::numeric, 'services', '2026-01-01'::date),
  (v_entity_id, 'VN',    'withholding', 5.00::numeric, 'services', '2026-01-01'::date)
) AS t(entity_id, jurisdiction, tax_type, rate_pct, applies_to, effective_from)
WHERE NOT EXISTS (
  SELECT 1 FROM tax_rules tr
  WHERE tr.entity_id = t.entity_id AND tr.jurisdiction = t.jurisdiction
    AND tr.tax_type = t.tax_type AND tr.effective_from = t.effective_from
);

-- ════════════════════════════════════════════════════════════════════════════
-- 15. DYNAMIC DISCOUNT OFFERS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO dynamic_discount_offers (entity_id, vendor_id, invoice_id, status,
                                      original_due_date, early_payment_date,
                                      discount_pct, discount_amount, net_payment_amount,
                                      offered_at, expires_at)
SELECT v_entity_id, v_vendor_a, v_inv_a1, 'offered',
       '2026-05-20'::date, '2026-04-24'::date,
       0.821, 82.10, 9917.90, now(), (now() + interval '2 days')::timestamptz
WHERE NOT EXISTS (
  SELECT 1 FROM dynamic_discount_offers ddo
  WHERE ddo.invoice_id = v_inv_a1
);

-- ════════════════════════════════════════════════════════════════════════════
-- 16. SUPPLY CHAIN FINANCE PROGRAM
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO supply_chain_finance_programs (entity_id, name, funder_name,
                                            max_facility_amount, current_utilization,
                                            base_rate_pct, status)
SELECT v_entity_id, 'Ring of Fire SCF Program', 'Wells Fargo Trade Finance',
       5000000.00, 0.00, 4.500, 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM supply_chain_finance_programs p
  WHERE p.entity_id = v_entity_id AND p.name = 'Ring of Fire SCF Program'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 17. RFQ
-- rfq_line_items schema: line_index, description, quantity, unit_of_measure,
-- specifications. No item_number / target_unit_price columns.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO rfqs (id, entity_id, title, description, status,
                  submission_deadline, currency, created_by)
VALUES
  (v_rfq_1, v_entity_id,
   'Q3 2026 Fleece Jacket — 2000 units',
   'Requesting quotes for 2000 units of heavyweight fleece jackets, various sizes, for Q3 delivery.',
   'published', (now() + interval '14 days')::timestamptz, 'USD', 'internal-buyer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rfq_line_items (rfq_id, line_index, description, quantity, unit_of_measure, specifications)
SELECT * FROM (VALUES
  (v_rfq_1, 0, 'Heavyweight Fleece Jacket — M  (target $110/ea)',  800, 'ea', 'SKU FLEECE-Q3-M; target unit price $110.00'),
  (v_rfq_1, 1, 'Heavyweight Fleece Jacket — L  (target $110/ea)',  800, 'ea', 'SKU FLEECE-Q3-L; target unit price $110.00'),
  (v_rfq_1, 2, 'Heavyweight Fleece Jacket — XL (target $115/ea)',  400, 'ea', 'SKU FLEECE-Q3-XL; target unit price $115.00')
) AS t(rfq_id, line_index, description, quantity, unit_of_measure, specifications)
WHERE NOT EXISTS (
  SELECT 1 FROM rfq_line_items rli WHERE rli.rfq_id = t.rfq_id AND rli.line_index = t.line_index
);

INSERT INTO rfq_invitations (rfq_id, vendor_id, status, invited_at)
SELECT * FROM (VALUES
  (v_rfq_1, v_vendor_b, 'invited', now() - interval '3 days'),
  (v_rfq_1, v_vendor_c, 'invited', now() - interval '3 days')
) AS t(rfq_id, vendor_id, status, invited_at)
WHERE NOT EXISTS (
  SELECT 1 FROM rfq_invitations ri WHERE ri.rfq_id = t.rfq_id AND ri.vendor_id = t.vendor_id
);

-- ════════════════════════════════════════════════════════════════════════════
-- 18. COLLABORATION WORKSPACE
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO collaboration_workspaces (id, entity_id, vendor_id, name, description, status, created_by)
VALUES
  (v_workspace_1, v_entity_id, v_vendor_a,
   'Spring 2027 Development',
   'Shared workspace for Spring 2027 collection development with Sunrise Apparel',
   'active', 'internal-buyer')
ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 19. AI INSIGHTS
-- data_snapshot / generated_at / expires_at are NOT NULL — supply values.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO ai_insights (entity_id, vendor_id, type, title, summary, status,
                          confidence_pct, data_snapshot, generated_at, expires_at)
SELECT * FROM (VALUES
  (v_entity_id, v_vendor_b, 'risk_alert',
   'Invoice accuracy declining — Pacific Thread Works',
   'Pacific Thread Works has submitted invoices with quantity discrepancies totalling $11,994. Pattern suggests systemic over-billing vs. goods received.',
   'new', 88.00::numeric, '{"trigger":"invoice_accuracy_declining"}'::jsonb, now(), now() + interval '30 days'),
  (v_entity_id, v_vendor_a, 'cost_saving',
   'Dynamic discounting opportunity — save $82 on SUN-INV-2026-001',
   'Early payment at 0.82% captures $82 while yielding ~10.2% annualized return on the early payment amount.',
   'new', 95.00::numeric, '{"trigger":"dynamic_discount_opportunity"}'::jsonb, now(), now() + interval '30 days')
) AS t(entity_id, vendor_id, type, title, summary, status, confidence_pct,
        data_snapshot, generated_at, expires_at)
WHERE NOT EXISTS (
  SELECT 1 FROM ai_insights ai
  WHERE ai.entity_id = t.entity_id AND ai.vendor_id = t.vendor_id AND ai.type = t.type AND ai.title = t.title
);

-- ════════════════════════════════════════════════════════════════════════════
-- 20. ANOMALY FLAGS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO anomaly_flags (vendor_id, entity_type, entity_id, type,
                            severity, description, status, detected_at)
SELECT v_vendor_b, 'invoice', v_inv_b1, 'unusual_volume',
       'high',
       'PAC-INV-2026-001 invoices 600 total units across two lines; GRN records only 500 received. Discrepancy: 100 units (~17%).',
       'open', now() - interval '14 days'
WHERE NOT EXISTS (
  SELECT 1 FROM anomaly_flags af
  WHERE af.vendor_id = v_vendor_b AND af.entity_id = v_inv_b1 AND af.type = 'unusual_volume'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 21. ESG SCORES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO esg_scores (vendor_id, period_start, period_end,
                         environmental_score, social_score, governance_score, overall_score,
                         score_breakdown)
SELECT * FROM (VALUES
  (v_vendor_a, '2026-01-01'::date, '2026-03-31'::date, 78.00::numeric, 85.00::numeric, 90.00::numeric, 84.00::numeric,
   '{"carbon_reduction_target":true,"water_reporting":true,"living_wage":true}'::jsonb),
  (v_vendor_b, '2026-01-01'::date, '2026-03-31'::date, 65.00::numeric, 80.00::numeric, 75.00::numeric, 73.00::numeric,
   '{"carbon_reduction_target":false,"water_reporting":false,"living_wage":true}'::jsonb)
) AS t(vendor_id, period_start, period_end, environmental_score, social_score,
        governance_score, overall_score, score_breakdown)
WHERE NOT EXISTS (
  SELECT 1 FROM esg_scores es
  WHERE es.vendor_id = t.vendor_id AND es.period_start = t.period_start AND es.period_end = t.period_end
);

-- ════════════════════════════════════════════════════════════════════════════
-- 22. DIVERSITY PROFILES
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO diversity_profiles (vendor_id, business_type, certifying_body,
                                 certification_number, verified, verified_at, verified_by)
SELECT v_vendor_a, ARRAY['women_owned'], 'WBENC', 'WBENC-2026-001234',
       true, now() - interval '80 days', 'internal-admin'
WHERE NOT EXISTS (SELECT 1 FROM diversity_profiles dp WHERE dp.vendor_id = v_vendor_a);

-- ════════════════════════════════════════════════════════════════════════════
-- 23. BENCHMARK DATA
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO benchmark_data (category, metric, percentile_25, percentile_50, percentile_75, percentile_90,
                             sample_size, period_start, period_end)
SELECT * FROM (VALUES
  ('tops',      'unit_price',    15.00::numeric,  18.50::numeric,  23.00::numeric,  28.00::numeric,  85, '2026-01-01'::date, '2026-03-31'::date),
  ('bottoms',   'unit_price',    42.00::numeric,  55.00::numeric,  68.00::numeric,  82.00::numeric,  62, '2026-01-01'::date, '2026-03-31'::date),
  ('outerwear', 'unit_price',    85.00::numeric, 115.00::numeric, 145.00::numeric, 190.00::numeric,  48, '2026-01-01'::date, '2026-03-31'::date),
  ('all',       'on_time_pct',   78.00::numeric,  88.00::numeric,  93.00::numeric,  97.00::numeric, 195, '2026-01-01'::date, '2026-03-31'::date),
  ('all',       'lead_time',     18.00::numeric,  28.00::numeric,  38.00::numeric,  55.00::numeric, 195, '2026-01-01'::date, '2026-03-31'::date)
) AS t(category, metric, percentile_25, percentile_50, percentile_75, percentile_90,
        sample_size, period_start, period_end)
WHERE NOT EXISTS (
  SELECT 1 FROM benchmark_data bd
  WHERE bd.category = t.category AND bd.metric = t.metric
    AND bd.period_start = t.period_start AND bd.period_end = t.period_end
);

-- ════════════════════════════════════════════════════════════════════════════
-- 24. CATALOG ITEMS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO catalog_items (vendor_id, sku, name, unit_price, currency,
                            min_order_quantity, lead_time_days, status, category)
SELECT * FROM (VALUES
  (v_vendor_a, 'SUN-TEE-001',  'Classic Tee — Black',       18.50::numeric, 'USD', 300, 28, 'active', 'tops'),
  (v_vendor_a, 'SUN-HOOD-001', 'Pullover Hoodie — Grey',    44.00::numeric, 'USD', 150, 35, 'active', 'tops'),
  (v_vendor_b, 'PAC-JEAN-001', 'Slim Jean — Various',       55.00::numeric, 'USD', 200, 21, 'active', 'bottoms'),
  (v_vendor_c, 'ATL-FLC-001',  'Fleece Jacket — Black',    115.00::numeric, 'USD', 100, 42, 'active', 'outerwear')
) AS t(vendor_id, sku, name, unit_price, currency, min_order_quantity, lead_time_days, status, category)
WHERE NOT EXISTS (
  SELECT 1 FROM catalog_items ci WHERE ci.vendor_id = t.vendor_id AND ci.sku = t.sku
);

-- ════════════════════════════════════════════════════════════════════════════
-- 25. ERP INTEGRATION CONFIG
-- Column is `type`, not `erp_type`.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO erp_integrations (vendor_id, type, config, status)
SELECT v_vendor_a, 'edi_x12',
       '{"partner_id":"SUNRISE01","isa_id":"SUNRISE001","functional_groups":["850","855","856","810"]}'::jsonb,
       'active'
WHERE NOT EXISTS (
  SELECT 1 FROM erp_integrations ei WHERE ei.vendor_id = v_vendor_a AND ei.type = 'edi_x12'
);

-- ════════════════════════════════════════════════════════════════════════════
-- 26. NOTIFICATIONS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO notifications (recipient_internal_id, event_type, title, body, link, email_status)
SELECT * FROM (VALUES
  ('internal-admin', 'invoice.submitted',
   'New invoice from Sunrise Apparel', 'SUN-INV-2026-002 submitted for $7,492.50',
   '/invoices', 'skipped'),
  ('internal-admin', 'match.discrepancy',
   'Invoice discrepancy — Pacific Thread Works',
   'PAC-INV-2026-001 invoiced 600 units vs 500 received',
   '/invoices', 'skipped'),
  ('internal-admin', 'vendor.onboarding_approved',
   'Onboarding approved — Sunrise Apparel', 'Vendor onboarding complete and approved',
   '/vendors', 'skipped')
) AS t(recipient_internal_id, event_type, title, body, link, email_status)
WHERE NOT EXISTS (
  SELECT 1 FROM notifications n
  WHERE n.recipient_internal_id = t.recipient_internal_id
    AND n.event_type = t.event_type AND n.title = t.title
);

END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Planning fixtures (re-use existing files)
-- ════════════════════════════════════════════════════════════════════════════
\ir seed/inventory_planning_phase1_fixtures.sql
\ir seed/inventory_planning_phase2_fixtures.sql
\ir seed/inventory_planning_phase3_fixtures.sql
