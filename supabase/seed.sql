-- supabase/seed.sql
--
-- Staging / local-dev seed for design-calendar-app.
-- Applied automatically by: npx supabase db reset
-- Idempotent: every insert uses ON CONFLICT DO NOTHING.
--
-- Does NOT touch auth.users — run scripts/staging-setup.mjs after db reset
-- to create vendor auth users and link them via vendor_users.

DO $$
DECLARE
  -- ── Stable UUIDs (chosen once, never changed) ─────────────────────────────
  v_entity_id    uuid := 'e0000000-0000-0000-0000-000000000001'::uuid;

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
  v_rfq_1        uuid := 'rr000000-0000-0000-0000-000000000001'::uuid;
  v_workspace_1  uuid := 'ww000000-0000-0000-0000-000000000001'::uuid;

BEGIN

-- ════════════════════════════════════════════════════════════════════════════
-- 1. ENTITY (buyer)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO entities (id, name, slug, status)
VALUES (v_entity_id, 'Ring of Fire Clothing', 'ring-of-fire', 'active')
ON CONFLICT (id) DO NOTHING;

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
VALUES
  (v_entity_id, v_vendor_a, 'active'),
  (v_entity_id, v_vendor_b, 'active'),
  (v_entity_id, v_vendor_c, 'active')
ON CONFLICT (entity_id, vendor_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PURCHASE ORDERS (tanda_pos)
-- Columns: po_number, vendor_id, uuid_id, entity_id, buyer_po, data (jsonb)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO tanda_pos (uuid_id, po_number, vendor_id, entity_id, buyer_po, data)
VALUES
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
ON CONFLICT (po_number) DO NOTHING;

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

INSERT INTO shipment_lines (shipment_id, po_line_item_id, qty_shipped)
VALUES
  (v_ship_a1, v_line_a1_1, 300),
  (v_ship_a1, v_line_a1_2, 200),
  (v_ship_b1, v_line_b1_1, 250),
  (v_ship_b1, v_line_b1_2, 250)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. INVOICES
-- Mix of statuses: approved (matched), submitted, under_review (discrepancy)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO invoices (id, vendor_id, po_id, invoice_number, invoice_date, due_date,
                      subtotal, tax, total, currency, status, submitted_at)
VALUES
  -- inv_a1: fully matched (300+200 received == invoiced, correct price)
  (v_inv_a1, v_vendor_a, v_po_a1, 'SUN-INV-2026-001', '2026-03-20', '2026-05-20',
   10000.00, 0, 10000.00, 'USD', 'approved',      now() - interval '30 days'),
  -- inv_a2: hoodie PO, in review (shipment still in transit → awaiting_invoice)
  (v_inv_a2, v_vendor_a, v_po_a2, 'SUN-INV-2026-002', '2026-04-05', '2026-06-05',
   7492.50,  0,  7492.50, 'USD', 'submitted',     now() - interval '5 days'),
  -- inv_b1: discrepancy — invoiced 300 each but 250 each were received
  (v_inv_b1, v_vendor_b, v_po_b1, 'PAC-INV-2026-001', '2026-04-01', '2026-06-01',
   35994.00, 0, 35994.00, 'USD', 'under_review',  now() - interval '15 days'),
  -- inv_b2: approved, chino PO
  (v_inv_b2, v_vendor_b, v_po_b2, 'PAC-INV-2026-002', '2026-04-10', '2026-06-10',
   18000.00, 0, 18000.00, 'USD', 'approved',      now() - interval '8 days'),
  -- inv_c1: submitted, atlas PO
  (v_inv_c1, v_vendor_c, v_po_c1, 'ATL-INV-2026-001', '2026-04-15', '2026-06-30',
   18750.00, 0, 18750.00, 'USD', 'submitted',     now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO invoice_line_items (invoice_id, po_line_item_id, description, qty_invoiced, unit_price, line_total)
VALUES
  (v_inv_a1, v_line_a1_1, 'Classic Tee Black M', 300, 20.00, 6000.00),
  (v_inv_a1, v_line_a1_2, 'Classic Tee Black L', 200, 20.00, 4000.00),
  (v_inv_a2, v_line_a2_1, 'Hoodie Grey M',        150, 49.95, 7492.50),
  (v_inv_b1, v_line_b1_1, 'Slim Jean W30',        300, 59.99, 17997.00),  -- qty discrepancy
  (v_inv_b1, v_line_b1_2, 'Slim Jean W32',        300, 59.99, 17997.00),  -- qty discrepancy
  (v_inv_b2, v_line_b2_1, 'Chino W30',            300, 60.00, 18000.00),
  (v_inv_c1, v_line_c1_1, 'Fleece Jacket Black M',150,125.00, 18750.00)
ON CONFLICT DO NOTHING;

INSERT INTO receipts (shipment_id, po_line_item_id, qty_received, receipt_date)
VALUES
  (v_ship_a1, v_line_a1_1, 300, '2026-03-10'),
  (v_ship_a1, v_line_a1_2, 200, '2026-03-10'),
  (v_ship_b1, v_line_b1_1, 250, '2026-03-25'),
  (v_ship_b1, v_line_b1_2, 250, '2026-03-25')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. ONBOARDING
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO onboarding_workflows (vendor_id, status, current_step, completed_steps,
                                  started_at, completed_at, approved_by)
VALUES
  (v_vendor_a, 'approved',    6, '["company_info","banking","tax","compliance_docs","portal_tour","agreement"]'::jsonb,
   now() - interval '90 days', now() - interval '85 days', 'internal-admin'),
  (v_vendor_b, 'approved',    6, '["company_info","banking","tax","compliance_docs","portal_tour","agreement"]'::jsonb,
   now() - interval '60 days', now() - interval '55 days', 'internal-admin'),
  (v_vendor_c, 'in_progress', 3, '["company_info","banking","tax"]'::jsonb,
   now() - interval '14 days', null, null)
ON CONFLICT (vendor_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. BANKING DETAILS
-- account_number_encrypted / routing_number_encrypted are AES-256-GCM blobs.
-- Format: iv_hex:tag_hex:ciphertext_hex — use a known placeholder for staging.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO banking_details (vendor_id, account_name, bank_name,
                              account_number_encrypted, account_number_last4,
                              routing_number_encrypted, account_type, currency,
                              verified, verified_at, verified_by)
VALUES
  (v_vendor_a, 'Sunrise Apparel Co.', 'Bank of China',
   '000000000000000000000000:00000000000000000000000000000000:00000000000000000000000000000000', '1234',
   '000000000000000000000000:00000000000000000000000000000000:00000000000000000000000000000000',
   'wire', 'USD', true, now() - interval '80 days', 'internal-admin'),
  (v_vendor_b, 'Pacific Thread Works', 'Vietcombank',
   '111111111111111111111111:11111111111111111111111111111111:11111111111111111111111111111111', '5678',
   '111111111111111111111111:11111111111111111111111111111111:11111111111111111111111111111111',
   'wire', 'USD', true, now() - interval '50 days', 'internal-admin')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. COMPLIANCE DOCUMENTS
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO compliance_document_types (id, name, description, required)
VALUES
  ('00000000-0000-0000-0000-000000000001'::uuid, 'Factory Audit',      'Annual factory audit report',     true),
  ('00000000-0000-0000-0000-000000000002'::uuid, 'OEKO-TEX Certificate','Chemical safety certification',   true),
  ('00000000-0000-0000-0000-000000000003'::uuid, 'Social Compliance',  'BSCI / SA8000 compliance report', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance_documents (vendor_id, document_type_id, status, expiry_date, file_url, notes)
VALUES
  (v_vendor_a, '00000000-0000-0000-0000-000000000001'::uuid, 'approved',
   (CURRENT_DATE + interval '6 months')::date, '/staging/vendor-a-audit.pdf', 'Annual audit 2026'),
  (v_vendor_a, '00000000-0000-0000-0000-000000000002'::uuid, 'approved',
   (CURRENT_DATE + interval '1 year')::date,   '/staging/vendor-a-oeko.pdf',  'OEKO-TEX Standard 100'),
  (v_vendor_b, '00000000-0000-0000-0000-000000000001'::uuid, 'under_review',
   null, '/staging/vendor-b-audit.pdf', 'Submitted for review'),
  (v_vendor_c, '00000000-0000-0000-0000-000000000003'::uuid, 'pending',
   null, null, 'Requested but not yet submitted')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. CONTRACTS
-- No entity_id column — vendor_id + title are the scope.
-- contract_type enum: master_services | nda | sow | amendment
-- status enum: draft | sent | under_review | signed | expired | terminated
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO contracts (id, vendor_id, title, status, contract_type,
                       start_date, end_date, value, currency, internal_owner)
VALUES
  (v_contract_a, v_vendor_a, 'Master Vendor Agreement — Sunrise Apparel 2026', 'signed',
   'master_services', '2026-01-01', '2026-12-31', 500000.00, 'USD', 'internal-admin'),
  (v_contract_b, v_vendor_b, 'Master Vendor Agreement — Pacific Thread 2026',  'signed',
   'master_services', '2026-01-01', '2026-12-31', 350000.00, 'USD', 'internal-admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO contract_versions (contract_id, version_number, file_url, notes,
                                uploaded_by_type, uploaded_by_internal_id)
VALUES
  (v_contract_a, 1, '/staging/contract-a-v1.pdf', 'Initial execution', 'internal', 'internal-admin'),
  (v_contract_b, 1, '/staging/contract-b-v1.pdf', 'Initial execution', 'internal', 'internal-admin')
ON CONFLICT (contract_id, version_number) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. DISPUTES
-- type enum: invoice_discrepancy | payment_delay | damaged_goods | other
-- raised_by_type: vendor | internal
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO disputes (id, vendor_id, invoice_id, type, status, priority,
                      subject, raised_by_type, raised_by_internal_id)
VALUES
  (v_dispute_1, v_vendor_b, v_inv_b1, 'invoice_discrepancy', 'open', 'high',
   'Qty discrepancy on STG-PO-2001 — invoiced 600 vs 500 received',
   'internal', 'internal-admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO dispute_messages (dispute_id, sender_type, sender_internal_id, sender_name, body)
VALUES
  (v_dispute_1, 'internal', 'internal-admin', 'Buyer Ops',
   'GRN #STG-GRN-2001 shows 250 received on each line. Please issue a revised invoice for 250 units each.')
ON CONFLICT DO NOTHING;

-- Note: vendor-sent messages require sender_auth_id (auth.users FK).
-- Vendor replies are added after auth users are created by staging-setup.mjs.

-- ════════════════════════════════════════════════════════════════════════════
-- 12. VENDOR SCORECARDS
-- No entity_id, grade, overall_score columns.
-- Uses: composite_score, on_time_delivery_pct, invoice_accuracy_pct, etc.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO vendor_scorecards (vendor_id, period_start, period_end,
                                on_time_delivery_pct, invoice_accuracy_pct,
                                avg_acknowledgment_hours, po_count, invoice_count,
                                discrepancy_count, composite_score)
VALUES
  (v_vendor_a, '2026-01-01', '2026-03-31', 94.0, 99.0, 4.5,  12,  12, 0, 96.0),
  (v_vendor_b, '2026-01-01', '2026-03-31', 88.0, 82.0, 12.0, 10,  10, 2, 85.0),
  (v_vendor_c, '2026-01-01', '2026-03-31', 78.0, 91.0, 8.0,   6,   5, 0, 83.0)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 13. CURRENCY RATES
-- source enum: openexchangerates | ecb | manual
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO currency_rates (from_currency, to_currency, rate, source)
VALUES
  ('USD', 'EUR', 0.92150000, 'manual'),
  ('USD', 'CNY', 7.24800000, 'manual'),
  ('USD', 'GBP', 0.78900000, 'manual'),
  ('USD', 'VND', 24850.00000000, 'manual'),
  ('USD', 'BDT', 109.50000000,   'manual'),
  ('EUR', 'USD', 1.08510000, 'manual'),
  ('CNY', 'USD', 0.13800000, 'manual')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 14. TAX RULES
-- tax_type enum: vat | gst | sales_tax | withholding
-- applies_to: goods | services | all
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO tax_rules (entity_id, jurisdiction, tax_type, rate_pct, applies_to, effective_from)
VALUES
  (v_entity_id, 'US-CA', 'sales_tax',  7.25, 'goods',    '2026-01-01'),
  (v_entity_id, 'US',    'withholding', 0.00, 'services', '2026-01-01'),
  (v_entity_id, 'VN',    'withholding', 5.00, 'services', '2026-01-01')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 15. DYNAMIC DISCOUNT OFFERS
-- CONSTRAINT: early_payment_date <= original_due_date
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO dynamic_discount_offers (entity_id, vendor_id, invoice_id, status,
                                      original_due_date, early_payment_date,
                                      discount_pct, discount_amount, net_payment_amount, expires_at)
VALUES
  (v_entity_id, v_vendor_a, v_inv_a1, 'offered',
   '2026-05-20', '2026-04-24',
   0.821, 82.10, 9917.90, (now() + interval '2 days')::timestamptz)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 16. SUPPLY CHAIN FINANCE PROGRAM
-- Columns: entity_id, name, funder_name, max_facility_amount, current_utilization, base_rate_pct
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO supply_chain_finance_programs (entity_id, name, funder_name,
                                            max_facility_amount, current_utilization,
                                            base_rate_pct, status)
VALUES
  (v_entity_id, 'Ring of Fire SCF Program', 'Wells Fargo Trade Finance',
   5000000.00, 0.00, 4.500, 'active')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 17. RFQ
-- submission_deadline (not response_deadline)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO rfqs (id, entity_id, title, description, status,
                  submission_deadline, currency, created_by)
VALUES
  (v_rfq_1, v_entity_id,
   'Q3 2026 Fleece Jacket — 2000 units',
   'Requesting quotes for 2000 units of heavyweight fleece jackets, various sizes, for Q3 delivery.',
   'published', (now() + interval '14 days')::timestamptz, 'USD', 'internal-buyer')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rfq_line_items (rfq_id, item_number, description, quantity, unit_of_measure, target_unit_price)
VALUES
  (v_rfq_1, 'FLEECE-Q3-M',  'Heavyweight Fleece Jacket — M',  800, 'ea', 110.00),
  (v_rfq_1, 'FLEECE-Q3-L',  'Heavyweight Fleece Jacket — L',  800, 'ea', 110.00),
  (v_rfq_1, 'FLEECE-Q3-XL', 'Heavyweight Fleece Jacket — XL', 400, 'ea', 115.00)
ON CONFLICT DO NOTHING;

-- rfq_invitations: invited_at (not sent_at)
INSERT INTO rfq_invitations (rfq_id, vendor_id, status, invited_at)
VALUES
  (v_rfq_1, v_vendor_b, 'invited', now() - interval '3 days'),
  (v_rfq_1, v_vendor_c, 'invited', now() - interval '3 days')
ON CONFLICT (rfq_id, vendor_id) DO NOTHING;

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
-- status enum: new | read | actioned | dismissed
-- confidence_pct (not confidence_score), no potential_value column
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO ai_insights (entity_id, vendor_id, type, title, summary, status, confidence_pct)
VALUES
  (v_entity_id, v_vendor_b, 'risk_alert',
   'Invoice accuracy declining — Pacific Thread Works',
   'Pacific Thread Works has submitted invoices with quantity discrepancies totalling $11,994. Pattern suggests systemic over-billing vs. goods received.',
   'new', 88.00),
  (v_entity_id, v_vendor_a, 'cost_saving',
   'Dynamic discounting opportunity — save $82 on SUN-INV-2026-001',
   'Early payment at 0.82% captures $82 while yielding ~10.2% annualized return on the early payment amount.',
   'new', 95.00)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 20. ANOMALY FLAGS
-- type enum: duplicate_invoice | price_variance | unusual_volume | late_pattern | compliance_gap
-- entity_type enum: invoice | shipment | po | vendor
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO anomaly_flags (vendor_id, entity_type, entity_id, type,
                            severity, description, status, detected_at)
VALUES
  (v_vendor_b, 'invoice', v_inv_b1, 'unusual_volume',
   'high',
   'PAC-INV-2026-001 invoices 600 total units across two lines; GRN records only 500 received. Discrepancy: 100 units (~17%).',
   'open', now() - interval '14 days')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 21. ESG SCORES
-- No entity_id. Unique: (vendor_id, period_start, period_end).
-- No carbon_footprint, water_usage, etc. — uses score_breakdown jsonb.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO esg_scores (vendor_id, period_start, period_end,
                         environmental_score, social_score, governance_score, overall_score,
                         score_breakdown)
VALUES
  (v_vendor_a, '2026-01-01', '2026-03-31', 78.00, 85.00, 90.00, 84.00,
   '{"carbon_reduction_target":true,"water_reporting":true,"living_wage":true}'::jsonb),
  (v_vendor_b, '2026-01-01', '2026-03-31', 65.00, 80.00, 75.00, 73.00,
   '{"carbon_reduction_target":false,"water_reporting":false,"living_wage":true}'::jsonb)
ON CONFLICT (vendor_id, period_start, period_end) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 22. DIVERSITY PROFILES
-- No entity_id. business_type is text[] (not separate boolean columns).
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO diversity_profiles (vendor_id, business_type, certifying_body,
                                 certification_number, verified, verified_at, verified_by)
VALUES
  (v_vendor_a, '{women_owned}', 'WBENC', 'WBENC-2026-001234',
   true, now() - interval '80 days', 'internal-admin')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 23. BENCHMARK DATA
-- metric enum: unit_price | lead_time | payment_terms | on_time_pct
-- No entity_id, value, unit, percentile, source columns.
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO benchmark_data (category, metric, percentile_25, percentile_50, percentile_75, percentile_90,
                             sample_size, period_start, period_end)
VALUES
  ('tops',      'unit_price',    15.00, 18.50, 23.00, 28.00, 85, '2026-01-01', '2026-03-31'),
  ('bottoms',   'unit_price',    42.00, 55.00, 68.00, 82.00, 62, '2026-01-01', '2026-03-31'),
  ('outerwear', 'unit_price',    85.00,115.00,145.00,190.00, 48, '2026-01-01', '2026-03-31'),
  ('all',       'on_time_pct',   78.00, 88.00, 93.00, 97.00,195, '2026-01-01', '2026-03-31'),
  ('all',       'lead_time',     18.00, 28.00, 38.00, 55.00,195, '2026-01-01', '2026-03-31')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 24. CATALOG ITEMS
-- Columns: vendor_id, sku (not item_number), name (not description),
--          unit_price, currency, min_order_quantity (not moq), lead_time_days, status, category
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO catalog_items (vendor_id, sku, name, unit_price, currency,
                            min_order_quantity, lead_time_days, status, category)
VALUES
  (v_vendor_a, 'SUN-TEE-001',  'Classic Tee — Black',       18.50, 'USD', 300, 28, 'active', 'tops'),
  (v_vendor_a, 'SUN-HOOD-001', 'Pullover Hoodie — Grey',    44.00, 'USD', 150, 35, 'active', 'tops'),
  (v_vendor_b, 'PAC-JEAN-001', 'Slim Jean — Various',       55.00, 'USD', 200, 21, 'active', 'bottoms'),
  (v_vendor_c, 'ATL-FLC-001',  'Fleece Jacket — Black',    115.00, 'USD', 100, 42, 'active', 'outerwear')
ON CONFLICT (vendor_id, sku) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 25. ERP INTEGRATION CONFIG
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO erp_integrations (vendor_id, erp_type, config, status)
VALUES
  (v_vendor_a, 'edi_x12',
   '{"partner_id":"SUNRISE01","isa_id":"SUNRISE001","functional_groups":["850","855","856","810"]}'::jsonb,
   'active')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 26. NOTIFICATIONS (using recipient_internal_id for internal recipients)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO notifications (recipient_internal_id, event_type, title, body, link, email_status)
VALUES
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
ON CONFLICT DO NOTHING;

END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Inventory Planning fixtures (re-use existing files)
-- ════════════════════════════════════════════════════════════════════════════
\ir seed/inventory_planning_phase1_fixtures.sql
\ir seed/inventory_planning_phase2_fixtures.sql
\ir seed/inventory_planning_phase3_fixtures.sql
