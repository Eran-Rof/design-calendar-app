# Tangerine — Current Schema Snapshot

> **AUTO-GENERATED — DO NOT EDIT BY HAND.** Run `node scripts/regenerate-schema-doc.mjs` to refresh.
>
> Generated from `supabase/migrations/*.sql` (191 migration files). Latest: `20260629B00000_t11_chunk2_audit_rpc.sql`.

**Purpose:** quick-reference for column names, types, defaults, and CHECK constraints across all currently-shipped Tangerine tables. Read this BEFORE writing any SQL bundle that references existing tables — column-name bugs (`is_active` vs `status`, `payment_method` vs `customer_payment_method`) waste paste cycles.

**Scope of the parser:**
- ✅ `CREATE TABLE`, `ALTER TABLE ADD/DROP COLUMN`, single-column `ADD CONSTRAINT CHECK ... IN (...)`.
- ❌ Indexes, triggers, functions/RPCs, RLS policies, views, generated columns, INSERT seeds, COMMENT ON — these don't help avoid column-name bugs and aren't reflected here. For function bodies / RPC signatures, search the migrations directly.

**Stats:** 272 tables · 260 CREATE TABLE · 640 ALTER TABLE

---

## `RENAME`  _(P1 (alter only))_

_(no columns parsed)_

## `additions`  _((pre-P) (alter only))_

_(no columns parsed)_

## `ai_insights`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `vendor_id` uuid → `vendors`
- `type` text NOT NULL CHECK `type IN ( 'cost_saving', 'risk_alert', 'consolidation', 'contract_renewal', 'performance_trend', 'market_benchmark' )`
- `title` text NOT NULL
- `summary` text
- `recommendation` text
- `confidence_pct` numeric(5,2) CHECK `confidence_pct IS NULL OR (confidence_pct >= 0 AND confidence_pct <= 100)`
- `data_snapshot` jsonb NOT NULL DEFAULT '{}'::jsonb
- `status` text NOT NULL DEFAULT 'new' CHECK `status IN ('new', 'read', 'actioned', 'dismissed')`
- `generated_at` timestamptz NOT NULL DEFAULT now()
- `expires_at` timestamptz NOT NULL DEFAULT (now() + interval '30 days')
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `anomaly_flags`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `entity_type` text NOT NULL CHECK `entity_type IN ('invoice', 'shipment', 'po', 'vendor')`
- `entity_id` uuid
- `type` text NOT NULL CHECK `type IN ('duplicate_invoice', 'price_variance', 'unusual_volume', 'late_pattern', 'compliance_gap')`
- `severity` text NOT NULL DEFAULT 'medium' CHECK `severity IN ('low', 'medium', 'high', 'critical')`
- `description` text NOT NULL
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'reviewed', 'dismissed', 'escalated')`
- `detected_at` timestamptz NOT NULL DEFAULT now()
- `reviewed_by` text
- `reviewed_at` timestamptz
- `metadata` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `api_call_log`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `api_name` text NOT NULL DEFAULT 'searates'
- `caller_auth_id` uuid
- `number` text
- `number_type` text
- `force_update` boolean NOT NULL DEFAULT false
- `response_status` integer
- `response_message` text
- `estimated_cost_cents` integer
- `duration_ms` integer
- `called_at` timestamptz NOT NULL DEFAULT now()

## `app_data`  _((pre-P) (alter only))_

_(no columns parsed)_

## `approval_decisions`  _(P2-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `request_id` uuid → `approval_requests` NOT NULL
- `step_id` uuid → `approval_request_steps` NOT NULL
- `decision` text NOT NULL
- `decided_by_user_id` uuid → `auth.users` NOT NULL
- `decided_at` timestamptz NOT NULL DEFAULT now()
- `notes` text

## `approval_request_steps`  _(P2-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `request_id` uuid → `approval_requests` NOT NULL
- `step_order` smallint NOT NULL
- `mode` text NOT NULL
- `role_required` text NOT NULL
- `fulfilled_at` timestamptz
- `fulfilled_by_user_id` uuid → `auth.users`
- `notes` text

## `approval_requests`  _(P2-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `kind` text NOT NULL
- `context_table` text NOT NULL
- `context_id` uuid NOT NULL
- `requested_amount_cents` bigint
- `currency` char(3) NOT NULL DEFAULT 'USD'
- `status` text NOT NULL DEFAULT 'pending'
- `final_decided_at` timestamptz
- `expires_at` timestamptz
- `payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `approval_rules`  _(P2-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `kind` text NOT NULL
- `name` text NOT NULL
- `match` jsonb NOT NULL DEFAULT '{}'::jsonb
- `steps` jsonb NOT NULL
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `ar_invoice_lines`  _(P4-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `ar_invoice_id` uuid → `ar_invoices` NOT NULL
- `line_number` integer NOT NULL
- `description` text
- `revenue_account_id` uuid → `gl_accounts`
- `inventory_item_id` uuid → `ip_item_master`
- `quantity` numeric(18,4)
- `unit_price_cents` bigint
- `line_total_cents` bigint NOT NULL DEFAULT 0
- `tax_amount_cents` bigint NOT NULL DEFAULT 0
- `cogs_cents` bigint
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `source` text NOT NULL DEFAULT 'manual' CHECK `IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`

## `ar_invoices`  _(P4-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers` NOT NULL
- `invoice_number` text NOT NULL
- `invoice_kind` text NOT NULL DEFAULT 'customer_invoice' CHECK `IN ('customer_invoice','customer_credit_memo','customer_invoice_historical')`
- `gl_status` text NOT NULL DEFAULT 'unposted' CHECK `IN ('unposted','draft','pending_approval','sent','posted','posted_historical',
                         'paid','partial_paid','reversed','void')`
- `invoice_date` date NOT NULL
- `due_date` date
- `payment_terms_id` uuid → `payment_terms`
- `revenue_account_id` uuid → `gl_accounts`
- `ar_account_id` uuid → `gl_accounts`
- `cogs_account_id` uuid → `gl_accounts`
- `inventory_asset_account_id` uuid → `gl_accounts`
- `accrual_je_id` uuid → `journal_entries`
- `cash_je_id` uuid → `journal_entries`
- `total_amount_cents` bigint NOT NULL DEFAULT 0
- `paid_amount_cents` bigint NOT NULL DEFAULT 0
- `reverses_invoice_id` uuid → `ar_invoices`
- `reversed_by_invoice_id` uuid → `ar_invoices`
- `shipment_id` uuid
- `notes` text
- `metadata` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `source` text NOT NULL DEFAULT 'manual' CHECK `IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`
- `search_doc` tsvector

## `ar_receipt_applications`  _(P4-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `ar_receipt_id` uuid → `ar_receipts` NOT NULL
- `ar_invoice_id` uuid → `ar_invoices` NOT NULL
- `amount_applied_cents` bigint NOT NULL
- `applied_at` timestamptz NOT NULL DEFAULT now()
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `ar_receipts`  _(P4-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers` NOT NULL
- `receipt_date` date NOT NULL
- `amount_cents` bigint NOT NULL
- `bank_account_id` uuid → `gl_accounts` NOT NULL
- `customer_payment_method` text NOT NULL
- `reference` text
- `notes` text
- `accrual_je_id` uuid → `journal_entries`
- `cash_je_id` uuid → `journal_entries`
- `is_void` boolean NOT NULL DEFAULT false
- `voided_at` timestamptz
- `voided_by_user_id` uuid → `auth.users`
- `void_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `payment_processor` text CHECK `IN ('stripe','square','authnet')`
- `processor_intent_id` text
- `processor_charge_id` text
- `processor_fee_cents` bigint
- `processor_status` text CHECK `IN ('requires_action','succeeded','failed','refunded','partial_refunded','chargeback')`
- `source` text NOT NULL DEFAULT 'manual' CHECK `IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`

## `attachments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_type` text NOT NULL CHECK `entity_type IN ( 'invoice','shipment','po','po_message','dispute', 'contract','compliance_document','rfq_quote','bulk_operation' )`
- `entity_id` uuid NOT NULL
- `vendor_id` uuid → `vendors`
- `file_url` text NOT NULL
- `uploaded_at` timestamptz NOT NULL DEFAULT now()
- `deleted_at` timestamptz

## `audit_logs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_type` text NOT NULL
- `entity_id` text
- `action` text NOT NULL
- `old_values` jsonb
- `new_values` jsonb
- `user_label` text
- `source` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `bank_accounts`  _(P6-1 (alter only))_

_(no columns parsed)_

## `bank_match_audit`  _(P6-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `bank_transaction_id` uuid → `bank_transactions` NOT NULL
- `action` text NOT NULL CHECK `action IN ('match','unmatch','create_je','ignore','manual_override','auto_post')`
- `je_line_id` uuid → `journal_entry_lines`
- `je_id_created` uuid → `journal_entries`
- `notes` text
- `actor_user_id` uuid → `auth.users`
- `performed_at` timestamptz NOT NULL DEFAULT now()

## `bank_recon_runs`  _(P6-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `bank_account_id` uuid → `bank_accounts` NOT NULL
- `period_id` uuid → `gl_periods` NOT NULL
- `bank_statement_balance_cents` bigint
- `notes` text
- `reconciled_at` timestamptz
- `reconciled_by_user_id` uuid → `auth.users`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `bank_transactions`  _(P6-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `bank_account_id` uuid → `bank_accounts` NOT NULL
- `source` text NOT NULL CHECK `source IN ('plaid','csv_upload','manual')`
- `external_txn_id` text
- `amount_cents` bigint NOT NULL
- `merchant_name` text
- `category` text[]
- `status` text NOT NULL DEFAULT 'unmatched' CHECK `status IN ('unmatched','matched','manual_je_created','ignored','reversed')`
- `matched_je_line_id` uuid → `journal_entry_lines`
- `matched_at` timestamptz
- `matched_by_user_id` uuid → `auth.users`
- `match_confidence` smallint
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `search_doc` tsvector

## `banking_details`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `account_name` text NOT NULL
- `bank_name` text NOT NULL
- `account_number_encrypted` text NOT NULL
- `account_number_last4` text
- `routing_number_encrypted` text NOT NULL
- `account_type` text NOT NULL CHECK `account_type IN ('checking', 'savings', 'wire')`
- `currency` text NOT NULL DEFAULT 'USD'
- `verified` boolean NOT NULL DEFAULT false
- `verified_at` timestamptz
- `verified_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `benchmark_data`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `category` text NOT NULL
- `metric` text NOT NULL CHECK `metric IN ('unit_price', 'lead_time', 'payment_terms', 'on_time_pct')`
- `percentile_25` numeric(14,4)
- `percentile_50` numeric(14,4)
- `percentile_75` numeric(14,4)
- `percentile_90` numeric(14,4)
- `sample_size` integer NOT NULL CHECK `sample_size >= 0`
- `period_start` date NOT NULL
- `period_end` date NOT NULL CHECK `period_end >= period_start`
- `generated_at` timestamptz NOT NULL DEFAULT now()

## `bf_backfill_checkpoint_log`  _(P4-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `backfill_run_id` uuid NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `year` smallint NOT NULL
- `month` smallint NOT NULL CHECK `month BETWEEN 1 AND 12`
- `invoices_created` integer NOT NULL DEFAULT 0
- `receipts_created` integer NOT NULL DEFAULT 0
- `je_created` integer NOT NULL DEFAULT 0
- `status` text NOT NULL CHECK `status IN ('done','failed','in_progress','skipped','dry_run')`
- `error` text
- `started_at` timestamptz NOT NULL DEFAULT now()
- `finished_at` timestamptz

## `bf_skipped_cogs_log`  _(P4-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `backfill_run_id` uuid NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `invoice_number` text
- `source_line_key` text
- `sku_id` uuid
- `reason` text NOT NULL
- `logged_at` timestamptz NOT NULL DEFAULT now()

## `bf_unmatched_customers_log`  _(P4-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `backfill_run_id` uuid NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `source_customer_id` uuid
- `source_customer_code` text
- `source_customer_name` text
- `invoice_number` text
- `resolution` text NOT NULL CHECK `resolution IN ('synthesized','skipped','manual_review')`
- `resolved_customer_id` uuid → `customers`
- `notes` text
- `logged_at` timestamptz NOT NULL DEFAULT now()

## `broker_invoices`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `customs_entry_id` uuid → `customs_entries`
- `vendor_id` uuid → `vendors` NOT NULL
- `broker_invoice_number` text NOT NULL
- `invoice_date` date NOT NULL
- `freight_cents` bigint NOT NULL DEFAULT 0
- `brokerage_fee_cents` bigint NOT NULL DEFAULT 0
- `duty_advance_cents` bigint NOT NULL DEFAULT 0
- `other_cents` bigint NOT NULL DEFAULT 0
- `total_cents` bigint NOT NULL
- `ap_invoice_id` uuid → `invoices`
- `allocation_method` text NOT NULL DEFAULT 'value' CHECK `allocation_method IN ('value','weight','cbm','manual')`
- `allocation_je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `bulk_operations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `type` text NOT NULL CHECK `type IN ('po_acknowledge', 'invoice_submit', 'catalog_update')`
- `status` text NOT NULL DEFAULT 'queued' CHECK `status IN ('queued', 'processing', 'complete', 'failed')`
- `input_file_url` text
- `result_file_url` text
- `total_rows` integer NOT NULL DEFAULT 0
- `success_count` integer NOT NULL DEFAULT 0
- `failure_count` integer NOT NULL DEFAULT 0
- `error_summary` jsonb
- `created_by` uuid → `vendor_users`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `started_at` timestamptz
- `completed_at` timestamptz

## `carton_contents`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `carton_id` uuid → `cartons` NOT NULL
- `pack_gtin` text NOT NULL
- `child_upc` text
- `qty_per_pack` integer NOT NULL CHECK `qty_per_pack > 0`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `style_no` text
- `color` text
- `scale_code` text
- `pack_qty` integer
- `exploded_unit_qty` integer

## `cartons`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sscc` text NOT NULL
- `serial_reference` bigint NOT NULL
- `batch_id` uuid → `label_batches`
- `batch_line_id` uuid → `label_batch_lines`
- `pack_gtin` text → `pack_gtin_master`
- `style_no` text
- `color` text
- `scale_code` text
- `carton_seq` integer NOT NULL DEFAULT 1
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `upload_id` uuid → `packing_list_uploads`
- `po_number` text
- `carton_no` text
- `total_packs` integer
- `total_units` integer
- `channel` text

## `case_comments`  _(P7-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `case_id` uuid → `cases` NOT NULL
- `author_user_id` uuid → `auth.users`
- `body` text NOT NULL CHECK `char_length(trim(body)) > 0`
- `is_internal` boolean NOT NULL DEFAULT true
- `external_email` text

## `cases`  _(P7-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `case_number` text NOT NULL
- `ar_invoice_id` uuid → `ar_invoices`
- `rma_id` uuid
- `severity` text NOT NULL DEFAULT 'normal' CHECK `severity IN ('low','normal','high','urgent')`
- `subject` text NOT NULL
- `body` text
- `assignee_user_id` uuid → `auth.users`
- `external_email` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `search_doc` tsvector

## `catalog_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `sku` text NOT NULL
- `name` text NOT NULL
- `description` text
- `unit_price` numeric
- `currency` text NOT NULL DEFAULT 'USD'
- `unit_of_measure` text
- `lead_time_days` integer
- `min_order_quantity` integer
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'inactive', 'discontinued')`
- `category` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `catalog_price_history`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `catalog_item_id` uuid → `catalog_items` NOT NULL
- `old_price` numeric
- `new_price` numeric NOT NULL
- `effective_date` date NOT NULL
- `changed_by` uuid → `vendor_users`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `collaboration_workspaces`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `name` text NOT NULL
- `description` text
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'archived')`
- `created_by` text
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `collections`  _((pre-P))_

- `id` text PK
- `data` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `commission_accruals`  _(P7-4)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `ar_invoice_id` uuid → `ar_invoices` NOT NULL
- `sales_rep_id` uuid → `sales_reps` NOT NULL
- `commissionable_cents` bigint NOT NULL CHECK `commissionable_cents >= 0`
- `rate_pct` numeric(5,2) NOT NULL CHECK `rate_pct >= 0 AND rate_pct <= 100`
- `commission_cents` bigint NOT NULL CHECK `commission_cents >= 0`
- `status` text NOT NULL DEFAULT 'accrued' CHECK `status IN ('accrued','reversed','paid')`
- `accrual_je_id` uuid → `journal_entries`
- `payout_je_id` uuid → `journal_entries`
- `reversal_je_id` uuid → `journal_entries`
- `paid_at` timestamptz
- `reversed_at` timestamptz
- `reversal_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `commission_payouts`  _(P7-4)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `sales_rep_id` uuid → `sales_reps` NOT NULL
- `period_id` uuid → `gl_periods` NOT NULL
- `total_cents` bigint NOT NULL CHECK `total_cents >= 0`
- `payment_method` text NOT NULL CHECK `payment_method IN ('check','wire','ach','cash','other')`
- `paid_at` date NOT NULL
- `payout_je_id` uuid → `journal_entries`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `company_settings`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `company_name` text NOT NULL
- `gs1_prefix` text NOT NULL
- `prefix_length` integer NOT NULL CHECK `prefix_length BETWEEN 6 AND 11`
- `gtin_indicator_digit` text NOT NULL DEFAULT '1' CHECK `gtin_indicator_digit ~ '^\d$'`
- `starting_item_reference` bigint NOT NULL DEFAULT 1
- `next_item_reference_counter` bigint NOT NULL DEFAULT 1
- `default_label_format` text
- `xoro_api_base_url` text
- `xoro_api_key_ref` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `sscc_extension_digit` text NOT NULL DEFAULT '0' CHECK `sscc_extension_digit ~ '^\d$'`
- `sscc_starting_serial_reference` bigint NOT NULL DEFAULT 1
- `sscc_next_serial_reference_counter` bigint NOT NULL DEFAULT 1
- `xoro_item_endpoint` text
- `xoro_enabled` boolean NOT NULL DEFAULT false

## `compliance_audit_trail`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `document_id` uuid → `compliance_documents`
- `action` text NOT NULL CHECK `action IN ('uploaded', 'reviewed', 'approved', 'rejected', 'expired', 'renewed', 'requested')`
- `performed_by_type` text NOT NULL CHECK `performed_by_type IN ('vendor', 'internal', 'system')`
- `performed_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `compliance_automation_rules`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `document_type_id` uuid → `compliance_document_types` NOT NULL
- `trigger_type` text NOT NULL CHECK `trigger_type IN ('expiry_approaching', 'status_change', 'periodic_review')`
- `days_before_expiry` integer CHECK `days_before_expiry IS NULL OR days_before_expiry >= 0`
- `auto_request` boolean NOT NULL DEFAULT false
- `escalation_after_days` integer CHECK `escalation_after_days IS NULL OR escalation_after_days > 0`
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `compliance_document_types`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `code` text NOT NULL
- `name` text NOT NULL
- `description` text
- `required` boolean NOT NULL DEFAULT true
- `active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()

## `compliance_documents`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `document_type_id` uuid → `compliance_document_types` NOT NULL
- `file_url` text NOT NULL
- `file_name` text
- `file_size_bytes` bigint
- `file_mime_type` text
- `issued_at` date
- `expiry_date` date
- `status` text NOT NULL DEFAULT 'pending_review' CHECK `status IN ('pending_review', 'approved', 'rejected', 'expired', 'superseded')`
- `rejection_reason` text
- `reviewed_by` text
- `reviewed_at` timestamptz
- `uploaded_by` uuid → `vendor_users`
- `uploaded_at` timestamptz NOT NULL DEFAULT now()
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `contract_versions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `contract_id` uuid → `contracts` NOT NULL
- `version_number` integer NOT NULL
- `file_url` text NOT NULL
- `notes` text
- `uploaded_by_type` text NOT NULL CHECK `uploaded_by_type IN ('vendor', 'internal')`
- `uploaded_by_vendor_user_id` uuid → `vendor_users`
- `uploaded_by_internal_id` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `contracts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `title` text NOT NULL
- `description` text
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'sent', 'under_review', 'signed', 'expired', 'terminated')`
- `contract_type` text NOT NULL CHECK `contract_type IN ('master_services', 'nda', 'sow', 'amendment')`
- `start_date` date
- `end_date` date
- `value` numeric
- `currency` text NOT NULL DEFAULT 'USD'
- `file_url` text
- `signed_file_url` text
- `signed_at` timestamptz
- `signed_by_vendor` uuid → `vendor_users`
- `internal_owner` text
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid → `entities`

## `crm_activities`  _(P8-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers`
- `opportunity_id` uuid → `crm_opportunities`
- `case_id` uuid → `cases`
- `subject` text NOT NULL
- `body` text
- `occurred_at` timestamptz NOT NULL DEFAULT now()
- `duration_minutes` int CHECK `duration_minutes IS NULL OR duration_minutes >= 0`
- `external_email` text
- `created_by_user_id` uuid → `auth.users`

## `crm_opportunities`  _(P8-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers`
- `opportunity_number` text NOT NULL
- `stage` text NOT NULL DEFAULT 'new' CHECK `stage IN ('new','qualified','proposal','won','lost')`
- `stage_changed_at` timestamptz NOT NULL DEFAULT now()
- `expected_cents` bigint CHECK `expected_cents IS NULL OR expected_cents >= 0`
- `probability_pct` smallint NOT NULL DEFAULT 50 CHECK `probability_pct BETWEEN 0 AND 100`
- `expected_close_date` date
- `actual_close_date` date
- `loss_reason` text
- `owner_user_id` uuid → `auth.users`
- `description` text
- `metadata` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `crm_tasks`  _(P8-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers`
- `opportunity_id` uuid → `crm_opportunities`
- `title` text NOT NULL
- `description` text
- `due_date` date
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open','in_progress','done','cancelled')`
- `priority` text NOT NULL DEFAULT 'normal' CHECK `priority IN ('low','normal','high','urgent')`
- `assignee_user_id` uuid → `auth.users`
- `completed_at` timestamptz
- `completed_by_user_id` uuid → `auth.users`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `currency_rates`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `from_currency` text NOT NULL CHECK `char_length(from_currency) = 3`
- `to_currency` text NOT NULL CHECK `char_length(to_currency) = 3`
- `rate` numeric(18,8) NOT NULL CHECK `rate > 0`
- `source` text NOT NULL CHECK `source IN ('openexchangerates', 'ecb', 'manual')`
- `snapshotted_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()

## `customer_sales_rep_assignments`  _(P7-4)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `customer_id` uuid → `customers` NOT NULL
- `sales_rep_id` uuid → `sales_reps` NOT NULL
- `share_pct` numeric(5,2) NOT NULL DEFAULT 100 CHECK `share_pct > 0 AND share_pct <= 100`
- `effective_from` date NOT NULL DEFAULT current_date
- `effective_to` date
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `customers`  _(P1 (alter only))_

- `code` text
- `customer_type` text CHECK `IN ('wholesale', 'ecom', 'showroom', 'employee', 'other')`
- `default_gl_ar_account_id` uuid → `gl_accounts` — **RETIRED** (no longer written/shown; superseded by `default_ar_account_id`, the column the AR/SO posting engines read). Column kept for back-compat.
- `default_gl_revenue_account_id` uuid → `gl_accounts` — **RETIRED** (superseded by `default_revenue_account_id`). Column kept for back-compat.
- `payment_terms` text
- `default_currency` char(3) NOT NULL DEFAULT 'USD'
- `tax_exempt` boolean NOT NULL DEFAULT false
- `tax_exempt_certificate` text
- `credit_limit` numeric(14, 2)
- `status` text CHECK `IN ('active', 'inactive', 'on_hold')`
- `billing_address` jsonb NOT NULL DEFAULT '{}'::jsonb
- `shipping_address` jsonb NOT NULL DEFAULT '{}'::jsonb
- `attributes` jsonb NOT NULL DEFAULT '{}'::jsonb
- `deleted_at` timestamptz
- `created_by_user_id` uuid → `auth.users`
- `updated_by_user_id` uuid → `auth.users`
- `entity_id` uuid
- `payment_terms_id` uuid → `payment_terms`
- `credit_limit_cents` bigint NOT NULL DEFAULT 0
- `credit_limit_currency` char(3) NOT NULL DEFAULT 'USD'
- `default_ar_account_id` uuid → `gl_accounts`
- `default_revenue_account_id` uuid → `gl_accounts`
- `payment_processor` text CHECK `IN ('stripe','square','authnet')`
- `processor_customer_id` text
- `processor_payment_method_id` text
- `processor_card_brand` text
- `processor_card_last4` text
- `search_doc` tsvector
- `marketplace_buyer_refs` jsonb NOT NULL DEFAULT '{}'::jsonb

## `customs_entries`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `entry_number` text NOT NULL
- `entry_date` date NOT NULL
- `port_of_entry` text
- `importer_of_record` text
- `broker_name` text
- `broker_id` text
- `total_entered_value_cents` bigint NOT NULL
- `total_duty_cents` bigint NOT NULL DEFAULT 0
- `total_mpf_cents` bigint NOT NULL DEFAULT 0
- `total_hmf_cents` bigint NOT NULL DEFAULT 0
- `total_section_301_cents` bigint NOT NULL DEFAULT 0
- `total_other_fees_cents` bigint NOT NULL DEFAULT 0
- `form_7501_document_id` uuid
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `revaluation_je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `customs_entry_lines`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `customs_entry_id` uuid → `customs_entries` NOT NULL
- `receipt_line_item_id` uuid → `receipt_line_items`
- `hts_code` text NOT NULL
- `country_of_origin` char(2) NOT NULL
- `trade_program` text
- `entered_value_cents` bigint NOT NULL
- `duty_rate_pct` numeric(7,4)
- `duty_cents` bigint NOT NULL DEFAULT 0
- `section_301_rate_pct` numeric(7,4)
- `section_301_cents` bigint NOT NULL DEFAULT 0
- `mpf_cents` bigint NOT NULL DEFAULT 0
- `hmf_cents` bigint NOT NULL DEFAULT 0

## `data_quality_issues`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `issue_type` text NOT NULL
- `severity` text NOT NULL CHECK `severity IN ('info', 'warning', 'error')`
- `entity_type` text
- `entity_id` text
- `message` text NOT NULL
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'resolved')`
- `context` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `resolved_at` timestamptz
- `resolution_note` text

## `dispute_messages`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `dispute_id` uuid → `disputes` NOT NULL
- `sender_type` text NOT NULL CHECK `sender_type IN ('vendor', 'internal')`
- `sender_auth_id` uuid
- `sender_internal_id` text
- `sender_name` text NOT NULL
- `body` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `disputes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `invoice_id` uuid → `invoices`
- `po_id` uuid → `tanda_pos`
- `type` text NOT NULL CHECK `type IN ('invoice_discrepancy', 'payment_delay', 'damaged_goods', 'other')`
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'under_review', 'resolved', 'closed')`
- `priority` text NOT NULL DEFAULT 'medium' CHECK `priority IN ('low', 'medium', 'high')`
- `subject` text NOT NULL
- `resolution` text
- `resolved_at` timestamptz
- `resolved_by` text
- `raised_by_type` text NOT NULL DEFAULT 'vendor' CHECK `raised_by_type IN ('vendor', 'internal')`
- `raised_by_vendor_user_id` uuid → `vendor_users`
- `raised_by_internal_id` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `last_viewed_by_vendor_at` timestamptz
- `last_viewed_by_internal_at` timestamptz

## `diversity_profiles`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `business_type` text[] NOT NULL DEFAULT '{}'
- `hub_zone` certifying_body text
- `certification_expiry` date
- `certificate_file_url` text
- `verified_at` timestamptz
- `verified_by` text
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `document_versions`  _(P2-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `document_id` uuid → `documents` NOT NULL
- `version_number` int NOT NULL
- `storage_path` text NOT NULL
- `mime_type` text NOT NULL
- `byte_size` bigint NOT NULL
- `sha256_hex` text NOT NULL
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `documents`  _(P2-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `context_table` text NOT NULL
- `context_id` uuid NOT NULL
- `kind` text NOT NULL
- `title` text NOT NULL
- `current_version_id` uuid
- `is_archived` boolean NOT NULL DEFAULT false
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `dynamic_discount_offers`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `invoice_id` uuid → `invoices` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `original_due_date` date NOT NULL
- `early_payment_date` date NOT NULL
- `discount_pct` numeric(6,3) NOT NULL CHECK `discount_pct >= 0 AND discount_pct <= 100`
- `discount_amount` numeric(14,2) NOT NULL
- `net_payment_amount` numeric(14,2) NOT NULL
- `status` text NOT NULL DEFAULT 'offered' CHECK `status IN ('offered', 'accepted', 'rejected', 'expired', 'paid')`
- `offered_at` timestamptz NOT NULL DEFAULT now()
- `expires_at` timestamptz NOT NULL
- `accepted_at` timestamptz
- `rejected_at` timestamptz
- `paid_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `early_payment_analytics`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `total_offers_made` integer NOT NULL DEFAULT 0 CHECK `total_offers_made >= 0`
- `total_offers_accepted` integer NOT NULL DEFAULT 0 CHECK `total_offers_accepted >= 0`
- `total_discount_captured` numeric(14,2) NOT NULL DEFAULT 0 CHECK `total_discount_captured >= 0`
- `total_early_payment_amount` numeric(14,2) NOT NULL DEFAULT 0 CHECK `total_early_payment_amount >= 0`
- `avg_discount_pct` numeric(6,3)
- `annualized_return_pct` numeric(8,3)
- `generated_at` timestamptz NOT NULL DEFAULT now()

## `edi_messages`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `direction` text NOT NULL CHECK `direction IN ('inbound', 'outbound')`
- `transaction_set` text NOT NULL CHECK `transaction_set IN ('850', '855', '856', '810', '820', '997')`
- `interchange_id` text
- `status` text NOT NULL DEFAULT 'received' CHECK `status IN ('received', 'processed', 'acknowledged', 'error')`
- `raw_content` text
- `parsed_content` jsonb
- `error_message` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `employees`  _(P2-7)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `auth_user_id` uuid → `auth.users`
- `code` text NOT NULL
- `first_name` text NOT NULL
- `last_name` text NOT NULL
- `display_name` text
- `email` text NOT NULL
- `title` text
- `department` text
- `manager_employee_id` uuid → `employees`
- `hire_date` date
- `termination_date` date
- `is_active` boolean NOT NULL DEFAULT true
- `phone` text
- `metadata` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `entities`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `parent_entity_id` uuid → `entities`
- `name` text NOT NULL
- `slug` text NOT NULL
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'inactive')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `code` text
- `functional_currency` char(3)
- `fiscal_year_start_month` smallint
- `accounting_basis_primary` text CHECK `IN ('ACCRUAL', 'CASH')`
- `posting_locked_through` date
- `country` char(2)
- `metadata` jsonb NOT NULL DEFAULT '{}'::jsonb
- `default_ap_account_id` uuid → `gl_accounts`
- `default_bank_account_id` uuid → `gl_accounts`
- `default_ar_account_id` uuid → `gl_accounts`
- `default_revenue_account_id` uuid → `gl_accounts`
- `default_cogs_account_id` uuid → `gl_accounts`
- `default_inventory_account_id` uuid → `gl_accounts`
- `default_retained_earnings_account_id` uuid → `gl_accounts`
- `default_payment_processor` text CHECK `IN ('stripe','square','authnet')`
- `multi_entity_enabled` boolean NOT NULL DEFAULT false
- `parallel_run_status` jsonb NOT NULL DEFAULT '{}'::jsonb

## `entity_access_audit`  _(P10-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `auth_user_id` uuid → `auth.users`
- `attempted_entity_id` uuid → `entities`
- `attempted_table` text NOT NULL
- `attempted_action` text NOT NULL CHECK `attempted_action IN ('select','insert','update','delete')`
- `attempted_pk` text
- `denied_at` timestamptz NOT NULL DEFAULT now()
- `request_id` text
- `user_agent` text

## `entity_branding`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `logo_url` text
- `primary_color` text
- `secondary_color` text
- `favicon_url` text
- `company_display_name` text
- `portal_welcome_message` text
- `email_from_name` text
- `email_from_address` text
- `custom_domain` text
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `entity_users`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `auth_id` uuid → `auth.users` NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `role` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `is_default` boolean NOT NULL DEFAULT false

## `entity_vendors`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `relationship_status` text NOT NULL DEFAULT 'active' CHECK `relationship_status IN ('active', 'suspended', 'terminated')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `vendor_code` text

## `erp_integrations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `type` text NOT NULL CHECK `type IN ('sap', 'oracle', 'netsuite', 'quickbooks', 'sage', 'custom')`
- `status` text NOT NULL DEFAULT 'paused' CHECK `status IN ('active', 'paused', 'error')`
- `config` jsonb NOT NULL DEFAULT '{}'::jsonb
- `last_sync_at` timestamptz
- `last_sync_status` text CHECK `last_sync_status IN ('success', 'error')`
- `last_sync_error` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `erp_sync_logs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `integration_id` uuid → `erp_integrations` NOT NULL
- `direction` text NOT NULL CHECK `direction IN ('inbound', 'outbound')`
- `entity_type` text NOT NULL CHECK `entity_type IN ('po', 'invoice', 'payment', 'shipment')`
- `entity_id` uuid
- `status` text NOT NULL CHECK `status IN ('success', 'error', 'skipped')`
- `payload_hash` text
- `error_message` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `esg_scores`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL CHECK `period_end >= period_start`
- `environmental_score` numeric(5,2) CHECK `environmental_score IS NULL OR (environmental_score >= 0 AND environmental_score <= 100)`
- `social_score` numeric(5,2) CHECK `social_score IS NULL OR (social_score >= 0 AND social_score <= 100)`
- `governance_score` numeric(5,2) CHECK `governance_score IS NULL OR (governance_score >= 0 AND governance_score <= 100)`
- `overall_score` numeric(5,2) CHECK `overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)`
- `score_breakdown` jsonb NOT NULL DEFAULT '{}'::jsonb
- `generated_at` timestamptz NOT NULL DEFAULT now()

## `fabric_codes`  _(P3-11)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `code` text NOT NULL
- `name` text NOT NULL
- `composition_text` text NOT NULL
- `composition_json` jsonb
- `fabric_weight_gsm` numeric(8,2)
- `country_of_origin_iso2` char(2)
- `hts_code` text
- `care_instructions` text
- `default_vendor_id` uuid → `vendors`
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `faire_buyers`  _(P10-3 (alter only))_

_(no columns parsed)_

## `faire_order_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `faire_order_id` uuid → `faire_orders` NOT NULL
- `line_number` int NOT NULL
- `faire_item_token` text NOT NULL
- `sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `product_name` text NOT NULL
- `quantity` int NOT NULL
- `unit_price_wholesale_cents` bigint NOT NULL
- `line_total_cents` bigint NOT NULL
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb

## `faire_orders`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `faire_shop_id` uuid → `faire_shops` NOT NULL
- `faire_order_id` text NOT NULL
- `faire_brand_token` text
- `faire_buyer_id` uuid → `faire_buyers`
- `placed_at` timestamptz NOT NULL
- `ship_by_at` timestamptz
- `order_status` text NOT NULL
- `subtotal_cents` bigint NOT NULL
- `shipping_cents` bigint NOT NULL DEFAULT 0
- `commission_cents` bigint NOT NULL
- `commission_rate` numeric(5,4) NOT NULL
- `is_first_order_for_buyer` boolean NOT NULL DEFAULT false
- `customer_id` uuid → `customers`
- `ar_invoice_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `source` text NOT NULL DEFAULT 'faire' CHECK `source = 'faire'`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `faire_payouts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `faire_shop_id` uuid → `faire_shops` NOT NULL
- `faire_payout_id` text NOT NULL
- `payout_date` date NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `gross_amount_cents` bigint NOT NULL
- `commission_amount_cents` bigint NOT NULL
- `refunds_amount_cents` bigint NOT NULL DEFAULT 0
- `net_amount_cents` bigint NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `bank_transaction_id` uuid → `bank_transactions`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `faire_returns`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `faire_shop_id` uuid → `faire_shops` NOT NULL
- `faire_order_id` uuid → `faire_orders`
- `faire_return_id` text NOT NULL
- `return_status` text NOT NULL
- `refund_amount_cents` bigint NOT NULL DEFAULT 0
- `reason` text
- `ar_credit_memo_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL
- `source` text NOT NULL DEFAULT 'faire' CHECK `source = 'faire'`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `faire_shops`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `faire_shop_token` text NOT NULL
- `customer_id` uuid → `customers`
- `all` subsequent use 15%. -- Faire's API exposes an is_first_order flag PK → `entities` NOT NULL DEFAULT gen_random_uuid(), entity_id uuid
- `buyer_email` text
- `first_order_at` timestamptz
- `is_first_order_completed` boolean NOT NULL DEFAULT false
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `fba_inventory_snapshots`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `fba_seller_account_id` uuid → `fba_seller_accounts` NOT NULL
- `snapshot_at` timestamptz NOT NULL
- `asin` text
- `sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `fulfillable_qty` int NOT NULL DEFAULT 0
- `inbound_working_qty` int NOT NULL DEFAULT 0
- `inbound_shipped_qty` int NOT NULL DEFAULT 0
- `inbound_receiving_qty` int NOT NULL DEFAULT 0
- `reserved_qty` int NOT NULL DEFAULT 0
- `unfulfillable_qty` int NOT NULL DEFAULT 0
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb

## `fba_order_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `fba_order_id` uuid → `fba_orders` NOT NULL
- `order_item_id` text NOT NULL
- `sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `title` text
- `quantity_ordered` int NOT NULL
- `quantity_shipped` int NOT NULL DEFAULT 0
- `item_price_cents` bigint NOT NULL
- `item_tax_cents` bigint NOT NULL DEFAULT 0
- `promotion_discount_cents` bigint NOT NULL DEFAULT 0
- `fulfillment_fee_cents` bigint NOT NULL DEFAULT 0
- `referral_fee_cents` bigint NOT NULL DEFAULT 0
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb

## `fba_orders`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `fba_seller_account_id` uuid → `fba_seller_accounts` NOT NULL
- `amazon_order_id` text NOT NULL
- `last_update_date` timestamptz NOT NULL
- `order_status` text NOT NULL
- `marketplace_id` text NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `order_total_cents` bigint NOT NULL
- `item_subtotal_cents` bigint NOT NULL DEFAULT 0
- `tax_collected_cents` bigint NOT NULL DEFAULT 0
- `shipping_cents` bigint NOT NULL DEFAULT 0
- `promotion_discount_cents` bigint NOT NULL DEFAULT 0
- `customer_id` uuid → `customers`
- `ar_invoice_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `source` text NOT NULL DEFAULT 'fba' CHECK `source IN ('fba')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `fba_returns`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `fba_order_id` uuid → `fba_orders`
- `amazon_order_id` text
- `return_request_id` text NOT NULL
- `asin` text
- `sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `quantity` int NOT NULL
- `reason` text
- `return_status` text
- `refund_amount_cents` bigint NOT NULL DEFAULT 0
- `ar_credit_memo_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `fba_seller_accounts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `seller_id` text NOT NULL
- `lwa_client_id_ciphertext` bytea
- `key` = FBA_TOKEN_ENC_KEY lwa_client_id_iv bytea
- `lwa_client_id_tag` bytea
- `lwa_client_secret_ciphertext` bytea
- `lwa_client_secret_iv` bytea
- `lwa_client_secret_tag` bytea
- `refresh_token_ciphertext` bytea
- `refresh_token_iv` bytea
- `refresh_token_tag` bytea
- `aws_role_arn` text
- `is_active` boolean NOT NULL DEFAULT true
- `last_orders_sync_at` timestamptz
- `last_settlement_sync_at` timestamptz
- `last_inventory_sync_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `fba_settlements`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `fba_seller_account_id` uuid → `fba_seller_accounts` NOT NULL
- `financial_event_group_id` text NOT NULL
- `posted_before` timestamptz NOT NULL
- `gross_amount_cents` bigint NOT NULL
- `fees_amount_cents` bigint NOT NULL
- `refunds_amount_cents` bigint NOT NULL DEFAULT 0
- `net_amount_cents` bigint NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `processing_status` text NOT NULL DEFAULT 'Open' CHECK `processing_status IN ('Open','Closed')`
- `bank_transaction_id` uuid → `bank_transactions`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `finance_requests`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `program_id` uuid → `supply_chain_finance_programs` NOT NULL
- `invoice_id` uuid → `invoices` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `requested_amount` numeric(14,2) NOT NULL CHECK `requested_amount > 0`
- `approved_amount` numeric(14,2)
- `fee_pct` numeric(6,3)
- `fee_amount` numeric(14,2)
- `net_disbursement` numeric(14,2)
- `status` text NOT NULL DEFAULT 'requested' CHECK `status IN ('requested', 'approved', 'funded', 'repaid', 'rejected')`
- `rejection_reason` text
- `requested_at` timestamptz NOT NULL DEFAULT now()
- `approved_at` timestamptz
- `funded_at` timestamptz
- `repayment_due_date` date
- `repaid_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `gl_accounts`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `code` text NOT NULL
- `name` text NOT NULL
- `account_type` text NOT NULL
- `account_subtype` text
- `parent_account_id` uuid → `gl_accounts`
- `normal_balance` text NOT NULL
- `is_postable` boolean NOT NULL DEFAULT true
- `is_control` boolean NOT NULL DEFAULT false
- `status` text NOT NULL DEFAULT 'active'
- `description` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `updated_by_user_id` uuid → `auth.users`
- `search_doc` tsvector

## `gl_period_status_log`  _(P5-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `period_id` uuid → `gl_periods` NOT NULL
- `from_status` text
- `to_status` text NOT NULL
- `reason` text
- `actor_user_id` uuid → `auth.users`
- `performed_at` timestamptz NOT NULL DEFAULT now()

## `gl_periods`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `fiscal_year` smallint NOT NULL
- `period_number` smallint NOT NULL
- `starts_on` date NOT NULL
- `ends_on` date NOT NULL
- `status` text NOT NULL DEFAULT 'open' CHECK `IN ('open', 'soft_close', 'closed', 'closed_with_closing_jes')`
- `soft_closed_at` timestamptz
- `closed_at` timestamptz
- `closed_by_user_id` uuid → `auth.users`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `gs1_catalog_items`  _((GS1 module — Styles Catalog))_

GS1 publishable styles catalog (workflow step 1). Single-tenant, anon-RLS, **no `entity_id`** — matches the rest of the GS1 module. One row per style+color; style/color/price are read from the entity-scoped PLM tables server-side at import time, only the curated catalog row (editable price + publish state) lives here. No cross-module FKs (`style_id`/`color_id`/`price_list_id` are loose uuids).

- `id` uuid PK DEFAULT gen_random_uuid()
- `style_id` uuid — `style_master.id` (loose link, no FK)
- `style_no` text NOT NULL — `style_master.style_code`
- `style_name` text
- `color` text NOT NULL
- `color_id` uuid — `color_master.id` when resolved (loose link)
- `brand` text
- `category` text
- `description` text
- `pack_gtin` text — `pack_gtin_master.pack_gtin` for (style_no,color)
- `price_cents` bigint CHECK `price_cents IS NULL OR price_cents >= 0`
- `currency` char(3) NOT NULL DEFAULT 'USD'
- `price_list_id` uuid — `price_lists.id` the price came from (loose link)
- `price_list_code` text
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'ready', 'published')`
- `gdsn_target` text
- `published_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now() _(touch trigger)_
- UNIQUE `(style_no, color)`

## `import_documentation`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `tanda_po_id` uuid → `tanda_pos` NOT NULL
- `document_type` text NOT NULL
- `document_url` text
- `hs_code` text
- `country_of_origin` text
- `declared_value_cents` bigint
- `duty_rate_pct` numeric(8,4)
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending','received','verified','filed')`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `international_payments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `payment_id` uuid → `payments` NOT NULL
- `from_currency` text NOT NULL CHECK `char_length(from_currency) = 3`
- `to_currency` text NOT NULL CHECK `char_length(to_currency) = 3`
- `from_amount` numeric(14,2) NOT NULL CHECK `from_amount > 0`
- `to_amount` numeric(14,2) NOT NULL CHECK `to_amount > 0`
- `fx_rate` numeric(18,8) NOT NULL CHECK `fx_rate > 0`
- `fx_fee_amount` numeric(14,2) NOT NULL DEFAULT 0 CHECK `fx_fee_amount >= 0`
- `fx_provider` text CHECK `fx_provider IS NULL OR fx_provider IN ('wise', 'currencycloud', 'manual')`
- `fx_reference` text
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending', 'converted', 'sent', 'failed')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `inventory_adjustments`  _(P3-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `item_id` uuid → `ip_item_master` NOT NULL
- `adjustment_type` text NOT NULL
- `qty_delta` numeric(18,4) NOT NULL
- `unit_cost_cents` bigint
- `NULL` when qty_delta < 0 reason text NOT NULL
- `gl_account_id` uuid → `gl_accounts` NOT NULL
- `posted_je_id` uuid → `journal_entries`
- `posted_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `OR` qty_delta < 0 with NULL unit_cost_cents (FIFO-drawn). The -- zero-delta case is rejected so we never have a no-op posting. NOT NULL CHECK `(qty_delta > 0 AND unit_cost_cents IS NOT NULL AND unit_cost_cents >= 0) OR (qty_delta < 0 AND unit_cost_cents IS NULL)`

## `inventory_consumption`  _(P3-3)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `layer_id` uuid → `inventory_layers` NOT NULL
- `consumed_at` timestamptz NOT NULL DEFAULT now()
- `qty_consumed` numeric(18,4) NOT NULL
- `cogs_cents` bigint NOT NULL
- `consumer_kind` text NOT NULL
- `consumer_invoice_id` uuid — FK-less polymorphic per-line consumer ref for `consumer_kind='ar_invoice'`: `ar_invoice_lines.id` (AR posting) or `shopify_order_lines.id` (Shopify COGS). FK to legacy `invoices(id)` dropped 20260895000000.
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `inventory_cycle_count_lines`  _(P3-6 (alter only))_

_(no columns parsed)_

## `inventory_cycle_counts`  _(P3-6)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `count_date` date NOT NULL DEFAULT current_date
- `location` text NOT NULL DEFAULT 'main'
- `status` text NOT NULL DEFAULT 'in_progress'
- `counted_by_user_id` uuid → `auth.users`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `inventory_layers`  _(P3-3)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `item_id` uuid → `ip_item_master` NOT NULL
- `received_at` timestamptz NOT NULL
- `original_qty` numeric(18,4) NOT NULL
- `remaining_qty` numeric(18,4) NOT NULL
- `unit_cost_cents` bigint NOT NULL
- `source_kind` text NOT NULL CHECK `IN ('ap_invoice',
    'adjustment',
    'opening_balance',
    'transfer_in',
    'credit_memo_return',
    'xoro_mirror_snapshot',
    'shopify_refund_restock',
    'fba_inbound',
    'wfs_inbound',
    'fba_return_restock',
    'wfs_return_restock')`
- `source_invoice_id` uuid → `invoices`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `location_id` uuid → `inventory_locations`
- `lot_number` text — lot the stock belongs to (from the originating PO line at receipt); enables lot-aware allocation _(lot numbers Phase 1, mig 20260899000000)_

## `inventory_locations`  _(P12-0)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `code` text NOT NULL
- `kind` text NOT NULL CHECK `kind IN ('warehouse','fba','wfs','3pl','dropship','virtual')`
- `country_code` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `inventory_transfers`  _(P3-7)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `item_id` uuid → `ip_item_master` NOT NULL
- `qty` numeric(18,4) NOT NULL
- `from_location` text NOT NULL
- `to_location` text NOT NULL
- `transfer_date` timestamptz NOT NULL DEFAULT now()
- `notes` text
- `posted_je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `invoice_line_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `invoice_id` uuid → `invoices` NOT NULL
- `po_line_item_id` uuid → `po_line_items`
- `line_index` integer NOT NULL
- `description` text
- `quantity_invoiced` numeric
- `unit_price` numeric
- `line_total` numeric
- `created_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid
- `expense_account_id` uuid → `gl_accounts`
- `inventory_item_id` uuid → `ip_item_master`
- `quantity` numeric(18,4)
- `unit_cost_cents` bigint
- `tax_amount_cents` bigint NOT NULL DEFAULT 0

## `invoice_payments`  _(P3-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `invoice_id` uuid → `invoices` NOT NULL
- `payment_date` date NOT NULL
- `amount_cents` bigint NOT NULL
- `bank_account_id` uuid → `gl_accounts` NOT NULL
- `method` text NOT NULL
- `reference` text
- `cash_je_id` uuid → `journal_entries`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `invoices`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `po_id` uuid → `tanda_pos`
- `invoice_number` text NOT NULL
- `invoice_date` date
- `due_date` date
- `subtotal` numeric
- `tax` numeric
- `total` numeric
- `currency` text NOT NULL DEFAULT 'USD'
- `status` text NOT NULL DEFAULT 'submitted' CHECK `IN ('submitted',
    'under_review',
    'approved',
    'paid',
    'rejected',
    'disputed',
    'pending_bookkeeper_approval')`
- `file_url` text
- `submitted_by` uuid → `vendor_users`
- `submitted_at` timestamptz NOT NULL DEFAULT now()
- `approved_at` timestamptz
- `approved_by` text
- `paid_at` timestamptz
- `payment_reference` text
- `payment_method` text
- `rejection_reason` text
- `notes` text
- `xoro_ap_id` text
- `xoro_last_synced_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid → `entities`
- `payment_terms` text
- `file_description` text
- `invoice_kind` text NOT NULL DEFAULT 'vendor_bill' CHECK `IN ('vendor_bill','vendor_credit_memo','expense_report')`
- `gl_status` text NOT NULL DEFAULT 'unposted' CHECK `IN ('unposted','pending_approval','posted','reversed','void')`
- `expense_account_id` uuid → `gl_accounts`
- `ap_account_id` uuid → `gl_accounts`
- `accrual_je_id` uuid → `journal_entries`
- `cash_je_id` uuid → `journal_entries`
- `total_amount_cents` bigint NOT NULL DEFAULT 0
- `paid_amount_cents` bigint NOT NULL DEFAULT 0
- `payment_terms_id` uuid → `payment_terms`
- `posting_date` date
- `description` text
- `source` text NOT NULL DEFAULT 'manual' CHECK `IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`
- `search_doc` tsvector
- `is_receipt_rollup` boolean NOT NULL DEFAULT false
- `rollup_parent_receipt_id` uuid → `tanda_po_receipts`

## `ip_action_templates`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `template_name` text NOT NULL
- `action_type` text NOT NULL
- `payload_template_json` jsonb NOT NULL DEFAULT '{}'::jsonb
- `active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_ai_answer_cache`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `question_hash` text NOT NULL
- `actions` jsonb NOT NULL DEFAULT '[]'::jsonb
- `suggestion` jsonb
- `expires_at` timestamptz NOT NULL
- `hit_count` int NOT NULL DEFAULT 0
- `last_hit_at` timestamptz

## `ip_ai_call_log`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `handler_name` text NOT NULL
- `output_tokens` integer
- `cost_usd` numeric(10,6) NOT NULL DEFAULT 0
- `related_table` text
- `called_at` timestamptz NOT NULL DEFAULT now()
- `error` text -- non-null when the call failed; cost still logged

## `ip_ai_documents`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `user_id` text
- `description` text
- `workflow_name` text NOT NULL
- `created_by` text
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `last_rendered_at` timestamptz -- bumped

## `ip_ai_suggestions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs`
- `scenario_id` uuid
- `forecast_type` text CHECK `forecast_type IN ('wholesale', 'ecom')`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `suggested_qty_delta` numeric(14, 3)
- `suggested_final_qty` numeric(14, 3)
- `confidence_score` numeric(4, 3)
- `input_summary_json` jsonb NOT NULL DEFAULT '{}'::jsonb
- `accepted_flag` boolean
- `accepted_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_ai_user_facts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `user_id` text
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_allocation_rules`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rule_name` text NOT NULL
- `priority_rank` integer NOT NULL DEFAULT 100
- `applies_to_customer_id` uuid → `ip_customer_master`
- `applies_to_channel_id` uuid → `ip_channel_master`
- `applies_to_category_id` uuid → `ip_category_master`
- `applies_to_sku_id` uuid → `ip_item_master`
- `qty` wins. reserve_qty numeric(14, 3)
- `reserve_percent` numeric(5, 4)
- `note` text
- `active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_ats_avg_cost`  _((pre-P))_

- `sku_code` text PK
- `avg_cost` numeric NOT NULL CHECK `avg_cost >= 0`
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_category_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `category_code` text NOT NULL
- `name` text NOT NULL
- `active` boolean NOT NULL DEFAULT true
- `external_refs` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid
- `parent_category_id` uuid → `ip_category_master`
- `level` smallint
- `path` text

## `ip_change_audit_log`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid
- `file_name` text
- `row_count` integer
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_channel_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `channel_code` text NOT NULL
- `name` text NOT NULL
- `channel_type` text NOT NULL CHECK `channel_type IN ('wholesale', 'ecom', 'marketplace', 'retail', 'other')`
- `the` external storefront id (Shopify -- shop domain, Amazon marketplace id, etc.) storefront_key text
- `currency` text
- `timezone` text
- `active` boolean NOT NULL DEFAULT true
- `external_refs` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_customer_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `customer_code` text NOT NULL
- `name` text NOT NULL
- `parent_customer_id` uuid → `ip_customer_master`
- `customer_tier` text
- `country` text
- `channel_id` uuid → `ip_channel_master`
- `active` boolean NOT NULL DEFAULT true
- `external_refs` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid

## `ip_data_freshness_thresholds`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_type` text NOT NULL
- `severity` text NOT NULL DEFAULT 'warning' CHECK `severity IN ('info', 'warning', 'critical')`
- `note` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_data_quality_issues`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `severity` text NOT NULL CHECK `severity IN ('info', 'warning', 'error')`
- `category` text NOT NULL
- `message` text NOT NULL
- `entity_type` text
- `entity_id` uuid
- `entity_key` text
- `details` jsonb NOT NULL DEFAULT '{}'::jsonb
- `first_seen_at` timestamptz NOT NULL DEFAULT now()
- `last_seen_at` timestamptz NOT NULL DEFAULT now()
- `resolved_at` timestamptz
- `resolved_by` text
- `resolution_notes` text

## `ip_design_concepts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `trend_brief_id` uuid → `ip_trend_briefs` NOT NULL
- `name` text NOT NULL
- `rationale_md` text
- `ai_fit_estimate` numeric(3,1) CHECK `ai_fit_estimate IS NULL OR (ai_fit_estimate >= 0 AND ai_fit_estimate <= 10)`
- `ai_fit_estimate_label` text NOT NULL DEFAULT 'AI heuristic — not validated'
- `past_sku_ids` uuid[] NOT NULL DEFAULT '{}'
- `status` text NOT NULL DEFAULT 'proposed' CHECK `status IN ('proposed', 'accepted', 'rejected', 'shipped')`
- `generated_by` text
- `model` text
- `token_usage` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_design_palettes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `concept_id` uuid → `ip_design_concepts` NOT NULL
- `name` text
- `colors` jsonb NOT NULL
- `rationale` text
- `model` text
- `token_usage` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_ecom_forecast`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `channel_id` uuid → `ip_channel_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `week_start` date NOT NULL
- `override_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `launch_flag` boolean NOT NULL DEFAULT false
- `markdown_flag` boolean NOT NULL DEFAULT false
- `trailing_13w_qty` numeric(14, 3)
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `planned_buy_qty` integer null

## `ip_ecom_override_events`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `channel_id` uuid → `ip_channel_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `week_start` date NOT NULL
- `week_end` date NOT NULL
- `override_qty` numeric(14, 3) NOT NULL
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_erp_writeback_config`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `system_name` text NOT NULL
- `dry_run_default` boolean NOT NULL DEFAULT true
- `endpoint_reference` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_execution_actions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `execution_batch_id` uuid → `ip_execution_batches` NOT NULL
- `recommendation_id` uuid → `ip_inventory_recommendations`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `vendor_id` uuid → `ip_vendor_master`
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `po_number` text
- `period_start` date
- `suggested_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `approved_qty` numeric(14, 3)
- `action_reason` text
- `payload_json` jsonb NOT NULL DEFAULT '{}'::jsonb
- `response_json` jsonb
- `error_message` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_execution_audit_log`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `execution_batch_id` uuid → `ip_execution_batches` NOT NULL
- `execution_action_id` uuid → `ip_execution_actions`
- `old_status` text
- `new_status` text
- `event_message` text
- `actor` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_execution_batches`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `scenario_id` uuid → `ip_scenarios`
- `batch_name` text NOT NULL
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ( 'draft', 'ready', 'approved', 'exported', 'submitted', 'partially_executed', 'executed', 'failed', 'archived' )`
- `created_by` text
- `approved_by` text
- `approved_at` timestamptz
- `note` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_export_jobs`  _((pre-P) (alter only))_

_(no columns parsed)_

## `ip_forecast_accuracy`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs`
- `scenario_id` uuid
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `system_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `actual_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `abs_error_final` numeric(14, 3) NOT NULL DEFAULT 0
- `pct_error_final` numeric(8, 4)
- `bias_final` numeric(14, 3) NOT NULL DEFAULT 0
- `weighted_error_final` numeric(14, 3) NOT NULL DEFAULT 0
- `created_at` timestamptz NOT NULL DEFAULT now()
- `forecast_method` text

## `ip_forecast_actuals`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `actual_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `actual_net_sales` numeric(14, 4)

## `ip_future_demand_requests`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `customer_id` uuid → `ip_customer_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `target_period_start` date NOT NULL
- `target_period_end` date NOT NULL
- `requested_qty` numeric(14, 3) NOT NULL
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_integration_health`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `system_name` text NOT NULL
- `last_success_at` timestamptz
- `last_error_at` timestamptz
- `last_error_message` text
- `last_rows_synced` integer
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_inventory_recommendations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `sku_id` uuid → `ip_item_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `recommendation_qty` numeric(14, 3)
- `action_reason` text
- `shortage_qty` numeric(14, 3)
- `excess_qty` numeric(14, 3)
- `service_risk_flag` boolean NOT NULL DEFAULT false
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_inventory_snapshot`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `warehouse_code` text NOT NULL DEFAULT 'DEFAULT'
- `snapshot_date` date NOT NULL
- `qty_on_hand` numeric(14, 3) NOT NULL
- `qty_available` numeric(14, 3)
- `qty_committed` numeric(14, 3)
- `qty_on_order` numeric(14, 3)
- `qty_in_transit` numeric(14, 3)
- `source` text NOT NULL CHECK `source IN ('xoro', 'shopify', 'manual')`
- `raw_payload_id` uuid → `raw_xoro_payloads`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_item_avg_cost`  _((pre-P))_

- `sku_code` text PK
- `avg_cost` numeric NOT NULL CHECK `avg_cost >= 0`
- `source` text NOT NULL DEFAULT 'manual' CHECK `source IN ('xoro', 'excel', 'manual')`
- `source_ref` text
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `brand_name` text
- `standard_unit_price` numeric(12, 4)

## `ip_item_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_code` text NOT NULL
- `style_code` text
- `description` text
- `category_id` uuid → `ip_category_master`
- `vendor_id` uuid → `ip_vendor_master`
- `color` text
- `size` text
- `unit_cost` numeric(12, 4)
- `unit_price` numeric(12, 4)
- `lead_time_days` integer
- `moq_units` integer
- `we` just -- surface whatever merchandising assigns. lifecycle_status text
- `active` boolean NOT NULL DEFAULT true
- `external_refs` jsonb NOT NULL DEFAULT '{}'::jsonb
- `attributes` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `pack_size` integer NOT NULL DEFAULT 1 CHECK `pack_size >= 1`
- `entity_id` uuid
- `gender_code` text CHECK `IN ('M', 'WMS', 'B', 'C', 'G', 'U')`
- `inseam` text
- `length` text
- `fit` text
- `style_id` uuid → `style_master`
- `is_apparel` boolean NOT NULL DEFAULT true
- `search_doc` tsvector
- `hts_code` text
- `default_coo` char(2)
- `unit_weight_grams` int
- `unit_cbm_cm3` int

## `ip_job_runs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `status` text NOT NULL DEFAULT 'queued' CHECK `status IN ( 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'partial_success' )`
- `started_at` timestamptz
- `completed_at` timestamptz
- `initiated_by` text
- `input_json` jsonb NOT NULL DEFAULT '{}'::jsonb
- `output_json` jsonb
- `error_message` text
- `retry_count` integer NOT NULL DEFAULT 0
- `retry_of` uuid → `ip_job_runs`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_open_purchase_orders`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `vendor_id` uuid → `ip_vendor_master`
- `po_number` text NOT NULL
- `po_line_number` text
- `order_date` date
- `expected_date` date
- `qty_ordered` numeric(14, 3) NOT NULL
- `qty_received` numeric(14, 3) NOT NULL DEFAULT 0
- `qty_open` numeric(14, 3) NOT NULL
- `unit_cost` numeric(12, 4)
- `currency` text
- `status` text
- `source` text NOT NULL DEFAULT 'xoro'
- `raw_payload_id` uuid → `raw_xoro_payloads`
- `source_line_key` text NOT NULL
- `last_seen_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `customer_id` uuid → `ip_customer_master`
- `buyer_name` text
- `channel` text NOT NULL DEFAULT 'wholesale'

## `ip_open_sales_orders`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `customer_name` text
- `so_number` text
- `ship_date` date
- `cancel_date` date
- `qty_ordered` numeric(14, 3) NOT NULL DEFAULT 0
- `qty_shipped` numeric(14, 3) NOT NULL DEFAULT 0
- `qty_open` numeric(14, 3) NOT NULL
- `unit_price` numeric(12, 4)
- `currency` text
- `status` text
- `store` text
- `source` text NOT NULL DEFAULT 'ats'
- `source_line_key` text NOT NULL
- `last_seen_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_override_effectiveness`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs`
- `scenario_id` uuid
- `forecast_type` text NOT NULL CHECK `forecast_type IN ('wholesale', 'ecom')`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `system_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `actual_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_planner_bucket_buys`  _((pre-P) (alter only))_

_(no columns parsed)_

## `ip_planner_overrides`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `customer_id` uuid → `ip_customer_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `override_qty` numeric(14, 3) NOT NULL
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_planning_anomalies`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs`
- `scenario_id` uuid
- `forecast_type` text CHECK `forecast_type IN ('wholesale', 'ecom')`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `channel_id` uuid → `ip_channel_master`
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `severity` text NOT NULL DEFAULT 'medium' CHECK `severity IN ('critical', 'high', 'medium', 'low')`
- `confidence_score` numeric(4, 3)
- `details_json` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_planning_approvals`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs`
- `scenario_id` uuid → `ip_scenarios`
- `approval_status` text NOT NULL CHECK `approval_status IN ('draft', 'in_review', 'approved', 'rejected', 'archived')`
- `approved_by` text
- `approved_at` timestamptz
- `note` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_planning_runs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `name` text NOT NULL
- `system_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `buyer_request_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `override_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `for` drawer display. history_months_used integer
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `wholesale_source_run_id` uuid → `ip_planning_runs`
- `ecom_source_run_id` uuid → `ip_planning_runs`
- `forecast_method_preference` text NOT NULL DEFAULT 'ly_sales' CHECK `forecast_method_preference IN ('ly_sales', 'weighted_recent', 'cadence')`
- `recon_include_planned_buys` boolean NOT NULL DEFAULT false

## `ip_product_channel_status`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `channel_id` uuid → `ip_channel_master` NOT NULL
- `listed` boolean NOT NULL DEFAULT false
- `price` numeric(12, 4)
- `compare_at_price` numeric(12, 4)
- `currency` text
- `published_at` timestamptz
- `unpublished_at` timestamptz
- `source` text NOT NULL
- `raw_payload_id` uuid
- `observed_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `is_active` boolean
- `launch_date` date
- `markdown_flag` boolean NOT NULL DEFAULT false
- `inventory_policy` text

## `ip_projected_inventory`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `sku_id` uuid → `ip_item_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `ats_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `total_available_supply_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `reserved_wholesale_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `allocated_total_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `allocated_ecom_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `ending_inventory_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `excess_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `projected_stockout_flag` boolean NOT NULL DEFAULT false
- `created_at` timestamptz NOT NULL DEFAULT now()
- `inbound_planned_buy_qty` numeric(14, 3) NOT NULL DEFAULT 0

## `ip_receipts_history`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `vendor_id` uuid → `ip_vendor_master`
- `po_number` text
- `receipt_number` text
- `received_date` date NOT NULL
- `qty` numeric(14, 3) NOT NULL
- `warehouse_code` text
- `source` text NOT NULL DEFAULT 'xoro'
- `raw_payload_id` uuid → `raw_xoro_payloads`
- `source_line_key` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_roles`  _((pre-P) (alter only))_

_(no columns parsed)_

## `ip_sales_history_ecom`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `channel_id` uuid → `ip_channel_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `order_number` text
- `order_date` date NOT NULL
- `qty` numeric(14, 3) NOT NULL
- `returned_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `net_qty` numeric(14, 3) NOT NULL
- `gross_amount` numeric(14, 4)
- `discount_amount` numeric(14, 4)
- `refund_amount` numeric(14, 4)
- `net_amount` numeric(14, 4)
- `currency` text
- `source` text NOT NULL DEFAULT 'shopify'
- `raw_payload_id` uuid → `raw_shopify_payloads`
- `source_line_key` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- `customer_id` uuid → `ip_customer_master`

## `ip_sales_history_wholesale`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `customer_id` uuid → `ip_customer_master`
- `category_id` uuid → `ip_category_master`
- `channel_id` uuid → `ip_channel_master`
- `order_number` text
- `invoice_number` text
- `txn_date` date NOT NULL
- `qty` numeric(14, 3) NOT NULL
- `unit_price` numeric(12, 4)
- `gross_amount` numeric(14, 4)
- `discount_amount` numeric(14, 4)
- `net_amount` numeric(14, 4)
- `currency` text
- `source` text NOT NULL DEFAULT 'xoro'
- `raw_payload_id` uuid → `raw_xoro_payloads`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `qty_grain` text NOT NULL DEFAULT 'unit' CHECK `qty_grain IN ('unit', 'pack')`
- `qty_units` numeric(14, 3)
- `unit_cost_at_sale` numeric(12, 4)
- `margin_amount` numeric(14, 4)
- `margin_pct` numeric(6, 4)
- `cogs_amount` numeric(14, 4)

## `ip_scenario_assumptions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `scenario_id` uuid → `ip_scenarios` NOT NULL
- `applies_to_customer_id` uuid → `ip_customer_master`
- `applies_to_channel_id` uuid → `ip_channel_master`
- `applies_to_category_id` uuid → `ip_category_master`
- `applies_to_sku_id` uuid → `ip_item_master`
- `period_start` date
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_scenarios`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `scenario_name` text NOT NULL
- `enforced` taxonomy in TS. scenario_type text NOT NULL DEFAULT 'what_if'
- `base_run_reference_id` uuid → `ip_planning_runs`
- `note` text
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_supply_exceptions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `sku_id` uuid → `ip_item_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `keep` in sync with exceptionEngine.ts exception_type text NOT NULL CHECK `exception_type IN ( 'projected_stockout', 'negative_ats', 'late_po', 'excess_inventory', 'supply_demand_mismatch', 'missing_supply_inputs', 'protected_not_covered', 'reserved_not_covered' )`
- `severity` text NOT NULL DEFAULT 'medium' CHECK `severity IN ('critical', 'high', 'medium', 'low')`
- `details` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `ip_trend_briefs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `brief_month` date NOT NULL
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'published', 'archived')`
- `title` text
- `summary_md` text
- `themes_jsonb` jsonb
- `raw_sources` jsonb
- `model` text
- `token_usage` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_user_roles`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `user_email` text NOT NULL
- `role_id` uuid → `ip_roles` NOT NULL
- `granted_by` text
- `granted_at` timestamptz NOT NULL DEFAULT now()
- `active` boolean NOT NULL DEFAULT true
- `note` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_vendor_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_code` text NOT NULL
- `name` text NOT NULL
- `country` text
- `default_lead_time_days` integer
- `moq_units` integer
- `active` boolean NOT NULL DEFAULT true
- `portal_vendor_id` uuid → `vendors`
- `external_refs` jsonb NOT NULL DEFAULT '{}'::jsonb
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid

## `ip_vendor_timing_signals`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sku_id` uuid → `ip_item_master` NOT NULL
- `vendor_id` uuid → `ip_vendor_master`
- `avg_lead_time_days` integer
- `receipt_variability_days` integer
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `ip_wholesale_forecast`  _((pre-P) (alter only))_

- `ly_reference_qty` integer null
- `planned_buy_qty` integer null
- `unit_cost_override` numeric
- `system_forecast_qty_override` numeric(14, 3)
- `system_forecast_qty_overridden_at` timestamptz
- `system_forecast_qty_overridden_by` text
- `historical_margin_pct` numeric(6, 4) NULL

## `ip_wholesale_forecast_tbd`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `not` normalized columns. group_name text
- `sub_category_name` text
- `period_end` date NOT NULL
- `period_code` text NOT NULL
- `buyer_request_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `override_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `planned_buy_qty` numeric(14, 3)
- `unit_cost` numeric(12, 4)
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `is_user_added` boolean NOT NULL DEFAULT false

## `ip_wholesale_recommendations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `planning_run_id` uuid → `ip_planning_runs` NOT NULL
- `customer_id` uuid → `ip_customer_master` NOT NULL
- `category_id` uuid → `ip_category_master`
- `sku_id` uuid → `ip_item_master` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `final_forecast_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `available_supply_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `projected_shortage_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `projected_excess_qty` numeric(14, 3) NOT NULL DEFAULT 0
- `recommended_qty` numeric(14, 3)
- `action_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `journal_entries`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `period_id` uuid → `gl_periods` NOT NULL
- `basis` text NOT NULL
- `journal_type` text NOT NULL
- `posting_date` date NOT NULL
- `source_module` text NOT NULL
- `source_table` text
- `source_id` text
- `description` text NOT NULL
- `status` text NOT NULL DEFAULT 'draft'
- `posted_at` timestamptz
- `posted_by_user_id` uuid → `auth.users`
- `reversed_by_je_id` uuid → `journal_entries`
- `reverses_je_id` uuid → `journal_entries`
- `sibling_je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `source` text NOT NULL DEFAULT 'manual' CHECK `IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`

## `journal_entry_lines`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `journal_entry_id` uuid → `journal_entries` NOT NULL
- `line_number` smallint NOT NULL
- `account_id` uuid → `gl_accounts` NOT NULL
- `debit` numeric(18,2) NOT NULL DEFAULT 0
- `credit` numeric(18,2) NOT NULL DEFAULT 0
- `memo` text
- `subledger_type` text
- `subledger_id` uuid
- `created_at` timestamptz NOT NULL DEFAULT now()

## `label_batch_lines`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `batch_id` uuid → `label_batches` NOT NULL
- `style_no` text NOT NULL
- `color` text NOT NULL
- `scale_code` text NOT NULL
- `pack_gtin` text NOT NULL
- `label_qty` integer NOT NULL CHECK `label_qty > 0`
- `source_sheet_name` text
- `source_channel` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `label_type` text DEFAULT 'pack_gtin' CHECK `label_type IN ('pack_gtin', 'sscc', 'both')`
- `sscc_first` text, -- first SSCC in the range for this line ADD COLUMN IF

## `label_batches`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `upload_id` uuid → `packing_list_uploads`
- `batch_name` text NOT NULL
- `status` text NOT NULL DEFAULT 'generated' CHECK `status IN ('generated', 'printed', 'cancelled')`
- `output_format` text NOT NULL DEFAULT 'pdf'
- `generated_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()
- `label_mode` text NOT NULL DEFAULT 'pack_gtin' CHECK `label_mode IN ('pack_gtin', 'sscc', 'both')`

## `label_print_logs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `label_batch_id` uuid → `label_batches`
- `label_type` text NOT NULL
- `printed_by` text
- `print_method` text
- `output_file_path` text
- `status` text NOT NULL DEFAULT 'printed' CHECK `status IN ('printed', 'reprint', 'failed')`
- `reprint_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `label_templates`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `label_type` text NOT NULL CHECK `label_type IN ('pack_gtin', 'sscc')`
- `template_name` text NOT NULL
- `label_width` text
- `barcode_format` text NOT NULL DEFAULT 'gtin14'
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `marketplace_inquiries`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `listing_id` uuid → `marketplace_listings` NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `inquired_by` text NOT NULL
- `status` text NOT NULL DEFAULT 'sent' CHECK `status IN ('sent', 'responded', 'converted_to_rfq')`
- `response` text
- `responded_at` timestamptz
- `rfq_id` uuid → `rfqs`

## `marketplace_listings`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `title` text NOT NULL
- `description` text
- `category` text
- `capabilities` text[] NOT NULL DEFAULT '{}'
- `certifications` text[] NOT NULL DEFAULT '{}'
- `geographic_coverage` text[] NOT NULL DEFAULT '{}'
- `min_order_value` numeric(14,2)
- `lead_time_range` text
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'published', 'suspended')`
- `views` integer NOT NULL DEFAULT 0
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `mobile_sessions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_user_id` uuid → `vendor_users` NOT NULL
- `device_token` text NOT NULL
- `platform` text NOT NULL CHECK `platform IN ('ios', 'android')`
- `app_version` text
- `last_active_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()

## `notification_digest_pending`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `recipient_email` text NOT NULL
- `event_type` text NOT NULL
- `entity_id` uuid
- `created_at` timestamptz NOT NULL DEFAULT now()

## `notification_dispatches`  _(P2-3)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `event_id` uuid → `notification_events` NOT NULL
- `recipient_user_id` uuid → `auth.users` NOT NULL
- `channel` text NOT NULL
- `status` text NOT NULL DEFAULT 'pending'
- `sent_at` timestamptz
- `read_at` timestamptz
- `error_message` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `notification_events`  _(P2-3)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `kind` text NOT NULL
- `severity` text NOT NULL DEFAULT 'info'
- `subject` text NOT NULL
- `body` text NOT NULL
- `context_table` text
- `context_id` uuid
- `payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `notification_preferences`  _(P2-3)_

- `user_id` uuid → `auth.users` NOT NULL
- `kind` text NOT NULL
- `channel` text NOT NULL
- `enabled` boolean NOT NULL DEFAULT true
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `notifications`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `recipient_auth_id` uuid
- `body` text
- `link` text
- `email_status` text NOT NULL DEFAULT 'pending' CHECK `email_status IN ('pending', 'sent', 'failed', 'skipped')`
- `email_attempts` integer NOT NULL DEFAULT 0
- `email_sent_at` timestamptz
- `email_error` text
- `resend_message_id` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- RLS: `anon_all_notifications` (anon, FOR ALL, true); `vendor_own_notifications_select` / `_update` / `_delete` (authenticated, `recipient_auth_id = auth.uid()`). The `_delete` policy (20260843000000) lets a vendor delete their own notifications from the portal.

## `notifications_overdue_log`  _(P4-6)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `customer_id` uuid → `customers` NOT NULL
- `bucket` text NOT NULL
- `sent_on` date NOT NULL DEFAULT current_date
- `open_cents` bigint
- `created_at` timestamptz NOT NULL DEFAULT now()

## `onboarding_steps`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `workflow_id` uuid → `onboarding_workflows` NOT NULL
- `step_name` text NOT NULL CHECK `step_name IN ('company_info', 'banking', 'tax', 'compliance_docs', 'portal_tour', 'agreement')`
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending', 'complete', 'skipped')`
- `data` jsonb
- `completed_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()

## `onboarding_workflows`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `status` text NOT NULL DEFAULT 'not_started' CHECK `status IN ('not_started', 'in_progress', 'pending_review', 'approved', 'rejected')`
- `current_step` integer NOT NULL DEFAULT 0
- `completed_steps` jsonb NOT NULL DEFAULT '[]'::jsonb
- `started_at` timestamptz
- `completed_at` timestamptz
- `approved_by` text
- `rejection_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `pack_gtin_bom`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `pack_gtin` text → `pack_gtin_master` NOT NULL
- `child_upc` text → `upc_item_master` NOT NULL
- `size` text NOT NULL
- `qty_in_pack` integer NOT NULL CHECK `qty_in_pack > 0`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `pack_gtin_bom_issues`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `pack_gtin` text NOT NULL
- `issue_type` text NOT NULL
- `severity` text NOT NULL CHECK `severity IN ('info', 'warning', 'error')`
- `message` text NOT NULL
- `context` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `pack_gtin_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `style_no` text NOT NULL
- `color` text NOT NULL
- `scale_code` text NOT NULL
- `pack_gtin` text NOT NULL
- `item_reference` bigint NOT NULL
- `units_per_pack` integer
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'inactive')`
- `source_method` text NOT NULL DEFAULT 'system_generated'
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `bom_status` text NOT NULL DEFAULT 'not_built' CHECK `bom_status IN ('not_built', 'complete', 'incomplete', 'error')`
- `bom_last_built_at` timestamptz
- `bom_issue_summary` jsonb

## `packing_list_blocks`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `upload_id` uuid → `packing_list_uploads` NOT NULL
- `sheet_name` text NOT NULL
- `block_type` text NOT NULL DEFAULT 'channel_qty'
- `style_no` text
- `color` text
- `channel` text
- `scale_code` text
- `pack_qty` integer
- `raw_payload` jsonb NOT NULL DEFAULT '{}'::jsonb
- `parsed_payload` jsonb
- `confidence_score` numeric(5,2)
- `parse_status` text NOT NULL DEFAULT 'parsed' CHECK `parse_status IN ('parsed', 'review', 'failed')`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `packing_list_uploads`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `file_name` text NOT NULL
- `storage_path` text NOT NULL DEFAULT ''
- `parse_status` text NOT NULL DEFAULT 'uploaded' CHECK `parse_status IN ('uploaded', 'parsing', 'parsed', 'error')`
- `parse_summary` jsonb
- `uploaded_at` timestamptz NOT NULL DEFAULT now()
- `created_at` timestamptz NOT NULL DEFAULT now()

## `parse_issues`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `upload_id` uuid → `packing_list_uploads` NOT NULL
- `sheet_name` text
- `issue_type` text NOT NULL
- `severity` text NOT NULL CHECK `severity IN ('info', 'warning', 'error')`
- `message` text NOT NULL
- `raw_context` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `payment_terms`  _(P3-9)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `code` text NOT NULL
- `name` text NOT NULL
- `due_days` int NOT NULL
- `discount_pct` numeric(5,4) NOT NULL DEFAULT 0
- `discount_days` int NOT NULL DEFAULT 0
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `payments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `invoice_id` uuid → `invoices`
- `vendor_id` uuid → `vendors` NOT NULL
- `amount` numeric(14,2) NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `method` text NOT NULL DEFAULT 'ach' CHECK `method IN ('ach', 'wire', 'virtual_card', 'check', 'paypal', 'wise', 'manual')`
- `status` text NOT NULL DEFAULT 'initiated' CHECK `status IN ('initiated', 'processing', 'completed', 'failed', 'cancelled')`
- `reference` text
- `metadata` jsonb NOT NULL DEFAULT '{}'::jsonb
- `initiated_at` timestamptz NOT NULL DEFAULT now()
- `completed_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `po_acknowledgments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `po_id` uuid NOT NULL
- `vendor_user_id` uuid → `vendor_users` NOT NULL
- `acknowledged_at` timestamptz NOT NULL DEFAULT now()
- `note` text
- `po_number` text NOT NULL

## `po_commitments`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `po_id` uuid → `tanda_pos` NOT NULL
- `po_line_item_id` uuid → `po_line_items`
- `vendor_id` uuid → `vendors` NOT NULL
- `expected_account_id` uuid → `gl_accounts`
- `committed_at` timestamptz NOT NULL DEFAULT now()
- `committed_amount_cents` bigint NOT NULL
- `consumed_amount_cents` bigint NOT NULL DEFAULT 0
- `remaining_amount_cents` bigint
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open','partial','closed','cancelled')`
- `expected_in_dc_date` date
- `closed_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()

## `po_line_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `po_id` uuid → `tanda_pos` NOT NULL
- `line_index` integer NOT NULL
- `item_number` text
- `description` text
- `qty_ordered` numeric
- `qty_received` numeric
- `qty_remaining` numeric
- `unit_price` numeric
- `line_total` numeric
- `date_expected_delivery` text
- `raw_json` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid

## `po_message_attachments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `message_id` uuid → `po_messages` NOT NULL
- `file_url` text NOT NULL
- `file_size_bytes` bigint
- `file_mime_type` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `po_messages`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `po_id` uuid → `tanda_pos` NOT NULL
- `sender_type` text NOT NULL CHECK `sender_type IN ('vendor', 'internal')`
- `sender_auth_id` uuid
- `read_by_vendor` boolean NOT NULL DEFAULT false
- `read_by_internal` boolean NOT NULL DEFAULT false
- `created_at` timestamptz NOT NULL DEFAULT now()
- `workspace_id` uuid → `collaboration_workspaces`

## `po_phase_notes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `po_id` uuid → `tanda_pos` NOT NULL
- `phase_name` text NOT NULL
- `po_line_key` text
- `author_auth_id` uuid
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `deleted_at` timestamptz -- soft delete so audit history survives

## `preferred_vendors`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `category` text NOT NULL
- `rank` integer NOT NULL DEFAULT 1
- `notes` text
- `set_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `product_attribute_definitions`  _(P8-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `category_id` uuid → `product_categories`
- `attribute_key` text NOT NULL
- `label` text NOT NULL
- `value_type` text NOT NULL CHECK `value_type IN ('enum','number','text','boolean','date')`
- `options` jsonb
- `is_required` boolean NOT NULL DEFAULT false
- `sort_order` int NOT NULL DEFAULT 0
- `created_at` timestamptz NOT NULL DEFAULT now()

## `product_attributes`  _(P8-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `style_id` uuid → `style_master` NOT NULL
- `attribute_key` text NOT NULL
- `value` jsonb NOT NULL
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `updated_by_user_id` uuid → `auth.users`

## `product_categories`  _(P8-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `parent_category_id` uuid → `product_categories`
- `code` text NOT NULL
- `name` text NOT NULL
- `sort_order` int NOT NULL DEFAULT 0
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `product_descriptions`  _(P8-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `style_id` uuid → `style_master` NOT NULL
- `locale` text NOT NULL DEFAULT 'en-US'
- `short_description` text
- `long_description` text
- `bullet_1` text
- `bullet_2` text
- `bullet_3` text
- `bullet_4` text
- `bullet_5` text
- `seo_title` text
- `seo_description` text
- `publish_status` text NOT NULL DEFAULT 'draft' CHECK `publish_status IN ('draft','published')`
- `published_at` timestamptz
- `published_by_user_id` uuid → `auth.users`
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `updated_by_user_id` uuid → `auth.users`

## `product_images`  _(P8-5)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `style_id` uuid → `style_master` NOT NULL
- `image_kind` text NOT NULL DEFAULT 'flat' CHECK `image_kind IN ('flat','lifestyle','spec','swatch','other')`
- `storage_path` text NOT NULL
- `storage_path_thumb` text
- `storage_path_web` text
- `storage_path_print` text
- `alt_text` text
- `sort_order` int NOT NULL DEFAULT 0
- `is_primary` boolean NOT NULL DEFAULT false
- `mime_type` text
- `bytes` bigint
- `width` int
- `height` int
- `uploaded_by_user_id` uuid → `auth.users`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `push_notifications`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_user_id` uuid → `vendor_users` NOT NULL
- `mobile_session_id` uuid → `mobile_sessions`
- `title` text NOT NULL
- `body` text
- `data` jsonb
- `status` text NOT NULL DEFAULT 'queued' CHECK `status IN ('queued', 'sent', 'delivered', 'failed')`
- `sent_at` timestamptz
- `delivered_at` timestamptz
- `error_message` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `qc_inspections`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `receipt_id` uuid → `receipts` NOT NULL
- `receipt_line_item_id` uuid → `receipt_line_items` NOT NULL
- `inspector_user_id` uuid → `auth.users`
- `inspected_at` timestamptz NOT NULL DEFAULT now()
- `disposition` text NOT NULL CHECK `disposition IN ('pass','conditional_pass','fail')`
- `qty_inspected` numeric(18,4) NOT NULL
- `qty_passed` numeric(18,4) NOT NULL
- `qty_conditional` numeric(18,4) NOT NULL DEFAULT 0
- `qty_failed` numeric(18,4) NOT NULL DEFAULT 0
- `failure_disposition` text CHECK `failure_disposition IS NULL OR failure_disposition IN ('vendor_rma','vendor_credit_only','write_off','rework_inhouse')`
- `failure_reason` text
- `photo_attachment_ids` uuid[] NOT NULL DEFAULT '{}'
- `rework_completed_at` timestamptz
- `vendor_credit_invoice_id` uuid → `invoices`
- `writeoff_je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `raw_shopify_payloads`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `period_start` date
- `period_end` date
- `source_hash` text
- `payload` jsonb NOT NULL
- `record_count` integer
- `ingested_at` timestamptz NOT NULL DEFAULT now()
- `ingested_by` text
- `normalized_at` timestamptz
- `normalization_error` text

## `raw_xoro_payloads`  _((pre-P) (alter only))_

_(no columns parsed)_

## `receipt_line_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `receipt_id` uuid → `receipts` NOT NULL
- `po_line_item_id` uuid → `po_line_items`
- `line_index` integer NOT NULL
- `item_number` text
- `description` text
- `quantity_received` numeric NOT NULL
- `condition` text CHECK `condition IN ('good', 'damaged', 'short', 'over') OR condition IS NULL`
- `notes` text
- `raw_json` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid
- `sku_id` uuid → `ip_item_master`
- `quantity_accepted` numeric
- `quantity_rejected` numeric
- `qc_disposition` text CHECK `IN ('pending','pass','conditional_pass','fail')`
- `putaway_location_id` uuid → `inventory_locations`
- `landed_cost_per_unit_cents` bigint
- `inventory_layer_id` uuid → `inventory_layers`

## `receipts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors`
- `po_id` uuid → `tanda_pos`
- `shipment_id` uuid → `shipments`
- `receipt_number` text
- `xoro_receipt_id` text
- `received_date` timestamptz
- `received_by` text
- `carrier_tracking_ref` text
- `status` text NOT NULL DEFAULT 'received' CHECK `status IN ('received', 'partial', 'exception', 'voided')`
- `notes` text
- `raw_payload` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid
- `source` text NOT NULL DEFAULT 'tangerine' CHECK `IN ('tangerine','xoro_mirror','edi_945_recv','manual','scanner')`
- `receiving_dock` text
- `carrier_name` text
- `container_number` text
- `bol_number` text
- `gs1_sscc_codes` text[] NOT NULL DEFAULT '{}'
- `qc_required` boolean NOT NULL DEFAULT true
- `qc_completed_at` timestamptz
- `putaway_completed_at` timestamptz
- `customs_entry_id` uuid
- `broker_invoice_id` uuid

## `receiving_session_lines`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `session_id` uuid → `receiving_sessions` NOT NULL
- `child_upc` text NOT NULL
- `style_no` text NOT NULL
- `color` text NOT NULL
- `size` text NOT NULL
- `expected_qty` integer NOT NULL CHECK `expected_qty > 0`
- `received_qty` integer
- `variance_qty` integer
- `status` text NOT NULL DEFAULT 'expected' CHECK `status IN ('expected', 'matched', 'variance')`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `receiving_sessions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sscc` text NOT NULL
- `carton_id` uuid → `cartons`
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'received', 'variance', 'override')`
- `received_at` timestamptz
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `recon_cleared_log`  _(P9-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `recon_variance_id` uuid → `recon_variances` NOT NULL
- `cleared_by_auth_id` uuid → `auth.users`
- `cleared_by_employee_id` uuid → `employees`
- `reason` text NOT NULL
- `cleared_at` timestamptz NOT NULL DEFAULT now()

## `recon_cutover_signoffs`  _(P9-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `domain` text NOT NULL
- `source_tag` text
- `clean_window_start` date NOT NULL
- `clean_window_end` date NOT NULL
- `total_recons` int NOT NULL
- `signoff_employee_id` uuid → `employees`
- `signoff_at` timestamptz NOT NULL DEFAULT now()
- `notes` text

## `recon_runs`  _(P9-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `domain` text NOT NULL CHECK `domain IN ('ap','ar','cash','gl','inventory')`
- `run_date` date NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `cadence` text NOT NULL DEFAULT 'weekly' CHECK `cadence IN ('weekly','manual','replay')`
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending','running','clean','variance','error')`
- `started_at` timestamptz
- `completed_at` timestamptz
- `totals_jsonb` jsonb NOT NULL DEFAULT '{}'::jsonb
- `replay_of_id` uuid → `recon_runs`
- `replay_reason` text
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `recon_variances`  _(P9-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `recon_run_id` uuid → `recon_runs` NOT NULL
- `source_table` text NOT NULL
- `source_id` text NOT NULL
- `source_tag` text
- `tangerine_amount_cents` bigint NOT NULL
- `xoro_amount_cents` bigint NOT NULL
- `variance_amount_cents` bigint NOT NULL
- `variance_percent` numeric(8,4)
- `status` text NOT NULL DEFAULT 'over' CHECK `status IN ('within','over','cleared','suppressed')`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `rfq_attachments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rfq_id` uuid → `rfqs`
- `quote_id` uuid → `rfq_quotes`
- `file_url` text NOT NULL
- `file_name` text NOT NULL
- `file_size_bytes` bigint
- `uploaded_by_type` text NOT NULL CHECK `uploaded_by_type IN ('internal', 'vendor')`
- `uploaded_by` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `rfq_invitations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rfq_id` uuid → `rfqs` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `status` text NOT NULL DEFAULT 'invited' CHECK `status IN ('invited', 'viewed', 'submitted', 'declined')`
- `invited_at` timestamptz NOT NULL DEFAULT now()
- `viewed_at` timestamptz
- `declined_at` timestamptz

## `rfq_line_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rfq_id` uuid → `rfqs` NOT NULL
- `line_index` integer NOT NULL DEFAULT 1
- `description` text NOT NULL
- `quantity` integer NOT NULL
- `unit_of_measure` text
- `specifications` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `rfq_quote_lines`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `quote_id` uuid → `rfq_quotes` NOT NULL
- `rfq_line_item_id` uuid → `rfq_line_items` NOT NULL
- `unit_price` numeric
- `quantity` integer
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `rfq_quotes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rfq_id` uuid → `rfqs` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'submitted', 'under_review', 'awarded', 'rejected')`
- `total_price` numeric
- `lead_time_days` integer
- `valid_until` date
- `notes` text
- `submitted_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `rfqs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `title` text NOT NULL
- `description` text
- `category` text
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'published', 'closed', 'awarded')`
- `submission_deadline` timestamptz
- `delivery_required_by` date
- `estimated_quantity` integer
- `estimated_budget` numeric
- `currency` text NOT NULL DEFAULT 'USD'
- `created_by` text
- `awarded_to_vendor_id` uuid → `vendors`
- `awarded_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `row_changes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities`
- `source_table` text NOT NULL
- `source_id` text NOT NULL
- `operation` text NOT NULL CHECK `operation IN ('INSERT','UPDATE','DELETE','VOID','POST','REVERSE')`
- `before_jsonb` jsonb
- `after_jsonb` jsonb
- `changed_columns` text[]
- `actor_auth_id` uuid
- `actor_employee_id` uuid → `employees`
- `actor_display_name` text
- `source` text CHECK `source IS NULL OR source IN ('manual','xoro_mirror','shopify','fba','walmart','faire','edi_3pl','plaid_sync','api','system')`
- `reason` text
- `correlation_id` text
- `user_agent` text
- `ip_address` inet
- `changed_at` timestamptz NOT NULL DEFAULT now()

## `sales_rep_commission_tiers`  _(P7-4)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sales_rep_id` uuid → `sales_reps` NOT NULL
- `threshold_cents` bigint NOT NULL CHECK `threshold_cents >= 0`
- `rate_pct` numeric(5,2) NOT NULL CHECK `rate_pct >= 0 AND rate_pct <= 100`
- `effective_from` date NOT NULL DEFAULT current_date
- `effective_to` date
- `created_at` timestamptz NOT NULL DEFAULT now()

## `sales_reps`  _(P7-4)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `employee_id` uuid → `employees`
- `display_name` text NOT NULL
- `email` text
- `default_commission_pct` numeric(5,2) NOT NULL DEFAULT 0 CHECK `default_commission_pct >= 0 AND default_commission_pct <= 100`
- `payout_terms_days` int NOT NULL DEFAULT 30 CHECK `payout_terms_days >= 0`
- `is_active` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `search_doc` tsvector

## `scale_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `scale_code` text NOT NULL
- `description` text
- `total_units` integer
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `scale_size_ratios`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `scale_code` text → `scale_master` NOT NULL
- `size` text NOT NULL
- `qty` integer NOT NULL CHECK `qty > 0`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `scanner_events`  _(P3-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `session_id` uuid → `scanner_sessions` NOT NULL
- `client_event_id` uuid NOT NULL
- `scanned_barcode` text NOT NULL
- `resolved_item_id` uuid → `ip_item_master`
- `qty` numeric(18,4) NOT NULL DEFAULT 1
- `client_timestamp` timestamptz NOT NULL
- `server_received_at` timestamptz NOT NULL DEFAULT now()
- `notes` text

## `scanner_sessions`  _(P3-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `device_user_id` uuid → `auth.users` NOT NULL
- `mode` text NOT NULL
- `target_kind` text NOT NULL
- `target_id` uuid NULL
- `status` text NOT NULL DEFAULT 'open'
- `scanned_at` timestamptz
- `submitted_at` timestamptz
- `client_meta` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `shipment_events`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `shipment_id` uuid → `shipments` NOT NULL
- `container_number` text
- `order_id` integer
- `event_code` text
- `event_type` text
- `status` text
- `description` text
- `location_locode` text
- `facility_name` text
- `event_date` timestamptz
- `is_actual` boolean NOT NULL DEFAULT false
- `raw_json` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid

## `shipment_lines`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `shipment_id` uuid → `shipments` NOT NULL
- `po_line_item_id` uuid → `po_line_items`
- `quantity_shipped` numeric NOT NULL CHECK `quantity_shipped > 0`
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `entity_id` uuid

## `shipments`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `vendor_user_id` uuid → `vendor_users`
- `po_number` text
- `number` text NOT NULL
- `number_type` text NOT NULL CHECK `number_type IN ('CT', 'BL', 'BK')`
- `sealine_scac` text
- `sealine_name` text
- `pol_locode` text
- `pod_locode` text
- `pol_date` timestamptz
- `pod_date` timestamptz
- `eta` timestamptz
- `ata` timestamptz
- `current_status` text
- `last_tracked_at` timestamptz
- `raw_payload` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `po_id` uuid → `tanda_pos`
- `invoice_id` uuid, -- FK added in Phase 2.2 invoice migration ADD COLUMN IF
- `ship_date` timestamptz
- `estimated_delivery` timestamptz
- `actual_delivery` timestamptz
- `workflow_status` text CHECK `IN ('created', 'submitted', 'in_transit', 'delivered', 'exception')`
- `notes` text
- `asn_number` text
- `packing_list_url` text
- `bl_document_url` text
- `ship_via` text
- `invoice_created_at` timestamptz
- `entity_id` uuid

## `shopify_disputes`  _(P11-8)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `shopify_store_id` uuid → `shopify_stores` NOT NULL
- `shopify_order_id` uuid → `shopify_orders`
- `shopify_dispute_id` text NOT NULL
- `dispute_type` text NOT NULL
- `dispute_amount_cents` bigint NOT NULL
- `status` text NOT NULL
- `reason` text
- `evidence_due_by` timestamptz
- `case_id` uuid → `cases`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL
- `source` text NOT NULL DEFAULT 'shopify' CHECK `source = 'shopify'`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `shopify_order_lines`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `shopify_order_id` uuid → `shopify_orders` NOT NULL
- `line_number` int NOT NULL
- `shopify_line_id` text NOT NULL
- `sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `title` text NOT NULL
- `quantity` int NOT NULL
- `unit_price_cents` bigint NOT NULL
- `line_total_cents` bigint NOT NULL
- `line_tax_cents` bigint NOT NULL DEFAULT 0
- `line_discount_cents` bigint NOT NULL DEFAULT 0
- `raw_payload` jsonb NOT NULL

## `shopify_orders`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `shopify_store_id` uuid → `shopify_stores` NOT NULL
- `shopify_order_id` text NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `total_amount_cents` bigint NOT NULL
- `subtotal_amount_cents` bigint NOT NULL
- `tax_amount_cents` bigint NOT NULL DEFAULT 0
- `shipping_amount_cents` bigint NOT NULL DEFAULT 0
- `discount_amount_cents` bigint NOT NULL DEFAULT 0
- `payment_gateway` text
- `discount_codes` jsonb NOT NULL DEFAULT '[]'::jsonb
- `customer_id` uuid → `customers`
- `customer_email` text
- `ar_invoice_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL
- `source` text NOT NULL DEFAULT 'shopify' CHECK `source IN ('shopify')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `shopify_payouts`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `shopify_store_id` uuid → `shopify_stores` NOT NULL
- `shopify_payout_id` text NOT NULL
- `payout_date` date NOT NULL
- `gross_amount_cents` bigint NOT NULL
- `fees_amount_cents` bigint NOT NULL
- `net_amount_cents` bigint NOT NULL
- `currency` text NOT NULL DEFAULT 'USD'
- `bank_transaction_id` uuid → `bank_transactions`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `shopify_refunds`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `shopify_order_id` uuid → `shopify_orders` NOT NULL
- `shopify_refund_id` text NOT NULL
- `refund_type` text NOT NULL CHECK `refund_type IN ('full','partial')`
- `refund_amount_cents` bigint NOT NULL
- `restocking_fee_cents` bigint NOT NULL DEFAULT 0
- `processed_at` timestamptz NOT NULL
- `ar_credit_memo_id` uuid → `ar_invoices`
- `raw_payload` jsonb NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `shopify_stores`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `shopify_domain` text NOT NULL
- `key` = SHOPIFY_TOKEN_ENC_KEY access_token_iv bytea
- `access_token_tag` bytea
- `webhook_secret_ciphertext` bytea
- `webhook_secret_iv` bytea
- `webhook_secret_tag` bytea
- `api_version` text NOT NULL DEFAULT '2025-01'
- `is_active` boolean NOT NULL DEFAULT true
- `last_backfill_at` timestamptz
- `last_webhook_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `shopify_webhook_log`  _(P11-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `shopify_store_id` uuid → `shopify_stores`
- `webhook_id` text NOT NULL
- `received_at` timestamptz NOT NULL DEFAULT now()
- `processed_at` timestamptz
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending','processed','failed','skipped_duplicate')`
- `error_message` text
- `raw_payload` jsonb NOT NULL

## `spend_forecasts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `forecast_amount` numeric NOT NULL
- `actual_amount` numeric
- `confidence_pct` numeric
- `model_version` text
- `generated_at` timestamptz NOT NULL DEFAULT now()

## `style_fabric_codes`  _(P3-11)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `style_id` uuid → `style_master` NOT NULL
- `fabric_code_id` uuid → `fabric_codes` NOT NULL
- `role` text NOT NULL
- `yardage_per_unit` numeric(10,4)
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`

## `style_master`  _(P1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `style_code` text NOT NULL
- `aliases` text[] NOT NULL DEFAULT '{}' — old style codes captured on a renumber (mig `20260922000000`, GIN idx `idx_style_master_aliases`). Mirrors vendors/customers.aliases. Keeps string-grain lookups (Xoro importer `loadStyles`, prepack matrix) resolving a renamed style; UUID-keyed history (ip_item_master.style_id, *_lines.inventory_item_id, inventory_layers.item_id, ip_sales_history_wholesale.sku_id) needs no alias. Auto-appended by the style-master PATCH on a style_code change (which also cascades the new code to ip_item_master, keeping sku_code stable, and re-keys prepack_matrices).
- `description` text NOT NULL
- `category_id` uuid → `ip_category_master`
- `gender_code` text
- `season` text
- `design_year` smallint
- `is_apparel` boolean NOT NULL DEFAULT true
- `launch_date` date
- `lifecycle_status` text NOT NULL DEFAULT 'active'
- `planning_class` text
- `base_fabric` text
- `attributes` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `created_by_user_id` uuid → `auth.users`
- `deleted_at` timestamptz
- `style_name` text
- `search_doc` tsvector

## `supply_chain_finance_programs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `name` text NOT NULL
- `funder_name` text NOT NULL
- `max_facility_amount` numeric(14,2) NOT NULL CHECK `max_facility_amount >= 0`
- `current_utilization` numeric(14,2) NOT NULL DEFAULT 0 CHECK `current_utilization >= 0`
- `base_rate_pct` numeric(6,3) NOT NULL CHECK `base_rate_pct >= 0`
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'paused', 'terminated')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `sustainability_reports`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `reporting_period_start` date NOT NULL
- `reporting_period_end` date NOT NULL CHECK `reporting_period_end >= reporting_period_start`
- `scope1_emissions` numeric(14,3)
- `scope2_emissions` numeric(14,3)
- `scope3_emissions` numeric(14,3)
- `renewable_energy_pct` numeric(5,2) CHECK `renewable_energy_pct IS NULL OR (renewable_energy_pct >= 0 AND renewable_energy_pct <= 100)`
- `waste_diverted_pct` numeric(5,2) CHECK `waste_diverted_pct IS NULL OR (waste_diverted_pct >= 0 AND waste_diverted_pct <= 100)`
- `water_usage_liters` numeric(14,2)
- `certifications` text[] NOT NULL DEFAULT '{}'
- `report_file_url` text
- `submitted_at` timestamptz NOT NULL DEFAULT now()
- `reviewed_by` text
- `rejection_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tanda_milestone_change_requests`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `po_id` uuid → `tanda_pos` NOT NULL
- `po_number` text NOT NULL
- `phase_name` text NOT NULL
- `field_name` text NOT NULL
- `new_value` text
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending', 'approved', 'rejected')`
- `requested_at` timestamptz NOT NULL DEFAULT now()
- `requested_by_vendor_user_id` uuid → `vendor_users`
- `reviewed_at` timestamptz
- `reviewed_by_internal_id` text
- `review_note` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `po_line_key` text

## `tanda_milestones`  _((pre-P))_

- `id` text PK
- `data` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tanda_po_qc_findings`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `inspection_id` uuid → `tanda_po_qc_inspections` NOT NULL
- `category` text NOT NULL
- `severity` text NOT NULL CHECK `severity IN ('minor','major','critical')`
- `qty_affected` int NOT NULL DEFAULT 0
- `description` text NOT NULL
- `photo_urls` text[]
- `resolution` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `tanda_po_qc_inspections`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `receipt_id` uuid → `tanda_po_receipts` NOT NULL
- `inspection_date` date NOT NULL
- `inspector_employee_id` uuid → `employees`
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending','passed','failed','partial')`
- `overall_pass_rate` numeric(5,4)
- `notes` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `tanda_po_receipt_lines`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `receipt_id` uuid → `tanda_po_receipts` NOT NULL
- `po_line_item_id` uuid → `po_line_items` NOT NULL
- `qty_received` int NOT NULL CHECK `qty_received > 0`
- `qty_accepted` int NOT NULL CHECK `qty_accepted >= 0`
- `qty_rejected` int NOT NULL DEFAULT 0
- `unit_cost_cents` bigint NOT NULL CHECK `unit_cost_cents >= 0`
- `landed_unit_cost_cents` bigint
- `inventory_location_id` uuid → `inventory_locations`
- `inventory_layer_id` uuid → `inventory_layers`
- `raw_payload` jsonb

## `tanda_po_receipt_rollups`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `receipt_id` uuid → `tanda_po_receipts` NOT NULL
- `expense_gl_account_id` uuid → `gl_accounts` NOT NULL
- `amount_cents` bigint NOT NULL CHECK `amount_cents > 0`
- `vendor_id` uuid → `vendors`
- `description` text NOT NULL
- `capitalized_to_inventory` boolean NOT NULL DEFAULT true
- `auto_invoice_id` uuid → `invoices`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `tanda_po_receipts`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `tanda_po_id` uuid → `tanda_pos` NOT NULL
- `receipt_date` date NOT NULL
- `received_by_employee_id` uuid → `employees`
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft','pending_approval','approved','posted')`
- `landed_cost_cents` bigint NOT NULL DEFAULT 0
- `notes` text
- `je_id` uuid → `journal_entries`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tanda_pos`  _((pre-P) (alter only))_

- `vendor_id` uuid → `vendors`
- `buyer_po` text
- `buyer_name` text
- `date_expected_delivery` text
- `uuid_id` uuid DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities`
- `search_doc` tsvector
- `originated_by_employee_id` uuid → `employees`
- `procurement_status` text
- `expected_landed_cost_cents` bigint
- `actual_landed_cost_cents` bigint
- `pilot_vendor_flag` boolean NOT NULL DEFAULT false

## `tasks`  _((pre-P))_

- `id` text PK
- `data` jsonb NOT NULL DEFAULT '{}'::jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tax_calculations`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `invoice_id` uuid → `invoices` NOT NULL
- `jurisdiction` text NOT NULL
- `tax_type` text NOT NULL CHECK `tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')`
- `taxable_amount` numeric(14,2) NOT NULL CHECK `taxable_amount >= 0`
- `tax_rate_pct` numeric(6,3) NOT NULL CHECK `tax_rate_pct >= 0 AND tax_rate_pct <= 100`
- `tax_amount` numeric(14,2) NOT NULL CHECK `tax_amount >= 0`
- `rule_id` uuid → `tax_rules`
- `calculated_at` timestamptz NOT NULL DEFAULT now()

## `tax_remittances`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `jurisdiction` text NOT NULL
- `tax_type` text NOT NULL CHECK `tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')`
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `total_taxable_amount` numeric(14,2) NOT NULL DEFAULT 0 CHECK `total_taxable_amount >= 0`
- `total_tax_amount` numeric(14,2) NOT NULL DEFAULT 0 CHECK `total_tax_amount >= 0`
- `status` text NOT NULL DEFAULT 'draft' CHECK `status IN ('draft', 'filed', 'paid')`
- `filed_at` timestamptz
- `payment_reference` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tax_rules`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `jurisdiction` text NOT NULL
- `tax_type` text NOT NULL CHECK `tax_type IN ('vat', 'gst', 'sales_tax', 'withholding')`
- `rate_pct` numeric(6,3) NOT NULL CHECK `rate_pct >= 0 AND rate_pct <= 100`
- `applies_to` text NOT NULL DEFAULT 'all' CHECK `applies_to IN ('goods', 'services', 'all')`
- `threshold_amount` numeric(14,2)
- `vendor_type_exemptions` text[] NOT NULL DEFAULT '{}'
- `is_active` boolean NOT NULL DEFAULT true
- `effective_from` date NOT NULL
- `effective_to` date
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `tech_packs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `concept_id` uuid → `ip_design_concepts`
- `version` integer NOT NULL DEFAULT 1
- `status` text NOT NULL DEFAULT 'ai_drafted' CHECK `status IN ('ai_drafted', 'human_editing', 'human_approved', 'archived')`
- `payload` jsonb NOT NULL
- `generated_by` text
- `internal` user id for hand-edits model text
- `token_usage` jsonb
- `human_approved_at` timestamptz
- `human_approved_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `upc_item_master`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `upc` text NOT NULL
- `style_no` text NOT NULL
- `color` text NOT NULL
- `size` text NOT NULL
- `description` text
- `source_method` text NOT NULL DEFAULT 'excel'
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `sku_id` uuid → `ip_item_master`

## `user_menu_usage`  _((pre-P))_

- `user_id` uuid → `auth.users` NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `menu_key` text NOT NULL

## `user_preferences`  _((pre-P))_

- `user_id` uuid → `auth.users` NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `key` text NOT NULL

## `vendor_api_keys`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `name` text NOT NULL
- `key_hash` text NOT NULL
- `key_prefix` text NOT NULL
- `last_used_at` timestamptz
- `expires_at` timestamptz
- `scopes` text[] NOT NULL DEFAULT '{}'
- `created_by` uuid → `vendor_users`
- `revoked_at` timestamptz
- `revoked_by` uuid → `vendor_users`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `vendor_api_logs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `api_key_id` uuid → `vendor_api_keys` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `endpoint` text NOT NULL
- `method` text NOT NULL
- `status_code` integer
- `ip_address` text
- `request_id` text
- `duration_ms` integer
- `error_message` text
- `created_at` timestamptz NOT NULL DEFAULT now()

## `vendor_compliance_certifications`  _(P13-1)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `vendor_id` uuid → `vendors` NOT NULL
- `certification_type` text NOT NULL
- `cert_number` text
- `issued_at` date
- `expires_at` date
- `document_url` text
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active','expired','revoked','pending')`
- `created_at` timestamptz NOT NULL DEFAULT now()

## `vendor_flags`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `type` text NOT NULL CHECK `type IN ('performance', 'compliance', 'financial_risk', 'other')`
- `severity` text NOT NULL DEFAULT 'medium' CHECK `severity IN ('low', 'medium', 'high', 'critical')`
- `reason` text NOT NULL
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'acknowledged', 'resolved')`
- `raised_by` text
- `resolved_by` text
- `resolved_at` timestamptz
- `resolution_notes` text
- `source` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `vendor_health_scores`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `overall_score` numeric NOT NULL
- `delivery_score` numeric
- `quality_score` numeric
- `compliance_score` numeric
- `financial_score` numeric
- `responsiveness_score` numeric
- `score_breakdown` jsonb
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `generated_at` timestamptz NOT NULL DEFAULT now()

## `vendor_invoice_drafts`  _(P13-2)_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT coalesce(current_entity_id(), rof_entity_id())
- `vendor_id` uuid → `vendors` NOT NULL
- `vendor_invoice_number` text NOT NULL
- `invoice_date` date NOT NULL
- `due_date` date
- `currency` char(3) NOT NULL DEFAULT 'USD'
- `total_cents` bigint NOT NULL
- `source_kind` text NOT NULL CHECK `source_kind IN ('vendor_portal_upload','ap_inbox_pdf','manual','edi_810')`
- `source_pdf_document_id` uuid
- `ocr_extracted_payload` jsonb
- `ocr_confidence_pct` numeric(5,2)
- `three_way_match_status` text NOT NULL DEFAULT 'pending' CHECK `three_way_match_status IN ('pending','matched','variance','exception','posted','rejected')`
- `matched_po_ids` uuid[] NOT NULL DEFAULT '{}'
- `matched_receipt_ids` uuid[] NOT NULL DEFAULT '{}'
- `variance_cents` bigint NOT NULL DEFAULT 0
- `variance_reason` text
- `ap_invoice_id` uuid → `invoices`
- `approved_by_user_id` uuid → `auth.users`
- `approved_at` timestamptz
- `rejected_reason` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `vendor_notes`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `body` text NOT NULL
- `is_pinned` boolean NOT NULL DEFAULT false
- `created_by` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `vendor_payment_preferences`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `preferred_currency` text NOT NULL DEFAULT 'USD' CHECK `char_length(preferred_currency) = 3`
- `preferred_payment_method` text NOT NULL DEFAULT 'ach' CHECK `preferred_payment_method IN ('ach', 'wire', 'virtual_card', 'check', 'paypal', 'wise')`
- `fx_handling` text NOT NULL DEFAULT 'pay_in_usd_vendor_absorbs' CHECK `fx_handling IN ('pay_in_vendor_currency', 'pay_in_usd_vendor_absorbs', 'pay_in_usd_we_absorb')`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `vendor_phase_permissions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `phase_name` text NOT NULL
- `can_edit` boolean NOT NULL DEFAULT false
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `updated_by` text

## `vendor_scorecards`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `vendor_id` uuid → `vendors` NOT NULL
- `period_start` date NOT NULL
- `period_end` date NOT NULL
- `on_time_delivery_pct` numeric(5, 2)
- `invoice_accuracy_pct` numeric(5, 2)
- `avg_acknowledgment_hours` numeric(8, 2)
- `po_count` integer NOT NULL DEFAULT 0
- `invoice_count` integer NOT NULL DEFAULT 0
- `discrepancy_count` integer NOT NULL DEFAULT 0
- `composite_score` numeric(5, 2)

## `vendor_users`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `auth_id` uuid → `auth.users` NOT NULL
- `vendor_id` uuid → `vendors` NOT NULL
- `display_name` text
- `role` text NOT NULL DEFAULT 'primary'
- `last_login` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()

## `vendors`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `legacy_blob_id` text
- `country` text
- `transit_days` integer
- `categories` text[] DEFAULT '{}'
- `contact` text
- `email` text
- `moq` integer
- `lead_overrides` jsonb DEFAULT '{}'::jsonb
- `wip_lead_overrides` jsonb DEFAULT '{}'::jsonb
- `aliases` text[] DEFAULT '{}'
- `updated_at` timestamptz NOT NULL DEFAULT now()
- `status` text NOT NULL DEFAULT 'active' CHECK `IN ('active', 'on_hold', 'inactive')`
- `payment_terms` text
- `tax_id` text
- `is_tax_vendor` boolean NOT NULL DEFAULT false
- `default_payment_terms` text
- `code` text
- `legal_name` text
- `default_currency` char(3) NOT NULL DEFAULT 'USD'
- `default_gl_ap_account_id` uuid → `gl_accounts`
- `default_gl_expense_account_id` uuid → `gl_accounts`
- `is_1099_vendor` boolean NOT NULL DEFAULT false
- `address` jsonb NOT NULL DEFAULT '{}'::jsonb
- `bank_account_encrypted` bytea
- `created_by_user_id` uuid → `auth.users`
- `updated_by_user_id` uuid → `auth.users`
- `payment_terms_id` uuid → `payment_terms`
- `search_doc` tsvector
- `qc_required` boolean NOT NULL DEFAULT true
- `qc_pass_count_12mo` int NOT NULL DEFAULT 0
- `landed_cost_allocation_method` text NOT NULL DEFAULT 'value' CHECK `IN ('value','weight','cbm')`
- `parallel_run_complete` boolean NOT NULL DEFAULT false
- `parallel_run_started_at` timestamptz
- `pilot_vendor` boolean NOT NULL DEFAULT false
- `requires_compliance_certs` boolean NOT NULL DEFAULT false

## `virtual_cards`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `invoice_id` uuid → `invoices`
- `vendor_id` uuid → `vendors` NOT NULL
- `card_number_last4` text NOT NULL CHECK `char_length(card_number_last4) = 4`
- `card_number_encrypted` bytea NOT NULL
- `cvv_encrypted` bytea NOT NULL
- `expiry_month` integer NOT NULL CHECK `expiry_month BETWEEN 1 AND 12`
- `expiry_year` integer NOT NULL CHECK `expiry_year BETWEEN 2026 AND 2099`
- `credit_limit` numeric(14,2) NOT NULL CHECK `credit_limit > 0`
- `amount_authorized` numeric(14,2) NOT NULL DEFAULT 0 CHECK `amount_authorized >= 0`
- `amount_spent` numeric(14,2) NOT NULL DEFAULT 0 CHECK `amount_spent >= 0`
- `status` text NOT NULL DEFAULT 'active' CHECK `status IN ('active', 'spent', 'cancelled', 'expired')`
- `provider` text NOT NULL CHECK `provider IN ('stripe', 'marqeta', 'railsbank')`
- `provider_card_id` text
- `issued_at` timestamptz NOT NULL DEFAULT now()
- `expires_at` timestamptz NOT NULL
- `spent_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `walmart_order_items`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `walmart_order_id` uuid → `walmart_orders` NOT NULL
- `line_number` int NOT NULL
- `item_sku` text
- `product_name` text
- `ip_item_master_id` uuid → `ip_item_master`
- `quantity` int
- `unit_price_cents` bigint
- `line_total_cents` bigint
- `tax_cents` bigint NOT NULL DEFAULT 0
- `commission_cents` bigint NOT NULL DEFAULT 0
- `wfs_fulfillment_fee_cents` bigint NOT NULL DEFAULT 0
- `raw_payload` jsonb

## `walmart_orders`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `walmart_seller_account_id` uuid → `walmart_seller_accounts` NOT NULL
- `purchase_order_id` text NOT NULL
- `order_status` text
- `order_total_cents` bigint
- `item_subtotal_cents` bigint NOT NULL DEFAULT 0
- `tax_collected_cents` bigint NOT NULL DEFAULT 0
- `shipping_cents` bigint NOT NULL DEFAULT 0
- `discount_cents` bigint NOT NULL DEFAULT 0
- `customer_id` uuid → `customers`
- `ar_invoice_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb
- `source` text NOT NULL DEFAULT 'walmart' CHECK `source = 'walmart'`
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `walmart_returns`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `walmart_order_id` uuid → `walmart_orders`
- `customer_order_id` text
- `return_order_id` text NOT NULL
- `item_sku` text
- `ip_item_master_id` uuid → `ip_item_master`
- `quantity` int
- `reason` text
- `return_status` text
- `refund_amount_cents` bigint NOT NULL DEFAULT 0
- `restocking_fee_cents` bigint NOT NULL DEFAULT 0
- `ar_credit_memo_id` uuid → `ar_invoices`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `walmart_seller_accounts`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `partner_id` text NOT NULL
- `key` = WALMART_TOKEN_ENC_KEY client_id_iv bytea
- `client_id_tag` bytea
- `client_secret_ciphertext` bytea
- `client_secret_iv` bytea
- `client_secret_tag` bytea
- `wfs_location_id` uuid → `inventory_locations`
- `is_active` boolean NOT NULL DEFAULT true
- `last_orders_sync_at` timestamptz
- `last_settlement_sync_at` timestamptz
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `walmart_settlements`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL DEFAULT rof_entity_id()
- `walmart_seller_account_id` uuid → `walmart_seller_accounts` NOT NULL
- `settlement_id` text NOT NULL
- `period_start` date
- `period_end` date
- `gross_amount_cents` bigint
- `fees_amount_cents` bigint
- `refunds_amount_cents` bigint
- `net_amount_cents` bigint
- `currency` text NOT NULL DEFAULT 'USD'
- `bank_transaction_id` uuid → `bank_transactions`
- `je_id` uuid → `journal_entries`
- `raw_payload` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `workflow_executions`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `rule_id` uuid → `workflow_rules` NOT NULL
- `entity_id` uuid → `entities` NOT NULL
- `trigger_entity_type` text NOT NULL
- `trigger_entity_id` uuid
- `status` text NOT NULL DEFAULT 'pending' CHECK `status IN ('pending', 'approved', 'rejected', 'auto_approved', 'skipped')`
- `current_approver` text
- `approved_by` text
- `rejected_by` text
- `rejection_reason` text
- `triggered_at` timestamptz NOT NULL DEFAULT now()
- `resolved_at` timestamptz
- `metadata` jsonb
- `created_at` timestamptz NOT NULL DEFAULT now()

## `workflow_rules`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `name` text NOT NULL
- `trigger_event` text NOT NULL CHECK `trigger_event IN ('po_issued', 'invoice_submitted', 'shipment_created', 'compliance_expired', 'dispute_opened', 'anomaly_detected')`
- `conditions` jsonb NOT NULL DEFAULT '[]'::jsonb
- `actions` jsonb NOT NULL DEFAULT '[]'::jsonb
- `is_active` boolean NOT NULL DEFAULT true
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `workspace_pins`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `workspace_id` uuid → `collaboration_workspaces` NOT NULL
- `entity_type` text NOT NULL CHECK `entity_type IN ('po', 'invoice', 'contract', 'rfq', 'document')`
- `entity_ref_id` uuid NOT NULL
- `pinned_by` text NOT NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

## `workspace_tasks`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `workspace_id` uuid → `collaboration_workspaces` NOT NULL
- `title` text NOT NULL
- `description` text
- `assigned_to_type` text CHECK `assigned_to_type IN ('vendor', 'internal')`
- `assigned_to` text
- `due_date` date
- `status` text NOT NULL DEFAULT 'open' CHECK `status IN ('open', 'in_progress', 'complete', 'cancelled')`
- `completed_at` timestamptz
- `created_by_type` text CHECK `created_by_type IN ('vendor', 'internal')`
- `created_by` text
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

## `xoro_mirror_runs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `entity_id` uuid → `entities` NOT NULL
- `domain` text NOT NULL CHECK `domain IN ('ar','ap','inventory','summary_je')`
- `mirror_date` date NOT NULL
- `rows_upserted` int NOT NULL DEFAULT 0
- `rows_deleted` int NOT NULL DEFAULT 0
- `rows_unchanged` int NOT NULL DEFAULT 0
- `je_id` uuid → `journal_entries`
- `errors` jsonb NOT NULL DEFAULT '[]'::jsonb
- `started_at` timestamptz NOT NULL DEFAULT now()
- `completed_at` timestamptz
- `status` text NOT NULL DEFAULT 'running' CHECK `status IN ('running','complete','failed','skipped_no_change','skipped_stale_xoro')`

## `xoro_sync_logs`  _((pre-P))_

- `id` uuid PK DEFAULT gen_random_uuid()
- `sync_type` text NOT NULL
- `status` text NOT NULL DEFAULT 'running' CHECK `status IN ('running', 'complete', 'error')`
- `started_at` timestamptz NOT NULL DEFAULT now()
- `completed_at` timestamptz
- `records_processed` integer NOT NULL DEFAULT 0
- `records_inserted` integer NOT NULL DEFAULT 0
- `records_updated` integer NOT NULL DEFAULT 0
- `error_message` text
- `raw_summary` jsonb

