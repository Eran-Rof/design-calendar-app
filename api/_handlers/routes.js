// AUTO-GENERATED from routes.manifest.js by scripts/gen-routes.mjs.
// DO NOT EDIT BY HAND — edit routes.manifest.js, then `npm run gen:routes`.
// (CI runs `gen:routes --check` and fails if this file is stale.)
//
// Single api/dispatch.js function imports every handler statically here
// so Vercel bundles them all behind one serverless function.

import r_cron_bank_auto_post_fees from "../cron/bank-auto-post-fees.js";
import r_cron_bank_feed_sync from "../cron/bank-feed-sync.js";
import r_cron_crm_tasks_due_tomorrow from "../cron/crm-tasks-due-tomorrow.js";
import r_cron_faire_orders_nightly from "../cron/faire-orders-nightly.js";
import r_cron_faire_payouts_monthly from "../cron/faire-payouts-monthly.js";
import r_cron_faire_returns_weekly from "../cron/faire-returns-weekly.js";
import r_cron_fba_inventory_daily from "../cron/fba-inventory-daily.js";
import r_cron_fba_orders_nightly from "../cron/fba-orders-nightly.js";
import r_cron_fba_returns_daily from "../cron/fba-returns-daily.js";
import r_cron_fba_settlements_weekly from "../cron/fba-settlements-weekly.js";
import r_cron_menu_usage_decay from "../cron/menu-usage-decay.js";
import r_cron_shopify_backfill from "../cron/shopify-backfill.js";
import r_cron_shopify_payouts_daily from "../cron/shopify-payouts-daily.js";
import r_cron_shopify_refunds_backfill from "../cron/shopify-refunds-backfill.js";
import r_cron_walmart_orders_nightly from "../cron/walmart-orders-nightly.js";
import r_cron_walmart_returns_daily from "../cron/walmart-returns-daily.js";
import r_cron_walmart_settlements_weekly from "../cron/walmart-settlements-weekly.js";
import r_cron_xoro_mirror_backfill_worker from "../cron/xoro-mirror-backfill-worker.js";
import r_cron_xoro_mirror_nightly from "../cron/xoro-mirror-nightly.js";
import r_webhooks_plaid from "../webhooks/plaid.js";
import r_ai_ask_grid from "./ai/ask-grid.js";
import r_ap_sync_bills from "./ap/sync-bills.js";
import r_ats_supply_sync from "./ats-supply-sync.js";
import r_ats_upload from "./ats/upload.js";
import r_b2b_account from "./b2b/account.js";
import r_b2b_catalog from "./b2b/catalog.js";
import r_b2b_orders_id from "./b2b/orders/[id].js";
import r_b2b_orders_index from "./b2b/orders/index.js";
import r_b2b_session from "./b2b/session.js";
import r_cron_ai_proactive_insights from "./cron/ai-proactive-insights.js";
import r_cron_anomalies_nightly from "./cron/anomalies-nightly.js";
import r_cron_ap_paid_delta_watcher from "./cron/ap-paid-delta-watcher.js";
import r_cron_app_errors_digest from "./cron/app-errors-digest.js";
import r_cron_ar_payload_ingest from "./cron/ar-payload-ingest.js";
import r_cron_ar_receipts_reconcile from "./cron/ar-receipts-reconcile.js";
import r_cron_bank_mirror_sync from "./cron/bank-mirror-sync.js";
import r_cron_benchmark_compute from "./cron/benchmark-compute.js";
import r_cron_compliance_automation from "./cron/compliance-automation.js";
import r_cron_compliance_daily from "./cron/compliance-daily.js";
import r_cron_contracts_daily from "./cron/contracts-daily.js";
import r_cron_customer_contact_reminders from "./cron/customer-contact-reminders.js";
import r_cron_discount_offers_daily from "./cron/discount-offers-daily.js";
import r_cron_early_payment_analytics from "./cron/early-payment-analytics.js";
import r_cron_edi_3pl_transport from "./cron/edi-3pl-transport.js";
import r_cron_fx_rate_sync from "./cron/fx-rate-sync.js";
import r_cron_health_scores_monthly from "./cron/health-scores-monthly.js";
import r_cron_insights_digest_daily from "./cron/insights-digest-daily.js";
import r_cron_insights_weekly from "./cron/insights-weekly.js";
import r_cron_inventory_cost_backfill from "./cron/inventory-cost-backfill.js";
import r_cron_inventory_onhand_check from "./cron/inventory-onhand-check.js";
import r_cron_ip_freshness_refresh from "./cron/ip-freshness-refresh.js";
import r_cron_ip_integration_health from "./cron/ip-integration-health.js";
import r_cron_ip_normalize from "./cron/ip-normalize.js";
import r_cron_notification_digest_flush from "./cron/notification-digest-flush.js";
import r_cron_po_issued_notify from "./cron/po-issued-notify.js";
import r_cron_push_delivery from "./cron/push-delivery.js";
import r_cron_scorecards_monthly from "./cron/scorecards-monthly.js";
import r_cron_subledger_tieout from "./cron/subledger-tieout.js";
import r_cron_three_way_match from "./cron/three-way-match.js";
import r_cron_tpl_inventory_pull from "./cron/tpl-inventory-pull.js";
import r_cron_workspace_tasks_due_soon from "./cron/workspace-tasks-due-soon.js";
import r_cron_xoro_feed_health_alert from "./cron/xoro-feed-health-alert.js";
import r_dropbox_proxy from "./dropbox-proxy.js";
import r_edi_inbound_vendor_id from "./edi/inbound/[vendor_id].js";
import r_edi_inbound_index from "./edi/inbound/index.js";
import r_edi_outbound_payment from "./edi/outbound/payment.js";
import r_edi_outbound_po from "./edi/outbound/po.js";
import r_external_v1_inventory from "./external/v1/inventory.js";
import r_external_v1_invoices from "./external/v1/invoices.js";
import r_external_v1_orders from "./external/v1/orders.js";
import r_external_v1_ping from "./external/v1/ping.js";
import r_external_v1_styles from "./external/v1/styles.js";
import r_internal_addresses_postal_suggest from "./internal/addresses/postal-suggest.js";
import r_internal_adjustment_reasons_id from "./internal/adjustment-reasons/[id].js";
import r_internal_adjustment_reasons_index from "./internal/adjustment-reasons/index.js";
import r_internal_adjustment_types_id from "./internal/adjustment-types/[id].js";
import r_internal_adjustment_types_index from "./internal/adjustment-types/index.js";
import r_internal_ai_documents from "./internal/ai/documents.js";
import r_internal_ai_insights from "./internal/ai/insights.js";
import r_internal_ai_mention_suggest from "./internal/ai/mention-suggest.js";
import r_internal_ai_ops_summary from "./internal/ai/ops-summary.js";
import r_internal_ai_suggest_iso2 from "./internal/ai/suggest-iso2.js";
import r_internal_ai_user_facts from "./internal/ai/user-facts.js";
import r_internal_allocations_index from "./internal/allocations/index.js";
import r_internal_allocations_preview from "./internal/allocations/preview.js";
import r_internal_allocations_rules from "./internal/allocations/rules.js";
import r_internal_analytics_categories from "./internal/analytics/categories.js";
import r_internal_analytics_diversity_spend from "./internal/analytics/diversity-spend.js";
import r_internal_analytics_early_payment from "./internal/analytics/early-payment.js";
import r_internal_analytics_financial from "./internal/analytics/financial.js";
import r_internal_analytics_forecast from "./internal/analytics/forecast.js";
import r_internal_analytics_fx from "./internal/analytics/fx.js";
import r_internal_analytics_health_scores from "./internal/analytics/health-scores.js";
import r_internal_analytics_spend from "./internal/analytics/spend.js";
import r_internal_analytics_sustainability_trend from "./internal/analytics/sustainability-trend.js";
import r_internal_anomalies_id from "./internal/anomalies/[id].js";
import r_internal_anomalies_index from "./internal/anomalies/index.js";
import r_internal_ap_aging_detail from "./internal/ap-aging/detail.js";
import r_internal_ap_aging_index from "./internal/ap-aging/index.js";
import r_internal_ap_backfill_run from "./internal/ap-backfill/run.js";
import r_internal_ap_invoices_id from "./internal/ap-invoices/[id].js";
import r_internal_ap_invoices_index from "./internal/ap-invoices/index.js";
import r_internal_ap_invoices_pay from "./internal/ap-invoices/pay.js";
import r_internal_ap_invoices_post from "./internal/ap-invoices/post.js";
import r_internal_ap_invoices_void from "./internal/ap-invoices/void.js";
import r_internal_ap_payments_index from "./internal/ap-payments/index.js";
import r_internal_api_keys_id from "./internal/api-keys/[id].js";
import r_internal_api_keys_index from "./internal/api-keys/index.js";
import r_internal_approval_requests_id from "./internal/approval-requests/[id].js";
import r_internal_approval_requests_cancel from "./internal/approval-requests/cancel.js";
import r_internal_approval_requests_decide from "./internal/approval-requests/decide.js";
import r_internal_approval_requests_index from "./internal/approval-requests/index.js";
import r_internal_approval_rules_id from "./internal/approval-rules/[id].js";
import r_internal_approval_rules_index from "./internal/approval-rules/index.js";
import r_internal_ar_aging_detail from "./internal/ar-aging/detail.js";
import r_internal_ar_aging_index from "./internal/ar-aging/index.js";
import r_internal_ar_backfill_run from "./internal/ar-backfill/run.js";
import r_internal_ar_backfill_status from "./internal/ar-backfill/status.js";
import r_internal_ar_collections_activities from "./internal/ar-collections/activities.js";
import r_internal_ar_collections_index from "./internal/ar-collections/index.js";
import r_internal_ar_collections_promises from "./internal/ar-collections/promises.js";
import r_internal_ar_collections_summary from "./internal/ar-collections/summary.js";
import r_internal_ar_invoices_id from "./internal/ar-invoices/[id].js";
import r_internal_ar_invoices_index from "./internal/ar-invoices/index.js";
import r_internal_ar_invoices_post from "./internal/ar-invoices/post.js";
import r_internal_ar_invoices_void from "./internal/ar-invoices/void.js";
import r_internal_ar_receipt_applications_id from "./internal/ar-receipt-applications/[id].js";
import r_internal_ar_receipts_id from "./internal/ar-receipts/[id].js";
import r_internal_ar_receipts_index from "./internal/ar-receipts/index.js";
import r_internal_ar_receipts_post from "./internal/ar-receipts/post.js";
import r_internal_ar_receipts_void from "./internal/ar-receipts/void.js";
import r_internal_assistant_actions_confirm from "./internal/assistant/actions-confirm.js";
import r_internal_assistant_brief from "./internal/assistant/brief.js";
import r_internal_assistant_dismiss from "./internal/assistant/dismiss.js";
import r_internal_assistant_today from "./internal/assistant/today.js";
import r_internal_ats_by_size from "./internal/ats-by-size.js";
import r_internal_ats_size_matrix from "./internal/ats-size-matrix.js";
import r_internal_audit_log from "./internal/audit/log.js";
import r_internal_audit_row_history from "./internal/audit/row-history.js";
import r_internal_auth_provision from "./internal/auth/provision.js";
import r_internal_auth_signout from "./internal/auth/signout.js";
import r_internal_b2b_accounts_id from "./internal/b2b-accounts/[id].js";
import r_internal_b2b_accounts_index from "./internal/b2b-accounts/index.js";
import r_internal_b2b_price_list_id from "./internal/b2b-price-list/[id].js";
import r_internal_b2b_price_list_index from "./internal/b2b-price-list/index.js";
import r_internal_balance_sheet_index from "./internal/balance-sheet/index.js";
import r_internal_bank_accounts_id from "./internal/bank-accounts/[id].js";
import r_internal_bank_accounts_index from "./internal/bank-accounts/index.js";
import r_internal_bank_feeds_csv_upload from "./internal/bank-feeds/csv-upload.js";
import r_internal_bank_feeds_exchange from "./internal/bank-feeds/exchange.js";
import r_internal_bank_feeds_link_token from "./internal/bank-feeds/link-token.js";
import r_internal_bank_recon_runs_id from "./internal/bank-recon-runs/[id].js";
import r_internal_bank_recon_runs_compute from "./internal/bank-recon-runs/compute.js";
import r_internal_bank_recon_runs_index from "./internal/bank-recon-runs/index.js";
import r_internal_bank_transactions_apply_match from "./internal/bank-transactions/apply-match.js";
import r_internal_bank_transactions_create_je from "./internal/bank-transactions/create-je.js";
import r_internal_bank_transactions_ignore from "./internal/bank-transactions/ignore.js";
import r_internal_bank_transactions_index from "./internal/bank-transactions/index.js";
import r_internal_bank_transactions_match_candidates from "./internal/bank-transactions/match-candidates.js";
import r_internal_bank_transactions_unmatch from "./internal/bank-transactions/unmatch.js";
import r_internal_brands_index from "./internal/brands/index.js";
import r_internal_budget_range_index from "./internal/budget-range/index.js";
import r_internal_budgets_index from "./internal/budgets/index.js";
import r_internal_build_orders_id from "./internal/build-orders/[id].js";
import r_internal_build_orders_cancel from "./internal/build-orders/cancel.js";
import r_internal_build_orders_cmt_invoice from "./internal/build-orders/cmt-invoice.js";
import r_internal_build_orders_complete from "./internal/build-orders/complete.js";
import r_internal_build_orders_conversion_po from "./internal/build-orders/conversion-po.js";
import r_internal_build_orders_index from "./internal/build-orders/index.js";
import r_internal_build_orders_issue from "./internal/build-orders/issue.js";
import r_internal_build_orders_release from "./internal/build-orders/release.js";
import r_internal_build_orders_reopen from "./internal/build-orders/reopen.js";
import r_internal_build_orders_service from "./internal/build-orders/service.js";
import r_internal_bulk_process from "./internal/bulk/process.js";
import r_internal_buyer_scope_master_id from "./internal/buyer-scope-master/[id].js";
import r_internal_buyer_scope_master_index from "./internal/buyer-scope-master/index.js";
import r_internal_carriers_id from "./internal/carriers/[id].js";
import r_internal_carriers_index from "./internal/carriers/index.js";
import r_internal_cases_id from "./internal/cases/[id].js";
import r_internal_cases_id_comments from "./internal/cases/[id]/comments.js";
import r_internal_cases_index from "./internal/cases/index.js";
import r_internal_cash_flow_index from "./internal/cash-flow/index.js";
import r_internal_categories_index from "./internal/categories/index.js";
import r_internal_channels_index from "./internal/channels/index.js";
import r_internal_chargebacks_id from "./internal/chargebacks/[id].js";
import r_internal_chargebacks_id_origin from "./internal/chargebacks/[id]/origin.js";
import r_internal_chargebacks_bulk from "./internal/chargebacks/bulk.js";
import r_internal_chargebacks_dilution_summary from "./internal/chargebacks/dilution-summary.js";
import r_internal_chargebacks_drill from "./internal/chargebacks/drill.js";
import r_internal_chargebacks_index from "./internal/chargebacks/index.js";
import r_internal_client_errors from "./internal/client-errors.js";
import r_internal_colors_id from "./internal/colors/[id].js";
import r_internal_colors_index from "./internal/colors/index.js";
import r_internal_colors_nrf_suggest from "./internal/colors/nrf-suggest.js";
import r_internal_commissions_accruals from "./internal/commissions/accruals.js";
import r_internal_commissions_accrue from "./internal/commissions/accrue.js";
import r_internal_commissions_payouts from "./internal/commissions/payouts.js";
import r_internal_commissions_reverse from "./internal/commissions/reverse.js";
import r_internal_commissions_settle from "./internal/commissions/settle.js";
import r_internal_compliance_id_review from "./internal/compliance/[id]/review.js";
import r_internal_compliance_audit_trail from "./internal/compliance/audit-trail.js";
import r_internal_compliance_automation_report from "./internal/compliance/automation-report.js";
import r_internal_compliance_automation_rules_id from "./internal/compliance/automation-rules/[id].js";
import r_internal_compliance_automation_rules_index from "./internal/compliance/automation-rules/index.js";
import r_internal_compliance_document_types from "./internal/compliance/document-types.js";
import r_internal_compliance_index from "./internal/compliance/index.js";
import r_internal_consolidation_balance_sheet from "./internal/consolidation/balance-sheet.js";
import r_internal_consolidation_eliminations from "./internal/consolidation/eliminations.js";
import r_internal_consolidation_groups from "./internal/consolidation/groups.js";
import r_internal_consolidation_income_statement from "./internal/consolidation/income-statement.js";
import r_internal_consolidation_trial_balance from "./internal/consolidation/trial-balance.js";
import r_internal_contracts_id_index from "./internal/contracts/[id]/index.js";
import r_internal_contracts_id_versions from "./internal/contracts/[id]/versions.js";
import r_internal_contracts_index from "./internal/contracts/index.js";
import r_internal_costing_add_vendor from "./internal/costing/add-vendor.js";
import r_internal_costing_awarded_quotes from "./internal/costing/awarded-quotes.js";
import r_internal_costing_comp_ly from "./internal/costing/comp/ly.js";
import r_internal_costing_comp_t3 from "./internal/costing/comp/t3.js";
import r_internal_costing_lines_line_id_compliance_req_id from "./internal/costing/lines/[line_id]/compliance/[req_id].js";
import r_internal_costing_lines_line_id_compliance_index from "./internal/costing/lines/[line_id]/compliance/index.js";
import r_internal_costing_lines_line_id_index from "./internal/costing/lines/[line_id]/index.js";
import r_internal_costing_lines_line_id_po_history from "./internal/costing/lines/[line_id]/po-history.js";
import r_internal_costing_lines_line_id_quotes_quote_id from "./internal/costing/lines/[line_id]/quotes/[quote_id].js";
import r_internal_costing_lines_line_id_quotes_index from "./internal/costing/lines/[line_id]/quotes/index.js";
import r_internal_costing_lines_line_id_revise from "./internal/costing/lines/[line_id]/revise.js";
import r_internal_costing_lines_line_id_select_quote from "./internal/costing/lines/[line_id]/select-quote.js";
import r_internal_costing_lines_line_id_size_curve from "./internal/costing/lines/[line_id]/size-curve.js";
import r_internal_costing_lines_line_id_suggest from "./internal/costing/lines/[line_id]/suggest.js";
import r_internal_costing_masters_freeform from "./internal/costing/masters/freeform.js";
import r_internal_costing_projects_id_generate_rfqs from "./internal/costing/projects/[id]/generate-rfqs.js";
import r_internal_costing_projects_id_index from "./internal/costing/projects/[id]/index.js";
import r_internal_costing_projects_id_lines from "./internal/costing/projects/[id]/lines.js";
import r_internal_costing_projects_index from "./internal/costing/projects/index.js";
import r_internal_costing_rfq_compare_index from "./internal/costing/rfq-compare/index.js";
import r_internal_costing_rfq_compare_projects_index from "./internal/costing/rfq-compare/projects/index.js";
import r_internal_costing_rfqs_id_index from "./internal/costing/rfqs/[id]/index.js";
import r_internal_costing_rfqs_index from "./internal/costing/rfqs/index.js";
import r_internal_costing_search_categories from "./internal/costing/search/categories.js";
import r_internal_costing_search_colors from "./internal/costing/search/colors.js";
import r_internal_costing_search_customers from "./internal/costing/search/customers.js";
import r_internal_costing_search_fabrics from "./internal/costing/search/fabrics.js";
import r_internal_costing_search_sales_reps from "./internal/costing/search/sales-reps.js";
import r_internal_costing_search_scales from "./internal/costing/search/scales.js";
import r_internal_costing_search_styles from "./internal/costing/search/styles.js";
import r_internal_costing_search_vendors from "./internal/costing/search/vendors.js";
import r_internal_countries_id from "./internal/countries/[id].js";
import r_internal_countries_index from "./internal/countries/index.js";
import r_internal_crm_activities_id from "./internal/crm/activities/[id].js";
import r_internal_crm_activities_index from "./internal/crm/activities/index.js";
import r_internal_crm_opportunities_id from "./internal/crm/opportunities/[id].js";
import r_internal_crm_opportunities_id_stage from "./internal/crm/opportunities/[id]/stage.js";
import r_internal_crm_opportunities_index from "./internal/crm/opportunities/index.js";
import r_internal_crm_pipeline_report_index from "./internal/crm/pipeline-report/index.js";
import r_internal_crm_tasks_id from "./internal/crm/tasks/[id].js";
import r_internal_crm_tasks_index from "./internal/crm/tasks/index.js";
import r_internal_customer_buyers_id from "./internal/customer-buyers/[id].js";
import r_internal_customer_buyers_index from "./internal/customer-buyers/index.js";
import r_internal_customer_contact_notes_index from "./internal/customer-contact-notes/index.js";
import r_internal_customer_locations_id from "./internal/customer-locations/[id].js";
import r_internal_customer_locations_index from "./internal/customer-locations/index.js";
import r_internal_customer_master_id from "./internal/customer-master/[id].js";
import r_internal_customer_master_index from "./internal/customer-master/index.js";
import r_internal_customer_scorecard_index from "./internal/customer-scorecard/index.js";
import r_internal_data_freshness from "./internal/data-freshness.js";
import r_internal_date_presets_id from "./internal/date-presets/[id].js";
import r_internal_date_presets_index from "./internal/date-presets/index.js";
import r_internal_design_trend_brief_list from "./internal/design/trend-brief/list.js";
import r_internal_design_trend_brief_synthesize from "./internal/design/trend-brief/synthesize.js";
import r_internal_discount_offers_analytics from "./internal/discount-offers/analytics.js";
import r_internal_discount_offers_generate from "./internal/discount-offers/generate.js";
import r_internal_discount_offers_index from "./internal/discount-offers/index.js";
import r_internal_disputes_id_index from "./internal/disputes/[id]/index.js";
import r_internal_disputes_id_messages from "./internal/disputes/[id]/messages.js";
import r_internal_disputes_index from "./internal/disputes/index.js";
import r_internal_diversity_vendor_id_verify from "./internal/diversity/[vendor_id]/verify.js";
import r_internal_documents_archive from "./internal/documents/archive.js";
import r_internal_documents_index from "./internal/documents/index.js";
import r_internal_documents_signed_url from "./internal/documents/signed-url.js";
import r_internal_drop_ship_id from "./internal/drop-ship/[id].js";
import r_internal_drop_ship_index from "./internal/drop-ship/index.js";
import r_internal_edi_messages_id from "./internal/edi-messages/[id].js";
import r_internal_edi_messages_index from "./internal/edi-messages/index.js";
import r_internal_edi_partners_index from "./internal/edi-partners/index.js";
import r_internal_edi_vendor_id_messages from "./internal/edi/[vendor_id]/messages.js";
import r_internal_edi_vendor_id_send from "./internal/edi/[vendor_id]/send.js";
import r_internal_edi_customer_partners_id from "./internal/edi/customer-partners/[id].js";
import r_internal_edi_customer_partners_index from "./internal/edi/customer-partners/index.js";
import r_internal_edi_settings_index from "./internal/edi/settings/index.js";
import r_internal_edi_tpl_provider_id_inbound from "./internal/edi/tpl/[provider_id]/inbound.js";
import r_internal_edi_tpl_provider_id_inventory_advice from "./internal/edi/tpl/[provider_id]/inventory-advice.js";
import r_internal_edi_tpl_provider_id_receipt_advice from "./internal/edi/tpl/[provider_id]/receipt-advice.js";
import r_internal_employee_departments_id from "./internal/employee-departments/[id].js";
import r_internal_employee_departments_index from "./internal/employee-departments/index.js";
import r_internal_employee_titles_id from "./internal/employee-titles/[id].js";
import r_internal_employee_titles_index from "./internal/employee-titles/index.js";
import r_internal_employees_id from "./internal/employees/[id].js";
import r_internal_employees_index from "./internal/employees/index.js";
import r_internal_entities_id_branding from "./internal/entities/[id]/branding.js";
import r_internal_entities_id_coa_copy from "./internal/entities/[id]/coa-copy.js";
import r_internal_entities_id_vendors from "./internal/entities/[id]/vendors.js";
import r_internal_entities_index from "./internal/entities/index.js";
import r_internal_esg_scores_index from "./internal/esg-scores/index.js";
import r_internal_fabric_codes_id from "./internal/fabric-codes/[id].js";
import r_internal_fabric_codes_index from "./internal/fabric-codes/index.js";
import r_internal_fabric_mills_id from "./internal/fabric-mills/[id].js";
import r_internal_fabric_mills_index from "./internal/fabric-mills/index.js";
import r_internal_factor_chargebacks_id from "./internal/factor/chargebacks/[id].js";
import r_internal_factor_chargebacks_index from "./internal/factor/chargebacks/index.js";
import r_internal_factor_open_items from "./internal/factor/open-items.js";
import r_internal_factor_statements from "./internal/factor/statements.js";
import r_internal_factors_id from "./internal/factors/[id].js";
import r_internal_factors_index from "./internal/factors/index.js";
import r_internal_faire_post_order_id from "./internal/faire/post-order/[id].js";
import r_internal_faire_post_payout_id from "./internal/faire/post-payout/[id].js";
import r_internal_faire_sync_orders from "./internal/faire/sync-orders.js";
import r_internal_faire_sync_payouts from "./internal/faire/sync-payouts.js";
import r_internal_faire_sync_returns from "./internal/faire/sync-returns.js";
import r_internal_fba_mirror_inventory from "./internal/fba/mirror-inventory.js";
import r_internal_fba_post_order_id from "./internal/fba/post-order/[id].js";
import r_internal_fba_sync_orders from "./internal/fba/sync-orders.js";
import r_internal_fba_sync_returns from "./internal/fba/sync-returns.js";
import r_internal_fba_sync_settlements from "./internal/fba/sync-settlements.js";
import r_internal_finance_kpis_index from "./internal/finance-kpis/index.js";
import r_internal_fixed_assets_id from "./internal/fixed-assets/[id].js";
import r_internal_fixed_assets_generate_schedule from "./internal/fixed-assets/generate-schedule.js";
import r_internal_fixed_assets_index from "./internal/fixed-assets/index.js";
import r_internal_fixed_assets_post_depreciation from "./internal/fixed-assets/post-depreciation.js";
import r_internal_fixed_assets_tieout from "./internal/fixed-assets/tieout.js";
import r_internal_form_1099_index from "./internal/form-1099/index.js";
import r_internal_fx_rates from "./internal/fx/rates.js";
import r_internal_genders_id from "./internal/genders/[id].js";
import r_internal_genders_index from "./internal/genders/index.js";
import r_internal_gl_accounts_id from "./internal/gl-accounts/[id].js";
import r_internal_gl_accounts_id_brand_allocation from "./internal/gl-accounts/[id]/brand-allocation.js";
import r_internal_gl_accounts_index from "./internal/gl-accounts/index.js";
import r_internal_gl_detail_index from "./internal/gl-detail/index.js";
import r_internal_gl_periods_id from "./internal/gl-periods/[id].js";
import r_internal_gl_periods_close from "./internal/gl-periods/close.js";
import r_internal_gl_periods_index from "./internal/gl-periods/index.js";
import r_internal_gl_periods_preflight from "./internal/gl-periods/preflight.js";
import r_internal_gl_periods_reopen from "./internal/gl-periods/reopen.js";
import r_internal_global_search_index from "./internal/global-search/index.js";
import r_internal_hts_codes_id from "./internal/hts-codes/[id].js";
import r_internal_hts_codes_index from "./internal/hts-codes/index.js";
import r_internal_hts_backfill from "./internal/hts/backfill.js";
import r_internal_hts_suggest from "./internal/hts/suggest.js";
import r_internal_income_statement_monthly_index from "./internal/income-statement-monthly/index.js";
import r_internal_income_statement_index from "./internal/income-statement/index.js";
import r_internal_insights_id from "./internal/insights/[id].js";
import r_internal_insights_index from "./internal/insights/index.js";
import r_internal_insights_summary from "./internal/insights/summary.js";
import r_internal_inventory_accuracy_detail from "./internal/inventory-accuracy/detail.js";
import r_internal_inventory_accuracy_perpetual_movements from "./internal/inventory-accuracy/perpetual-movements.js";
import r_internal_inventory_accuracy_perpetual from "./internal/inventory-accuracy/perpetual.js";
import r_internal_inventory_accuracy_summary from "./internal/inventory-accuracy/summary.js";
import r_internal_inventory_adjustments_id from "./internal/inventory-adjustments/[id].js";
import r_internal_inventory_adjustments_index from "./internal/inventory-adjustments/index.js";
import r_internal_inventory_adjustments_post from "./internal/inventory-adjustments/post.js";
import r_internal_inventory_aging_filters from "./internal/inventory-aging/filters.js";
import r_internal_inventory_aging_layers from "./internal/inventory-aging/layers.js";
import r_internal_inventory_aging_report from "./internal/inventory-aging/report.js";
import r_internal_inventory_cycle_counts_id from "./internal/inventory-cycle-counts/[id].js";
import r_internal_inventory_cycle_counts_finalize from "./internal/inventory-cycle-counts/finalize.js";
import r_internal_inventory_cycle_counts_index from "./internal/inventory-cycle-counts/index.js";
import r_internal_inventory_cycle_counts_lines from "./internal/inventory-cycle-counts/lines.js";
import r_internal_inventory_purchased_detail from "./internal/inventory-purchased-detail.js";
import r_internal_inventory_snapshot from "./internal/inventory-snapshot.js";
import r_internal_inventory_sold_detail from "./internal/inventory-sold-detail.js";
import r_internal_inventory_transfers_id from "./internal/inventory-transfers/[id].js";
import r_internal_inventory_transfers_index from "./internal/inventory-transfers/index.js";
import r_internal_ip_ai_demand_index from "./internal/ip-ai-demand/index.js";
import r_internal_items_index from "./internal/items/index.js";
import r_internal_journal_entries_id from "./internal/journal-entries/[id].js";
import r_internal_journal_entries_id_source from "./internal/journal-entries/[id]/source.js";
import r_internal_journal_entries_index from "./internal/journal-entries/index.js";
import r_internal_journal_entries_reverse from "./internal/journal-entries/reverse.js";
import r_internal_marketplace_benchmark from "./internal/marketplace/benchmark.js";
import r_internal_marketplace_convert_to_rfq from "./internal/marketplace/convert-to-rfq.js";
import r_internal_marketplace_inquire from "./internal/marketplace/inquire.js";
import r_internal_marketplace_inquiries from "./internal/marketplace/inquiries.js";
import r_internal_messages_inbox from "./internal/messages/inbox.js";
import r_internal_messages_unread_count from "./internal/messages/unread-count.js";
import r_internal_mfg_boms_id from "./internal/mfg-boms/[id].js";
import r_internal_mfg_boms_index from "./internal/mfg-boms/index.js";
import r_internal_mfg_reports_index from "./internal/mfg-reports/index.js";
import r_internal_month_end_close_checklist from "./internal/month-end-close/checklist.js";
import r_internal_month_end_close_close from "./internal/month-end-close/close.js";
import r_internal_month_end_close_periods from "./internal/month-end-close/periods.js";
import r_internal_month_end_close_reopen from "./internal/month-end-close/reopen.js";
import r_internal_month_end_close_run_checks from "./internal/month-end-close/run-checks.js";
import r_internal_month_end_close_sign_off from "./internal/month-end-close/sign-off.js";
import r_internal_notification_preferences_index from "./internal/notification-preferences/index.js";
import r_internal_notifications_index from "./internal/notifications/index.js";
import r_internal_notifications_mark_read from "./internal/notifications/mark-read.js";
import r_internal_onboarding_vendor_id_index from "./internal/onboarding/[vendor_id]/index.js";
import r_internal_onboarding_index from "./internal/onboarding/index.js";
import r_internal_part_adjustments_id from "./internal/part-adjustments/[id].js";
import r_internal_part_adjustments_index from "./internal/part-adjustments/index.js";
import r_internal_part_inventory_index from "./internal/part-inventory/index.js";
import r_internal_part_master_id from "./internal/part-master/[id].js";
import r_internal_part_master_index from "./internal/part-master/index.js";
import r_internal_part_matrix_index from "./internal/part-matrix/index.js";
import r_internal_part_matrix_resolve_part_size from "./internal/part-matrix/resolve-part-size.js";
import r_internal_part_purchases_index from "./internal/part-purchases/index.js";
import r_internal_part_thumbs from "./internal/part-thumbs.js";
import r_internal_part_types_id from "./internal/part-types/[id].js";
import r_internal_part_types_index from "./internal/part-types/index.js";
import r_internal_parts_part_id_images_image_id from "./internal/parts/[part_id]/images/[image_id].js";
import r_internal_parts_part_id_images_index from "./internal/parts/[part_id]/images/index.js";
import r_internal_payment_terms_id from "./internal/payment-terms/[id].js";
import r_internal_payment_terms_index from "./internal/payment-terms/index.js";
import r_internal_payments_id_fx_detail from "./internal/payments/[id]/fx-detail.js";
import r_internal_payments_id_index from "./internal/payments/[id]/index.js";
import r_internal_payments_index from "./internal/payments/index.js";
import r_internal_payments_virtual_card from "./internal/payments/virtual-card.js";
import r_internal_phase_change_requests_id_approve from "./internal/phase-change-requests/[id]/approve.js";
import r_internal_phase_change_requests_id_reject from "./internal/phase-change-requests/[id]/reject.js";
import r_internal_phase_change_requests_id_set_status from "./internal/phase-change-requests/[id]/set-status.js";
import r_internal_phase_change_requests_index from "./internal/phase-change-requests/index.js";
import r_internal_phase_notes_index from "./internal/phase-notes/index.js";
import r_internal_pim_attribute_defs_id from "./internal/pim/attribute-defs/[id].js";
import r_internal_pim_attribute_defs_index from "./internal/pim/attribute-defs/index.js";
import r_internal_pim_categories_id from "./internal/pim/categories/[id].js";
import r_internal_pim_categories_index from "./internal/pim/categories/index.js";
import r_internal_pim_style_colors_index from "./internal/pim/style-colors/index.js";
import r_internal_pim_style_thumbs_by_code from "./internal/pim/style-thumbs-by-code.js";
import r_internal_pim_style_thumbs from "./internal/pim/style-thumbs.js";
import r_internal_pim_styles_style_id from "./internal/pim/styles/[style_id].js";
import r_internal_pim_styles_style_id_attributes from "./internal/pim/styles/[style_id]/attributes.js";
import r_internal_pim_styles_style_id_description_index from "./internal/pim/styles/[style_id]/description/index.js";
import r_internal_pim_styles_style_id_description_publish from "./internal/pim/styles/[style_id]/description/publish.js";
import r_internal_pim_styles_style_id_images_id from "./internal/pim/styles/[style_id]/images/[id].js";
import r_internal_pim_styles_style_id_images_id_delete from "./internal/pim/styles/[style_id]/images/[id]/delete.js";
import r_internal_pim_styles_style_id_images_id_signed_url from "./internal/pim/styles/[style_id]/images/[id]/signed-url.js";
import r_internal_pim_styles_style_id_images_index from "./internal/pim/styles/[style_id]/images/index.js";
import r_internal_pim_styles_style_id_link_shopify from "./internal/pim/styles/[style_id]/link-shopify.js";
import r_internal_pim_styles_style_id_pull_shopify_images from "./internal/pim/styles/[style_id]/pull-shopify-images.js";
import r_internal_planning_buy_plan_to_po from "./internal/planning/buy-plan-to-po.js";
import r_internal_planning_link_planning_vendor from "./internal/planning/link-planning-vendor.js";
import r_internal_planning_promote_style_color from "./internal/planning/promote-style-color.js";
import r_internal_planning_sync_tangerine_supply from "./internal/planning/sync-tangerine-supply.js";
import r_internal_planning_vendors_seed from "./internal/planning/vendors-seed.js";
import r_internal_planning_vendors_tangerine_options from "./internal/planning/vendors-tangerine-options.js";
import r_internal_planning_vendors from "./internal/planning/vendors.js";
import r_internal_pos_id_messages from "./internal/pos/[id]/messages.js";
import r_internal_preferred_vendors_index from "./internal/preferred-vendors/index.js";
import r_internal_prepack_matrices_id from "./internal/prepack-matrices/[id].js";
import r_internal_prepack_matrices_index from "./internal/prepack-matrices/index.js";
import r_internal_prepack_matrices_needed from "./internal/prepack-matrices/needed.js";
import r_internal_price_list_items_id from "./internal/price-list-items/[id].js";
import r_internal_price_list_items_index from "./internal/price-list-items/index.js";
import r_internal_price_lists_id from "./internal/price-lists/[id].js";
import r_internal_price_lists_index from "./internal/price-lists/index.js";
import r_internal_price_lists_style_cost from "./internal/price-lists/style-cost.js";
import r_internal_price_promotions_id from "./internal/price-promotions/[id].js";
import r_internal_price_promotions_index from "./internal/price-promotions/index.js";
import r_internal_pricing_resolve from "./internal/pricing/resolve.js";
import r_internal_procurement_bookkeeper_queue_id from "./internal/procurement/bookkeeper-queue/[id].js";
import r_internal_procurement_bookkeeper_queue_index from "./internal/procurement/bookkeeper-queue/index.js";
import r_internal_procurement_broker_invoices_id from "./internal/procurement/broker-invoices/[id].js";
import r_internal_procurement_broker_invoices_index from "./internal/procurement/broker-invoices/index.js";
import r_internal_procurement_customs_entries_id from "./internal/procurement/customs-entries/[id].js";
import r_internal_procurement_customs_entries_index from "./internal/procurement/customs-entries/index.js";
import r_internal_procurement_qc_id from "./internal/procurement/qc/[id].js";
import r_internal_procurement_qc_dispositions from "./internal/procurement/qc/dispositions.js";
import r_internal_procurement_qc_index from "./internal/procurement/qc/index.js";
import r_internal_procurement_receipts_id from "./internal/procurement/receipts/[id].js";
import r_internal_procurement_receipts_index from "./internal/procurement/receipts/index.js";
import r_internal_procurement_receipts_post from "./internal/procurement/receipts/post.js";
import r_internal_procurement_recon_inbox_index from "./internal/procurement/recon-inbox/index.js";
import r_internal_procurement_vendor_invoice_drafts_id from "./internal/procurement/vendor-invoice-drafts/[id].js";
import r_internal_procurement_vendor_invoice_drafts_index from "./internal/procurement/vendor-invoice-drafts/index.js";
import r_internal_purchase_orders_id from "./internal/purchase-orders/[id].js";
import r_internal_purchase_orders_data_quality from "./internal/purchase-orders/data-quality.js";
import r_internal_purchase_orders_index from "./internal/purchase-orders/index.js";
import r_internal_purchase_orders_part_bill from "./internal/purchase-orders/part-bill.js";
import r_internal_purchase_orders_shipments from "./internal/purchase-orders/shipments.js";
import r_internal_purchase_orders_split_by_lot from "./internal/purchase-orders/split-by-lot.js";
import r_internal_rbac_observations from "./internal/rbac/observations.js";
import r_internal_recon_clear from "./internal/recon/clear.js";
import r_internal_recon_cutovers from "./internal/recon/cutovers.js";
import r_internal_recon_dso_dpo from "./internal/recon/dso-dpo.js";
import r_internal_recon_run_ap from "./internal/recon/run-ap.js";
import r_internal_recon_run_ar from "./internal/recon/run-ar.js";
import r_internal_recon_run_cash from "./internal/recon/run-cash.js";
import r_internal_recon_run_gl from "./internal/recon/run-gl.js";
import r_internal_recon_run_inventory from "./internal/recon/run-inventory.js";
import r_internal_recon_runs from "./internal/recon/runs.js";
import r_internal_recon_variances from "./internal/recon/variances.js";
import r_internal_reports_spend from "./internal/reports/spend.js";
import r_internal_reports_vendors from "./internal/reports/vendors.js";
import r_internal_rfqs_id_award_vendor_id from "./internal/rfqs/[id]/award/[vendor_id].js";
import r_internal_rfqs_id_close from "./internal/rfqs/[id]/close.js";
import r_internal_rfqs_id_index from "./internal/rfqs/[id]/index.js";
import r_internal_rfqs_id_messages_index from "./internal/rfqs/[id]/messages/index.js";
import r_internal_rfqs_id_publish from "./internal/rfqs/[id]/publish.js";
import r_internal_rfqs_id_quotes from "./internal/rfqs/[id]/quotes.js";
import r_internal_rfqs_index from "./internal/rfqs/index.js";
import r_internal_rfqs_messages_inbox_index from "./internal/rfqs/messages-inbox/index.js";
import r_internal_rma_reasons_id from "./internal/rma-reasons/[id].js";
import r_internal_rma_reasons_index from "./internal/rma-reasons/index.js";
import r_internal_sales_by_customer_index from "./internal/sales-by-customer/index.js";
import r_internal_sales_by_rep_index from "./internal/sales-by-rep/index.js";
import r_internal_sales_orders_id from "./internal/sales-orders/[id].js";
import r_internal_sales_orders_id_record_payment from "./internal/sales-orders/[id]/record-payment.js";
import r_internal_sales_orders_allocate_by_lot from "./internal/sales-orders/allocate-by-lot.js";
import r_internal_sales_orders_allocate from "./internal/sales-orders/allocate.js";
import r_internal_sales_orders_bulk_match from "./internal/sales-orders/bulk-match.js";
import r_internal_sales_orders_create_invoice from "./internal/sales-orders/create-invoice.js";
import r_internal_sales_orders_email_confirmation from "./internal/sales-orders/email-confirmation.js";
import r_internal_sales_orders_index from "./internal/sales-orders/index.js";
import r_internal_sales_orders_match_customer from "./internal/sales-orders/match-customer.js";
import r_internal_sales_orders_parse_customer_po from "./internal/sales-orders/parse-customer-po.js";
import r_internal_sales_orders_placeholder_po from "./internal/sales-orders/placeholder-po.js";
import r_internal_sales_orders_ship from "./internal/sales-orders/ship.js";
import r_internal_sales_orders_split from "./internal/sales-orders/split.js";
import r_internal_sales_orders_wave from "./internal/sales-orders/wave.js";
import r_internal_sales_reps_id_assignments from "./internal/sales-reps/[id]/assignments.js";
import r_internal_sales_reps_id_tiers from "./internal/sales-reps/[id]/tiers.js";
import r_internal_sales_reps_index from "./internal/sales-reps/index.js";
import r_internal_sales_returns_id from "./internal/sales-returns/[id].js";
import r_internal_sales_returns_id_credit_memo from "./internal/sales-returns/[id]/credit-memo.js";
import r_internal_sales_returns_index from "./internal/sales-returns/index.js";
import r_internal_scanner_events_batch from "./internal/scanner/events/batch.js";
import r_internal_scanner_sessions_id from "./internal/scanner/sessions/[id].js";
import r_internal_scanner_sessions_cancel from "./internal/scanner/sessions/cancel.js";
import r_internal_scanner_sessions_index from "./internal/scanner/sessions/index.js";
import r_internal_scanner_sessions_submit from "./internal/scanner/sessions/submit.js";
import r_internal_scf_programs_id from "./internal/scf-programs/[id].js";
import r_internal_scf_programs_index from "./internal/scf-programs/index.js";
import r_internal_scf_requests_id_approve from "./internal/scf/requests/[id]/approve.js";
import r_internal_scf_requests_id_fund from "./internal/scf/requests/[id]/fund.js";
import r_internal_scf_requests_index from "./internal/scf/requests/index.js";
import r_internal_scorecards_vendor_id_history from "./internal/scorecards/[vendor_id]/history.js";
import r_internal_scorecards_generate from "./internal/scorecards/generate.js";
import r_internal_scorecards_index from "./internal/scorecards/index.js";
import r_internal_search_index from "./internal/search/index.js";
import r_internal_seasons_id from "./internal/seasons/[id].js";
import r_internal_seasons_index from "./internal/seasons/index.js";
import r_internal_segment_pl_gl_drill from "./internal/segment-pl/gl-drill.js";
import r_internal_segment_pl_index from "./internal/segment-pl/index.js";
import r_internal_service_items_id from "./internal/service-items/[id].js";
import r_internal_service_items_index from "./internal/service-items/index.js";
import r_internal_shopify_backfill from "./internal/shopify/backfill.js";
import r_internal_shopify_post_cogs_id from "./internal/shopify/post-cogs/[id].js";
import r_internal_shopify_post_order_id from "./internal/shopify/post-order/[id].js";
import r_internal_shopify_process_refund_id from "./internal/shopify/process-refund/[id].js";
import r_internal_shopify_stores_id from "./internal/shopify/stores/[id].js";
import r_internal_shopify_stores_id_bulk_link from "./internal/shopify/stores/[id]/bulk-link.js";
import r_internal_shopify_stores_id_bulk_pull from "./internal/shopify/stores/[id]/bulk-pull.js";
import r_internal_shopify_stores_id_bulk_sync_meta from "./internal/shopify/stores/[id]/bulk-sync-meta.js";
import r_internal_shopify_stores_id_test from "./internal/shopify/stores/[id]/test.js";
import r_internal_shopify_stores_index from "./internal/shopify/stores/index.js";
import r_internal_shopify_sync_payouts from "./internal/shopify/sync-payouts.js";
import r_internal_shopify_webhooks_disputes from "./internal/shopify/webhooks/disputes.js";
import r_internal_shopify_webhooks_orders from "./internal/shopify/webhooks/orders.js";
import r_internal_shopify_webhooks_refunds from "./internal/shopify/webhooks/refunds.js";
import r_internal_size_scales_id from "./internal/size-scales/[id].js";
import r_internal_size_scales_index from "./internal/size-scales/index.js";
import r_internal_states_index from "./internal/states/index.js";
import r_internal_style_classifications_id from "./internal/style-classifications/[id].js";
import r_internal_style_classifications_index from "./internal/style-classifications/index.js";
import r_internal_style_customer_numbers_id from "./internal/style-customer-numbers/[id].js";
import r_internal_style_customer_numbers_index from "./internal/style-customer-numbers/index.js";
import r_internal_style_fabric_codes_id from "./internal/style-fabric-codes/[id].js";
import r_internal_style_fabric_codes_index from "./internal/style-fabric-codes/index.js";
import r_internal_style_master_id from "./internal/style-master/[id].js";
import r_internal_style_master_auto_assign_scales from "./internal/style-master/auto-assign-scales.js";
import r_internal_style_master_cbm_estimate from "./internal/style-master/cbm-estimate.js";
import r_internal_style_master_dim_values from "./internal/style-master/dim-values.js";
import r_internal_style_master_index from "./internal/style-master/index.js";
import r_internal_style_master_notes from "./internal/style-master/notes.js";
import r_internal_style_master_scale_missing from "./internal/style-master/scale-missing.js";
import r_internal_style_matrix_index from "./internal/style-matrix/index.js";
import r_internal_style_matrix_resolve_sku from "./internal/style-matrix/resolve-sku.js";
import r_internal_style_orders_index from "./internal/style-orders/index.js";
import r_internal_sustainability_id_review from "./internal/sustainability/[id]/review.js";
import r_internal_sustainability_index from "./internal/sustainability/index.js";
import r_internal_tax_calculations from "./internal/tax/calculations.js";
import r_internal_tax_drill from "./internal/tax/drill.js";
import r_internal_tax_filings from "./internal/tax/filings.js";
import r_internal_tax_index from "./internal/tax/index.js";
import r_internal_tax_remittance_report from "./internal/tax/remittance-report.js";
import r_internal_tax_remittances from "./internal/tax/remittances.js";
import r_internal_tax_rules_id from "./internal/tax/rules/[id].js";
import r_internal_tax_rules_index from "./internal/tax/rules/index.js";
import r_internal_tax_worklist from "./internal/tax/worklist.js";
import r_internal_three_way_match_matches from "./internal/three-way-match/matches.js";
import r_internal_three_way_match_resolve from "./internal/three-way-match/resolve.js";
import r_internal_three_way_match_run from "./internal/three-way-match/run.js";
import r_internal_three_way_match_tolerances from "./internal/three-way-match/tolerances.js";
import r_internal_tpl_providers_index from "./internal/tpl-providers/index.js";
import r_internal_tpl_providers_test_connection from "./internal/tpl-providers/test-connection.js";
import r_internal_tpl_shipments_id from "./internal/tpl-shipments/[id].js";
import r_internal_tpl_shipments_index from "./internal/tpl-shipments/index.js";
import r_internal_transfer_reasons_id from "./internal/transfer-reasons/[id].js";
import r_internal_transfer_reasons_index from "./internal/transfer-reasons/index.js";
import r_internal_trial_balance_index from "./internal/trial-balance/index.js";
import r_internal_upc_items_index from "./internal/upc-items/index.js";
import r_internal_users_access_index from "./internal/users-access/index.js";
import r_internal_users_access_me from "./internal/users-access/me.js";
import r_internal_users_access_override from "./internal/users-access/override.js";
import r_internal_users_me_entities_index from "./internal/users/me/entities/index.js";
import r_internal_users_me_entity_default from "./internal/users/me/entity-default.js";
import r_internal_users_me_entity_switch from "./internal/users/me/entity-switch.js";
import r_internal_users_me_menu_click_index from "./internal/users/me/menu-click/index.js";
import r_internal_users_me_menu_usage_top from "./internal/users/me/menu-usage/top.js";
import r_internal_users_me_preferences_drawer_collapsed from "./internal/users/me/preferences/drawer-collapsed.js";
import r_internal_users_me_preferences_favorites from "./internal/users/me/preferences/favorites.js";
import r_internal_users_me_preferences_home_route from "./internal/users/me/preferences/home-route.js";
import r_internal_users_me_preferences_index from "./internal/users/me/preferences/index.js";
import r_internal_users_me_preferences_table_visibility from "./internal/users/me/preferences/table-visibility.js";
import r_internal_vendor_access_index from "./internal/vendor-access/index.js";
import r_internal_vendor_invites_index from "./internal/vendor-invites/index.js";
import r_internal_vendor_master_id from "./internal/vendor-master/[id].js";
import r_internal_vendor_master_index from "./internal/vendor-master/index.js";
import r_internal_vendor_scorecard_index from "./internal/vendor-scorecard/index.js";
import r_internal_vendors_id_anomalies from "./internal/vendors/[id]/anomalies.js";
import r_internal_vendors_id_flags_flag_id from "./internal/vendors/[id]/flags/[flag_id].js";
import r_internal_vendors_id_flags_index from "./internal/vendors/[id]/flags/index.js";
import r_internal_vendors_id_index from "./internal/vendors/[id]/index.js";
import r_internal_vendors_id_notes_index from "./internal/vendors/[id]/notes/index.js";
import r_internal_vendors_id_preferred_pref_id from "./internal/vendors/[id]/preferred/[pref_id].js";
import r_internal_vendors_id_preferred_index from "./internal/vendors/[id]/preferred/index.js";
import r_internal_vendors_diversity from "./internal/vendors/diversity.js";
import r_internal_vendors_index from "./internal/vendors/index.js";
import r_internal_vendors_suggest from "./internal/vendors/suggest.js";
import r_internal_virtual_cards_id_cancel from "./internal/virtual-cards/[id]/cancel.js";
import r_internal_virtual_cards_index from "./internal/virtual-cards/index.js";
import r_internal_walmart_post_order_id from "./internal/walmart/post-order/[id].js";
import r_internal_walmart_sync_orders from "./internal/walmart/sync-orders.js";
import r_internal_walmart_sync_returns from "./internal/walmart/sync-returns.js";
import r_internal_walmart_sync_settlements from "./internal/walmart/sync-settlements.js";
import r_internal_warehouses_id from "./internal/warehouses/[id].js";
import r_internal_warehouses_index from "./internal/warehouses/index.js";
import r_internal_workflow_executions_id_approve from "./internal/workflow-executions/[id]/approve.js";
import r_internal_workflow_executions_id_index from "./internal/workflow-executions/[id]/index.js";
import r_internal_workflow_executions_id_reject from "./internal/workflow-executions/[id]/reject.js";
import r_internal_workflow_executions_index from "./internal/workflow-executions/index.js";
import r_internal_workflow_rules_id from "./internal/workflow-rules/[id].js";
import r_internal_workflow_rules_index from "./internal/workflow-rules/index.js";
import r_internal_workspaces_id_archive from "./internal/workspaces/[id]/archive.js";
import r_internal_workspaces_id_index from "./internal/workspaces/[id]/index.js";
import r_internal_workspaces_id_pins_pin_id from "./internal/workspaces/[id]/pins/[pin_id].js";
import r_internal_workspaces_id_pins_index from "./internal/workspaces/[id]/pins/index.js";
import r_internal_workspaces_id_tasks_task_id from "./internal/workspaces/[id]/tasks/[task_id].js";
import r_internal_workspaces_id_tasks_index from "./internal/workspaces/[id]/tasks/index.js";
import r_internal_workspaces_index from "./internal/workspaces/index.js";
import r_internal_xoro_mirror_runs from "./internal/xoro-mirror-runs.js";
import r_internal_xoro_mirror_ap from "./internal/xoro-mirror/ap.js";
import r_internal_xoro_mirror_ar from "./internal/xoro-mirror/ar.js";
import r_internal_xoro_mirror_backfill_job from "./internal/xoro-mirror/backfill-job.js";
import r_internal_xoro_mirror_backfill_range from "./internal/xoro-mirror/backfill-range.js";
import r_internal_xoro_mirror_inventory from "./internal/xoro-mirror/inventory.js";
import r_internal_xoro_mirror_summary_je from "./internal/xoro-mirror/summary-je.js";
import r_internal_year_end_close_run from "./internal/year-end-close/run.js";
import r_marketplace_listings_id from "./marketplace/listings/[id].js";
import r_marketplace_listings_index from "./marketplace/listings/index.js";
import r_master_sync from "./master/sync.js";
import r_parse_excel from "./parse-excel.js";
import r_password_reset_confirm from "./password-reset/confirm.js";
import r_password_reset_request from "./password-reset/request.js";
import r_planning_sync_on_hand from "./planning/sync-on-hand.js";
import r_planning_sync_onhand_xoro from "./planning/sync-onhand-xoro.js";
import r_planning_sync_open_pos from "./planning/sync-open-pos.js";
import r_planning_sync_receipts from "./planning/sync-receipts.js";
import r_sales_backfill_grain from "./sales/backfill-grain.js";
import r_sales_sync_invoices from "./sales/sync-invoices.js";
import r_sales_upload_payment_state from "./sales/upload-payment-state.js";
import r_searates_proxy from "./searates-proxy.js";
import r_send_notification from "./send-notification.js";
import r_shopify_collections from "./shopify/collections.js";
import r_shopify_inventory from "./shopify/inventory.js";
import r_shopify_orders from "./shopify/orders.js";
import r_shopify_products from "./shopify/products.js";
import r_shopify_returns from "./shopify/returns.js";
import r_tanda_pos_sync from "./tanda-pos-sync.js";
import r_tanda_sync_from_xoro from "./tanda/sync-from-xoro.js";
import r_tanda_sync_sos_from_xoro from "./tanda/sync-sos-from-xoro.js";
import r_tanda_upload_sos from "./tanda/upload-sos.js";
import r_vendor_invite from "./vendor-invite.js";
import r_vendor_accept_invite from "./vendor/accept-invite.js";
import r_vendor_ai_extract_invoice from "./vendor/ai-extract-invoice.js";
import r_vendor_analytics_health from "./vendor/analytics/health.js";
import r_vendor_api_keys_id_index from "./vendor/api-keys/[id]/index.js";
import r_vendor_api_keys_id_logs from "./vendor/api-keys/[id]/logs.js";
import r_vendor_api_keys_index from "./vendor/api-keys/index.js";
import r_vendor_attachments_id from "./vendor/attachments/[id].js";
import r_vendor_attachments_index from "./vendor/attachments/index.js";
import r_vendor_banking from "./vendor/banking.js";
import r_vendor_bulk_id_index from "./vendor/bulk/[id]/index.js";
import r_vendor_bulk_index from "./vendor/bulk/index.js";
import r_vendor_bulk_upload from "./vendor/bulk/upload.js";
import r_vendor_change_requests from "./vendor/change-requests.js";
import r_vendor_compliance_audit_trail from "./vendor/compliance/audit-trail.js";
import r_vendor_compliance_index from "./vendor/compliance/index.js";
import r_vendor_compliance_summary from "./vendor/compliance/summary.js";
import r_vendor_contracts_id_index from "./vendor/contracts/[id]/index.js";
import r_vendor_contracts_id_sign from "./vendor/contracts/[id]/sign.js";
import r_vendor_contracts_id_versions from "./vendor/contracts/[id]/versions.js";
import r_vendor_contracts_index from "./vendor/contracts/index.js";
import r_vendor_discount_offers_id_accept from "./vendor/discount-offers/[id]/accept.js";
import r_vendor_discount_offers_id_reject from "./vendor/discount-offers/[id]/reject.js";
import r_vendor_discount_offers_index from "./vendor/discount-offers/index.js";
import r_vendor_disputes_id_index from "./vendor/disputes/[id]/index.js";
import r_vendor_disputes_id_messages from "./vendor/disputes/[id]/messages.js";
import r_vendor_disputes_index from "./vendor/disputes/index.js";
import r_vendor_disputes_summary from "./vendor/disputes/summary.js";
import r_vendor_diversity_profile_index from "./vendor/diversity-profile/index.js";
import r_vendor_edi_status from "./vendor/edi/status.js";
import r_vendor_entities from "./vendor/entities.js";
import r_vendor_erp from "./vendor/erp.js";
import r_vendor_esg_score_index from "./vendor/esg-score/index.js";
import r_vendor_i18n_geo from "./vendor/i18n-geo.js";
import r_vendor_invoices from "./vendor/invoices.js";
import r_vendor_invoices_id from "./vendor/invoices/[id].js";
import r_vendor_marketplace_inquiries_id_respond from "./vendor/marketplace/inquiries/[id]/respond.js";
import r_vendor_marketplace_inquiries_index from "./vendor/marketplace/inquiries/index.js";
import r_vendor_marketplace_listing_index from "./vendor/marketplace/listing/index.js";
import r_vendor_marketplace_listing_publish from "./vendor/marketplace/listing/publish.js";
import r_vendor_messages_unread_count from "./vendor/messages/unread-count.js";
import r_vendor_mobile_dashboard from "./vendor/mobile/dashboard.js";
import r_vendor_mobile_deregister_device from "./vendor/mobile/deregister-device.js";
import r_vendor_mobile_feed from "./vendor/mobile/feed.js";
import r_vendor_mobile_push_test from "./vendor/mobile/push-test.js";
import r_vendor_mobile_register_device from "./vendor/mobile/register-device.js";
import r_vendor_onboarding_index from "./vendor/onboarding/index.js";
import r_vendor_onboarding_steps_step_name from "./vendor/onboarding/steps/[step_name].js";
import r_vendor_onboarding_submit from "./vendor/onboarding/submit.js";
import r_vendor_payment_preference_index from "./vendor/payment-preference/index.js";
import r_vendor_payment_preferences_index from "./vendor/payment-preferences/index.js";
import r_vendor_payments_index from "./vendor/payments/index.js";
import r_vendor_pos_id_messages from "./vendor/pos/[id]/messages.js";
import r_vendor_reports_invoices from "./vendor/reports/invoices.js";
import r_vendor_reports_pos from "./vendor/reports/pos.js";
import r_vendor_reports_summary from "./vendor/reports/summary.js";
import r_vendor_rfqs_id_decline from "./vendor/rfqs/[id]/decline.js";
import r_vendor_rfqs_id_index from "./vendor/rfqs/[id]/index.js";
import r_vendor_rfqs_id_messages_index from "./vendor/rfqs/[id]/messages/index.js";
import r_vendor_rfqs_id_quote_revise from "./vendor/rfqs/[id]/quote/revise.js";
import r_vendor_rfqs_id_quotes_index from "./vendor/rfqs/[id]/quotes/index.js";
import r_vendor_rfqs_id_quotes_submit from "./vendor/rfqs/[id]/quotes/submit.js";
import r_vendor_rfqs_index from "./vendor/rfqs/index.js";
import r_vendor_rfqs_messages_inbox_index from "./vendor/rfqs/messages-inbox/index.js";
import r_vendor_scf_eligible_invoices from "./vendor/scf/eligible-invoices.js";
import r_vendor_scf_request from "./vendor/scf/request.js";
import r_vendor_scf_requests from "./vendor/scf/requests.js";
import r_vendor_scorecard from "./vendor/scorecard.js";
import r_vendor_shipments from "./vendor/shipments.js";
import r_vendor_shipments_id from "./vendor/shipments/[id].js";
import r_vendor_sustainability_id from "./vendor/sustainability/[id].js";
import r_vendor_sustainability_index from "./vendor/sustainability/index.js";
import r_vendor_tax_withholding from "./vendor/tax/withholding.js";
import r_vendor_translate from "./vendor/translate.js";
import r_vendor_virtual_cards_id_confirm_spent from "./vendor/virtual-cards/[id]/confirm-spent.js";
import r_vendor_virtual_cards_id_reveal from "./vendor/virtual-cards/[id]/reveal.js";
import r_vendor_virtual_cards_index from "./vendor/virtual-cards/index.js";
import r_vendor_workspaces_id_index from "./vendor/workspaces/[id]/index.js";
import r_vendor_workspaces_id_pins_pin_id from "./vendor/workspaces/[id]/pins/[pin_id].js";
import r_vendor_workspaces_id_pins_index from "./vendor/workspaces/[id]/pins/index.js";
import r_vendor_workspaces_id_tasks_task_id from "./vendor/workspaces/[id]/tasks/[task_id].js";
import r_vendor_workspaces_id_tasks_index from "./vendor/workspaces/[id]/tasks/index.js";
import r_vendor_workspaces_index from "./vendor/workspaces/index.js";
import r_webhooks_resend_inbound from "./webhooks/resend-inbound.js";
import r_xoro_ap_sync from "./xoro-ap-sync.js";
import r_xoro_items_missing_sync from "./xoro-items-missing-sync.js";
import r_xoro_proxy from "./xoro-proxy.js";
import r_xoro_receipts_sync from "./xoro-receipts-sync.js";
import r_xoro_sales_sync from "./xoro-sales-sync.js";
import r_xoro_inventory_snapshot from "./xoro/inventory-snapshot.js";
import r_xoro_items from "./xoro/items.js";
import r_xoro_open_pos from "./xoro/open-pos.js";
import r_xoro_probe_filters from "./xoro/probe-filters.js";
import r_xoro_receipts from "./xoro/receipts.js";
import r_xoro_sales_history from "./xoro/sales-history.js";
import r_xoro_sync_gl from "./xoro/sync-gl.js";
import r_xoro_sync_item_costing from "./xoro/sync-item-costing.js";
import r_xoro_writeback_cancel_po_line from "./xoro/writeback/cancel-po-line.js";
import r_xoro_writeback_create_buy_request from "./xoro/writeback/create-buy-request.js";
import r_xoro_writeback_expedite_po from "./xoro/writeback/expedite-po.js";
import r_xoro_writeback_reserve_update from "./xoro/writeback/reserve-update.js";
import r_xoro_writeback_update_po from "./xoro/writeback/update-po.js";

export const ROUTES = [
  { pattern: "/api/internal/pim/styles/:style_id/images/:id/signed-url", handler: r_internal_pim_styles_style_id_images_id_signed_url },
  { pattern: "/api/internal/pim/styles/:style_id/images/:id/delete", handler: r_internal_pim_styles_style_id_images_id_delete },
  { pattern: "/api/internal/pim/styles/:style_id/description/publish", handler: r_internal_pim_styles_style_id_description_publish },
  { pattern: "/api/internal/users/me/preferences/drawer-collapsed", handler: r_internal_users_me_preferences_drawer_collapsed },
  { pattern: "/api/internal/users/me/preferences/table-visibility", handler: r_internal_users_me_preferences_table_visibility },
  { pattern: "/api/internal/users/me/preferences/home-route", handler: r_internal_users_me_preferences_home_route },
  { pattern: "/api/internal/users/me/preferences/favorites", handler: r_internal_users_me_preferences_favorites },
  { pattern: "/api/internal/users/me/menu-usage/top", handler: r_internal_users_me_menu_usage_top },
  { pattern: "/api/internal/costing/lines/:line_id/compliance/:req_id", handler: r_internal_costing_lines_line_id_compliance_req_id },
  { pattern: "/api/internal/costing/lines/:line_id/quotes/:quote_id", handler: r_internal_costing_lines_line_id_quotes_quote_id },
  { pattern: "/api/internal/pim/styles/:style_id/images/:id", handler: r_internal_pim_styles_style_id_images_id },
  { pattern: "/api/internal/pim/styles/:style_id/pull-shopify-images", handler: r_internal_pim_styles_style_id_pull_shopify_images },
  { pattern: "/api/internal/edi/tpl/:provider_id/inventory-advice", handler: r_internal_edi_tpl_provider_id_inventory_advice },
  { pattern: "/api/internal/costing/lines/:line_id/select-quote", handler: r_internal_costing_lines_line_id_select_quote },
  { pattern: "/api/internal/edi/tpl/:provider_id/receipt-advice", handler: r_internal_edi_tpl_provider_id_receipt_advice },
  { pattern: "/api/internal/costing/projects/:id/generate-rfqs", handler: r_internal_costing_projects_id_generate_rfqs },
  { pattern: "/api/internal/costing/lines/:line_id/compliance", handler: r_internal_costing_lines_line_id_compliance_index },
  { pattern: "/api/internal/costing/lines/:line_id/po-history", handler: r_internal_costing_lines_line_id_po_history },
  { pattern: "/api/internal/costing/lines/:line_id/size-curve", handler: r_internal_costing_lines_line_id_size_curve },
  { pattern: "/api/internal/pim/styles/:style_id/link-shopify", handler: r_internal_pim_styles_style_id_link_shopify },
  { pattern: "/api/internal/shopify/stores/:id/bulk-sync-meta", handler: r_internal_shopify_stores_id_bulk_sync_meta },
  { pattern: "/api/internal/pim/styles/:style_id/description", handler: r_internal_pim_styles_style_id_description_index },
  { pattern: "/api/internal/pim/styles/:style_id/attributes", handler: r_internal_pim_styles_style_id_attributes },
  { pattern: "/api/vendor/marketplace/inquiries/:id/respond", handler: r_vendor_marketplace_inquiries_id_respond },
  { pattern: "/api/internal/costing/lines/:line_id/suggest", handler: r_internal_costing_lines_line_id_suggest },
  { pattern: "/api/internal/costing/lines/:line_id/quotes", handler: r_internal_costing_lines_line_id_quotes_index },
  { pattern: "/api/internal/costing/lines/:line_id/revise", handler: r_internal_costing_lines_line_id_revise },
  { pattern: "/api/internal/procurement/receipts/:id/post", handler: r_internal_procurement_receipts_post },
  { pattern: "/api/internal/edi/tpl/:provider_id/inbound", handler: r_internal_edi_tpl_provider_id_inbound },
  { pattern: "/api/internal/shopify/stores/:id/bulk-link", handler: r_internal_shopify_stores_id_bulk_link },
  { pattern: "/api/internal/shopify/stores/:id/bulk-pull", handler: r_internal_shopify_stores_id_bulk_pull },
  { pattern: "/api/internal/crm/opportunities/:id/stage", handler: r_internal_crm_opportunities_id_stage },
  { pattern: "/api/internal/pim/styles/:style_id/images", handler: r_internal_pim_styles_style_id_images_index },
  { pattern: "/api/internal/scanner/sessions/:id/cancel", handler: r_internal_scanner_sessions_cancel },
  { pattern: "/api/internal/scanner/sessions/:id/submit", handler: r_internal_scanner_sessions_submit },
  { pattern: "/api/internal/costing/projects/:id/lines", handler: r_internal_costing_projects_id_lines },
  { pattern: "/api/internal/recon/variances/:id/clear", handler: r_internal_recon_clear },
  { pattern: "/api/internal/scf/requests/:id/approve", handler: r_internal_scf_requests_id_approve },
  { pattern: "/api/internal/shopify/stores/:id/test", handler: r_internal_shopify_stores_id_test },
  { pattern: "/api/internal/scf/requests/:id/fund", handler: r_internal_scf_requests_id_fund },
  { pattern: "/api/vendor/rfqs/:id/quotes/submit", handler: r_vendor_rfqs_id_quotes_submit },
  { pattern: "/api/vendor/rfqs/:id/quote/revise", handler: r_vendor_rfqs_id_quote_revise },
  { pattern: "/api/internal/planning/vendors/tangerine-options", handler: r_internal_planning_vendors_tangerine_options },
  { pattern: "/api/internal/design/trend-brief/synthesize", handler: r_internal_design_trend_brief_synthesize },
  { pattern: "/api/internal/costing/rfq-compare/projects", handler: r_internal_costing_rfq_compare_projects_index },
  { pattern: "/api/internal/procurement/qc/dispositions", handler: r_internal_procurement_qc_dispositions },
  { pattern: "/api/internal/assistant/actions/confirm", handler: r_internal_assistant_actions_confirm },
  { pattern: "/api/internal/costing/search/categories", handler: r_internal_costing_search_categories },
  { pattern: "/api/internal/costing/search/sales-reps", handler: r_internal_costing_search_sales_reps },
  { pattern: "/api/internal/shopify/webhooks/disputes", handler: r_internal_shopify_webhooks_disputes },
  { pattern: "/api/vendor/marketplace/listing/publish", handler: r_vendor_marketplace_listing_publish },
  { pattern: "/api/internal/costing/masters/freeform", handler: r_internal_costing_masters_freeform },
  { pattern: "/api/internal/costing/search/customers", handler: r_internal_costing_search_customers },
  { pattern: "/api/internal/shopify/webhooks/refunds", handler: r_internal_shopify_webhooks_refunds },
  { pattern: "/api/internal/design/trend-brief/list", handler: r_internal_design_trend_brief_list },
  { pattern: "/api/internal/shopify/webhooks/orders", handler: r_internal_shopify_webhooks_orders },
  { pattern: "/api/internal/users/me/entity-default", handler: r_internal_users_me_entity_default },
  { pattern: "/api/internal/costing/search/fabrics", handler: r_internal_costing_search_fabrics },
  { pattern: "/api/internal/costing/search/vendors", handler: r_internal_costing_search_vendors },
  { pattern: "/api/internal/users/me/entity-switch", handler: r_internal_users_me_entity_switch },
  { pattern: "/api/internal/costing/search/colors", handler: r_internal_costing_search_colors },
  { pattern: "/api/internal/costing/search/scales", handler: r_internal_costing_search_scales },
  { pattern: "/api/internal/costing/search/styles", handler: r_internal_costing_search_styles },
  { pattern: "/api/internal/planning/vendors/seed", handler: r_internal_planning_vendors_seed },
  { pattern: "/api/internal/scanner/events/batch", handler: r_internal_scanner_events_batch },
  { pattern: "/api/internal/users/me/preferences", handler: r_internal_users_me_preferences_index },
  { pattern: "/api/internal/users/me/menu-click", handler: r_internal_users_me_menu_click_index },
  { pattern: "/api/internal/users/me/entities", handler: r_internal_users_me_entities_index },
  { pattern: "/api/internal/costing/comp/ly", handler: r_internal_costing_comp_ly },
  { pattern: "/api/internal/costing/comp/t3", handler: r_internal_costing_comp_t3 },
  { pattern: "/api/internal/inventory-cycle-counts/:id/lines/:line_id", handler: r_internal_inventory_cycle_counts_lines },
  { pattern: "/api/internal/purchase-orders/:id/shipments/:sid", handler: r_internal_purchase_orders_shipments },
  { pattern: "/api/internal/parts/:part_id/images/:image_id", handler: r_internal_parts_part_id_images_image_id },
  { pattern: "/api/internal/vendors/:id/preferred/:pref_id", handler: r_internal_vendors_id_preferred_pref_id },
  { pattern: "/api/internal/workspaces/:id/tasks/:task_id", handler: r_internal_workspaces_id_tasks_task_id },
  { pattern: "/api/internal/workspaces/:id/pins/:pin_id", handler: r_internal_workspaces_id_pins_pin_id },
  { pattern: "/api/vendor/workspaces/:id/tasks/:task_id", handler: r_vendor_workspaces_id_tasks_task_id },
  { pattern: "/api/internal/vendors/:id/flags/:flag_id", handler: r_internal_vendors_id_flags_flag_id },
  { pattern: "/api/internal/rfqs/:id/award/:vendor_id", handler: r_internal_rfqs_id_award_vendor_id },
  { pattern: "/api/vendor/workspaces/:id/pins/:pin_id", handler: r_vendor_workspaces_id_pins_pin_id },
  { pattern: "/api/internal/bank-transactions/:id/match-candidates", handler: r_internal_bank_transactions_match_candidates },
  { pattern: "/api/internal/procurement/vendor-invoice-drafts/:id", handler: r_internal_procurement_vendor_invoice_drafts_id },
  { pattern: "/api/internal/phase-change-requests/:id/set-status", handler: r_internal_phase_change_requests_id_set_status },
  { pattern: "/api/internal/inventory-cycle-counts/:id/finalize", handler: r_internal_inventory_cycle_counts_finalize },
  { pattern: "/api/internal/sales-orders/:id/email-confirmation", handler: r_internal_sales_orders_email_confirmation },
  { pattern: "/api/internal/bank-transactions/:id/apply-match", handler: r_internal_bank_transactions_apply_match },
  { pattern: "/api/internal/phase-change-requests/:id/approve", handler: r_internal_phase_change_requests_id_approve },
  { pattern: "/api/internal/gl-accounts/:id/brand-allocation", handler: r_internal_gl_accounts_id_brand_allocation },
  { pattern: "/api/internal/phase-change-requests/:id/reject", handler: r_internal_phase_change_requests_id_reject },
  { pattern: "/api/internal/procurement/bookkeeper-queue/:id", handler: r_internal_procurement_bookkeeper_queue_id },
  { pattern: "/api/internal/purchase-orders/:id/split-by-lot", handler: r_internal_purchase_orders_split_by_lot },
  { pattern: "/api/internal/bank-transactions/:id/create-je", handler: r_internal_bank_transactions_create_je },
  { pattern: "/api/internal/compliance/automation-rules/:id", handler: r_internal_compliance_automation_rules_id },
  { pattern: "/api/internal/procurement/broker-invoices/:id", handler: r_internal_procurement_broker_invoices_id },
  { pattern: "/api/internal/procurement/customs-entries/:id", handler: r_internal_procurement_customs_entries_id },
  { pattern: "/api/internal/sales-orders/:id/create-invoice", handler: r_internal_sales_orders_create_invoice },
  { pattern: "/api/internal/sales-orders/:id/record-payment", handler: r_internal_sales_orders_id_record_payment },
  { pattern: "/api/internal/workflow-executions/:id/approve", handler: r_internal_workflow_executions_id_approve },
  { pattern: "/api/internal/build-orders/:id/conversion-po", handler: r_internal_build_orders_conversion_po },
  { pattern: "/api/internal/entities/:id/coa-copy-from-rof", handler: r_internal_entities_id_coa_copy },
  { pattern: "/api/internal/inventory-adjustments/:id/post", handler: r_internal_inventory_adjustments_post },
  { pattern: "/api/internal/workflow-executions/:id/reject", handler: r_internal_workflow_executions_id_reject },
  { pattern: "/api/internal/bank-transactions/:id/unmatch", handler: r_internal_bank_transactions_unmatch },
  { pattern: "/api/internal/purchase-orders/:id/part-bill", handler: r_internal_purchase_orders_part_bill },
  { pattern: "/api/internal/purchase-orders/:id/shipments", handler: r_internal_purchase_orders_shipments },
  { pattern: "/api/internal/sales-returns/:id/credit-memo", handler: r_internal_sales_returns_id_credit_memo },
  { pattern: "/api/internal/scorecards/:vendor_id/history", handler: r_internal_scorecards_vendor_id_history },
  { pattern: "/api/vendor/virtual-cards/:id/confirm-spent", handler: r_vendor_virtual_cards_id_confirm_spent },
  { pattern: "/api/internal/approval-requests/:id/cancel", handler: r_internal_approval_requests_cancel },
  { pattern: "/api/internal/approval-requests/:id/decide", handler: r_internal_approval_requests_decide },
  { pattern: "/api/internal/bank-transactions/:id/ignore", handler: r_internal_bank_transactions_ignore },
  { pattern: "/api/internal/build-orders/:id/cmt-invoice", handler: r_internal_build_orders_cmt_invoice },
  { pattern: "/api/internal/bank-recon-runs/:id/compute", handler: r_internal_bank_recon_runs_compute },
  { pattern: "/api/internal/diversity/:vendor_id/verify", handler: r_internal_diversity_vendor_id_verify },
  { pattern: "/api/internal/journal-entries/:id/reverse", handler: r_internal_journal_entries_reverse },
  { pattern: "/api/internal/notifications/:id/mark-read", handler: r_internal_notifications_mark_read },
  { pattern: "/api/internal/journal-entries/:id/source", handler: r_internal_journal_entries_id_source },
  { pattern: "/api/internal/sales-reps/:id/assignments", handler: r_internal_sales_reps_id_assignments },
  { pattern: "/api/internal/shopify/process-refund/:id", handler: r_internal_shopify_process_refund_id },
  { pattern: "/api/internal/build-orders/:id/complete", handler: r_internal_build_orders_complete },
  { pattern: "/api/internal/edi/customer-partners/:id", handler: r_internal_edi_customer_partners_id },
  { pattern: "/api/internal/sales-orders/:id/allocate", handler: r_internal_sales_orders_allocate },
  { pattern: "/api/internal/sustainability/:id/review", handler: r_internal_sustainability_id_review },
  { pattern: "/api/vendor/onboarding/steps/:step_name", handler: r_vendor_onboarding_steps_step_name },
  { pattern: "/api/internal/build-orders/:id/release", handler: r_internal_build_orders_release },
  { pattern: "/api/internal/build-orders/:id/service", handler: r_internal_build_orders_service },
  { pattern: "/api/internal/documents/:id/signed-url", handler: r_internal_documents_signed_url },
  { pattern: "/api/internal/gl-periods/:id/preflight", handler: r_internal_gl_periods_preflight },
  { pattern: "/api/internal/procurement/receipts/:id", handler: r_internal_procurement_receipts_id },
  { pattern: "/api/internal/virtual-cards/:id/cancel", handler: r_internal_virtual_cards_id_cancel },
  { pattern: "/api/vendor/discount-offers/:id/accept", handler: r_vendor_discount_offers_id_accept },
  { pattern: "/api/vendor/discount-offers/:id/reject", handler: r_vendor_discount_offers_id_reject },
  { pattern: "/api/internal/build-orders/:id/cancel", handler: r_internal_build_orders_cancel },
  { pattern: "/api/internal/build-orders/:id/reopen", handler: r_internal_build_orders_reopen },
  { pattern: "/api/internal/edi/:vendor_id/messages", handler: r_internal_edi_vendor_id_messages },
  { pattern: "/api/internal/build-orders/:id/issue", handler: r_internal_build_orders_issue },
  { pattern: "/api/internal/chargebacks/:id/origin", handler: r_internal_chargebacks_id_origin },
  { pattern: "/api/internal/contracts/:id/versions", handler: r_internal_contracts_id_versions },
  { pattern: "/api/internal/costing/lines/:line_id", handler: r_internal_costing_lines_line_id_index },
  { pattern: "/api/internal/factor/chargebacks/:id", handler: r_internal_factor_chargebacks_id },
  { pattern: "/api/internal/payments/:id/fx-detail", handler: r_internal_payments_id_fx_detail },
  { pattern: "/api/internal/pim/attribute-defs/:id", handler: r_internal_pim_attribute_defs_id },
  { pattern: "/api/internal/sales-orders/:id/split", handler: r_internal_sales_orders_split },
  { pattern: "/api/internal/shopify/post-order/:id", handler: r_internal_shopify_post_order_id },
  { pattern: "/api/internal/walmart/post-order/:id", handler: r_internal_walmart_post_order_id },
  { pattern: "/api/internal/workspaces/:id/archive", handler: r_internal_workspaces_id_archive },
  { pattern: "/api/vendor/virtual-cards/:id/reveal", handler: r_vendor_virtual_cards_id_reveal },
  { pattern: "/api/internal/compliance/:id/review", handler: r_internal_compliance_id_review },
  { pattern: "/api/internal/crm/opportunities/:id", handler: r_internal_crm_opportunities_id },
  { pattern: "/api/internal/disputes/:id/messages", handler: r_internal_disputes_id_messages },
  { pattern: "/api/internal/documents/:id/archive", handler: r_internal_documents_archive },
  { pattern: "/api/internal/entities/:id/branding", handler: r_internal_entities_id_branding },
  { pattern: "/api/internal/faire/post-payout/:id", handler: r_internal_faire_post_payout_id },
  { pattern: "/api/internal/gl-periods/:id/reopen", handler: r_internal_gl_periods_reopen },
  { pattern: "/api/internal/parts/:part_id/images", handler: r_internal_parts_part_id_images_index },
  { pattern: "/api/internal/sales-orders/:id/ship", handler: r_internal_sales_orders_ship },
  { pattern: "/api/internal/sales-orders/:id/wave", handler: r_internal_sales_orders_wave },
  { pattern: "/api/internal/shopify/post-cogs/:id", handler: r_internal_shopify_post_cogs_id },
  { pattern: "/api/internal/vendors/:id/anomalies", handler: r_internal_vendors_id_anomalies },
  { pattern: "/api/internal/vendors/:id/preferred", handler: r_internal_vendors_id_preferred_index },
  { pattern: "/api/internal/ap-invoices/:id/post", handler: r_internal_ap_invoices_post },
  { pattern: "/api/internal/ap-invoices/:id/void", handler: r_internal_ap_invoices_void },
  { pattern: "/api/internal/ar-invoices/:id/post", handler: r_internal_ar_invoices_post },
  { pattern: "/api/internal/ar-invoices/:id/void", handler: r_internal_ar_invoices_void },
  { pattern: "/api/internal/ar-receipts/:id/post", handler: r_internal_ar_receipts_post },
  { pattern: "/api/internal/ar-receipts/:id/void", handler: r_internal_ar_receipts_void },
  { pattern: "/api/internal/costing/projects/:id", handler: r_internal_costing_projects_id_index },
  { pattern: "/api/internal/entities/:id/vendors", handler: r_internal_entities_id_vendors },
  { pattern: "/api/internal/faire/post-order/:id", handler: r_internal_faire_post_order_id },
  { pattern: "/api/internal/gl-periods/:id/close", handler: r_internal_gl_periods_close },
  { pattern: "/api/internal/pim/styles/:style_id", handler: r_internal_pim_styles_style_id },
  { pattern: "/api/internal/sales-reps/:id/tiers", handler: r_internal_sales_reps_id_tiers },
  { pattern: "/api/internal/scanner/sessions/:id", handler: r_internal_scanner_sessions_id },
  { pattern: "/api/internal/workspaces/:id/tasks", handler: r_internal_workspaces_id_tasks_index },
  { pattern: "/api/vendor/contracts/:id/versions", handler: r_vendor_contracts_id_versions },
  { pattern: "/api/internal/ap-invoices/:id/pay", handler: r_internal_ap_invoices_pay },
  { pattern: "/api/internal/edi/:vendor_id/send", handler: r_internal_edi_vendor_id_send },
  { pattern: "/api/internal/workspaces/:id/pins", handler: r_internal_workspaces_id_pins_index },
  { pattern: "/api/vendor/disputes/:id/messages", handler: r_vendor_disputes_id_messages },
  { pattern: "/api/internal/cases/:id/comments", handler: r_internal_cases_id_comments },
  { pattern: "/api/internal/crm/activities/:id", handler: r_internal_crm_activities_id },
  { pattern: "/api/internal/fba/post-order/:id", handler: r_internal_fba_post_order_id },
  { pattern: "/api/internal/pim/categories/:id", handler: r_internal_pim_categories_id },
  { pattern: "/api/internal/procurement/qc/:id", handler: r_internal_procurement_qc_id },
  { pattern: "/api/internal/shopify/stores/:id", handler: r_internal_shopify_stores_id },
  { pattern: "/api/vendor/workspaces/:id/tasks", handler: r_vendor_workspaces_id_tasks_index },
  { pattern: "/api/internal/rfqs/:id/messages", handler: r_internal_rfqs_id_messages_index },
  { pattern: "/api/internal/vendors/:id/flags", handler: r_internal_vendors_id_flags_index },
  { pattern: "/api/internal/vendors/:id/notes", handler: r_internal_vendors_id_notes_index },
  { pattern: "/api/vendor/workspaces/:id/pins", handler: r_vendor_workspaces_id_pins_index },
  { pattern: "/api/internal/costing/rfqs/:id", handler: r_internal_costing_rfqs_id_index },
  { pattern: "/api/internal/pos/:id/messages", handler: r_internal_pos_id_messages },
  { pattern: "/api/internal/rfqs/:id/publish", handler: r_internal_rfqs_id_publish },
  { pattern: "/api/vendor/contracts/:id/sign", handler: r_vendor_contracts_id_sign },
  { pattern: "/api/internal/rfqs/:id/quotes", handler: r_internal_rfqs_id_quotes },
  { pattern: "/api/vendor/api-keys/:id/logs", handler: r_vendor_api_keys_id_logs },
  { pattern: "/api/vendor/rfqs/:id/messages", handler: r_vendor_rfqs_id_messages_index },
  { pattern: "/api/internal/rfqs/:id/close", handler: r_internal_rfqs_id_close },
  { pattern: "/api/vendor/pos/:id/messages", handler: r_vendor_pos_id_messages },
  { pattern: "/api/vendor/rfqs/:id/decline", handler: r_vendor_rfqs_id_decline },
  { pattern: "/api/internal/crm/tasks/:id", handler: r_internal_crm_tasks_id },
  { pattern: "/api/internal/tax/rules/:id", handler: r_internal_tax_rules_id },
  { pattern: "/api/vendor/rfqs/:id/quotes", handler: r_vendor_rfqs_id_quotes_index },
  { pattern: "/api/internal/inventory-accuracy/perpetual-movements", handler: r_internal_inventory_accuracy_perpetual_movements },
  { pattern: "/api/internal/procurement/vendor-invoice-drafts", handler: r_internal_procurement_vendor_invoice_drafts_index },
  { pattern: "/api/internal/style-master/auto-assign-scales", handler: r_internal_style_master_auto_assign_scales },
  { pattern: "/api/internal/analytics/sustainability-trend", handler: r_internal_analytics_sustainability_trend },
  { pattern: "/api/internal/consolidation/income-statement", handler: r_internal_consolidation_income_statement },
  { pattern: "/api/internal/fixed-assets/generate-schedule", handler: r_internal_fixed_assets_generate_schedule },
  { pattern: "/api/internal/fixed-assets/post-depreciation", handler: r_internal_fixed_assets_post_depreciation },
  { pattern: "/api/internal/planning/sync-tangerine-supply", handler: r_internal_planning_sync_tangerine_supply },
  { pattern: "/api/internal/sales-orders/parse-customer-po", handler: r_internal_sales_orders_parse_customer_po },
  { pattern: "/api/internal/part-matrix/resolve-part-size", handler: r_internal_part_matrix_resolve_part_size },
  { pattern: "/api/internal/planning/link-planning-vendor", handler: r_internal_planning_link_planning_vendor },
  { pattern: "/api/internal/tpl-providers/test-connection", handler: r_internal_tpl_providers_test_connection },
  { pattern: "/api/internal/chargebacks/dilution-summary", handler: r_internal_chargebacks_dilution_summary },
  { pattern: "/api/internal/compliance/automation-report", handler: r_internal_compliance_automation_report },
  { pattern: "/api/internal/inventory-accuracy/perpetual", handler: r_internal_inventory_accuracy_perpetual },
  { pattern: "/api/internal/planning/promote-style-color", handler: r_internal_planning_promote_style_color },
  { pattern: "/api/internal/procurement/bookkeeper-queue", handler: r_internal_procurement_bookkeeper_queue_index },
  { pattern: "/api/internal/purchase-orders/data-quality", handler: r_internal_purchase_orders_data_quality },
  { pattern: "/api/internal/sales-orders/allocate-by-lot", handler: r_internal_sales_orders_allocate_by_lot },
  { pattern: "/api/internal/compliance/automation-rules", handler: r_internal_compliance_automation_rules_index },
  { pattern: "/api/internal/consolidation/balance-sheet", handler: r_internal_consolidation_balance_sheet },
  { pattern: "/api/internal/consolidation/trial-balance", handler: r_internal_consolidation_trial_balance },
  { pattern: "/api/internal/procurement/broker-invoices", handler: r_internal_procurement_broker_invoices_index },
  { pattern: "/api/internal/procurement/customs-entries", handler: r_internal_procurement_customs_entries_index },
  { pattern: "/api/internal/sales-orders/match-customer", handler: r_internal_sales_orders_match_customer },
  { pattern: "/api/internal/sales-orders/placeholder-po", handler: r_internal_sales_orders_placeholder_po },
  { pattern: "/api/internal/consolidation/eliminations", handler: r_internal_consolidation_eliminations },
  { pattern: "/api/internal/inventory-accuracy/summary", handler: r_internal_inventory_accuracy_summary },
  { pattern: "/api/internal/marketplace/convert-to-rfq", handler: r_internal_marketplace_convert_to_rfq },
  { pattern: "/api/internal/month-end-close/run-checks", handler: r_internal_month_end_close_run_checks },
  { pattern: "/api/internal/style-master/scale-missing", handler: r_internal_style_master_scale_missing },
  { pattern: "/api/internal/three-way-match/tolerances", handler: r_internal_three_way_match_tolerances },
  { pattern: "/api/internal/xoro-mirror/backfill-range", handler: r_internal_xoro_mirror_backfill_range },
  { pattern: "/api/internal/analytics/diversity-spend", handler: r_internal_analytics_diversity_spend },
  { pattern: "/api/internal/ar-collections/activities", handler: r_internal_ar_collections_activities },
  { pattern: "/api/internal/compliance/document-types", handler: r_internal_compliance_document_types },
  { pattern: "/api/internal/discount-offers/analytics", handler: r_internal_discount_offers_analytics },
  { pattern: "/api/internal/inventory-accuracy/detail", handler: r_internal_inventory_accuracy_detail },
  { pattern: "/api/internal/month-end-close/checklist", handler: r_internal_month_end_close_checklist },
  { pattern: "/api/internal/style-master/cbm-estimate", handler: r_internal_style_master_cbm_estimate },
  { pattern: "/api/internal/addresses/postal-suggest", handler: r_internal_addresses_postal_suggest },
  { pattern: "/api/internal/discount-offers/generate", handler: r_internal_discount_offers_generate },
  { pattern: "/api/internal/month-end-close/sign-off", handler: r_internal_month_end_close_sign_off },
  { pattern: "/api/internal/pim/style-thumbs-by-code", handler: r_internal_pim_style_thumbs_by_code },
  { pattern: "/api/internal/style-matrix/resolve-sku", handler: r_internal_style_matrix_resolve_sku },
  { pattern: "/api/internal/walmart/sync-settlements", handler: r_internal_walmart_sync_settlements },
  { pattern: "/api/internal/xoro-mirror/backfill-job", handler: r_internal_xoro_mirror_backfill_job },
  { pattern: "/api/xoro/writeback/create-buy-request", handler: r_xoro_writeback_create_buy_request },
  { pattern: "/api/internal/analytics/early-payment", handler: r_internal_analytics_early_payment },
  { pattern: "/api/internal/analytics/health-scores", handler: r_internal_analytics_health_scores },
  { pattern: "/api/internal/ar-collections/promises", handler: r_internal_ar_collections_promises },
  { pattern: "/api/internal/inventory-aging/filters", handler: r_internal_inventory_aging_filters },
  { pattern: "/api/internal/month-end-close/periods", handler: r_internal_month_end_close_periods },
  { pattern: "/api/internal/planning/buy-plan-to-po", handler: r_internal_planning_buy_plan_to_po },
  { pattern: "/api/internal/prepack-matrices/needed", handler: r_internal_prepack_matrices_needed },
  { pattern: "/api/internal/procurement/recon-inbox", handler: r_internal_procurement_recon_inbox_index },
  { pattern: "/api/internal/sales-orders/bulk-match", handler: r_internal_sales_orders_bulk_match },
  { pattern: "/api/internal/style-master/dim-values", handler: r_internal_style_master_dim_values },
  { pattern: "/api/internal/three-way-match/matches", handler: r_internal_three_way_match_matches },
  { pattern: "/api/internal/three-way-match/resolve", handler: r_internal_three_way_match_resolve },
  { pattern: "/api/internal/ar-collections/summary", handler: r_internal_ar_collections_summary },
  { pattern: "/api/internal/compliance/audit-trail", handler: r_internal_compliance_audit_trail },
  { pattern: "/api/internal/costing/awarded-quotes", handler: r_internal_costing_awarded_quotes },
  { pattern: "/api/internal/inventory-aging/layers", handler: r_internal_inventory_aging_layers },
  { pattern: "/api/internal/inventory-aging/report", handler: r_internal_inventory_aging_report },
  { pattern: "/api/internal/month-end-close/reopen", handler: r_internal_month_end_close_reopen },
  { pattern: "/api/internal/price-lists/style-cost", handler: r_internal_price_lists_style_cost },
  { pattern: "/api/internal/xoro-mirror/summary-je", handler: r_internal_xoro_mirror_summary_je },
  { pattern: "/api/vendor/mobile/deregister-device", handler: r_vendor_mobile_deregister_device },
  { pattern: "/api/internal/bank-feeds/csv-upload", handler: r_internal_bank_feeds_csv_upload },
  { pattern: "/api/internal/bank-feeds/link-token", handler: r_internal_bank_feeds_link_token },
  { pattern: "/api/internal/edi/customer-partners", handler: r_internal_edi_customer_partners_index },
  { pattern: "/api/internal/marketplace/benchmark", handler: r_internal_marketplace_benchmark },
  { pattern: "/api/internal/marketplace/inquiries", handler: r_internal_marketplace_inquiries },
  { pattern: "/api/internal/messages/unread-count", handler: r_internal_messages_unread_count },
  { pattern: "/api/internal/month-end-close/close", handler: r_internal_month_end_close_close },
  { pattern: "/api/internal/payments/virtual-card", handler: r_internal_payments_virtual_card },
  { pattern: "/api/internal/tax/remittance-report", handler: r_internal_tax_remittance_report },
  { pattern: "/api/internal/users-access/override", handler: r_internal_users_access_override },
  { pattern: "/api/internal/xoro-mirror/inventory", handler: r_internal_xoro_mirror_inventory },
  { pattern: "/api/internal/analytics/categories", handler: r_internal_analytics_categories },
  { pattern: "/api/internal/commissions/accruals", handler: r_internal_commissions_accruals },
  { pattern: "/api/internal/consolidation/groups", handler: r_internal_consolidation_groups },
  { pattern: "/api/internal/fba/mirror-inventory", handler: r_internal_fba_mirror_inventory },
  { pattern: "/api/internal/fba/sync-settlements", handler: r_internal_fba_sync_settlements },
  { pattern: "/api/internal/procurement/receipts", handler: r_internal_procurement_receipts_index },
  { pattern: "/api/internal/shopify/sync-payouts", handler: r_internal_shopify_sync_payouts },
  { pattern: "/api/internal/walmart/sync-returns", handler: r_internal_walmart_sync_returns },
  { pattern: "/api/vendor/compliance/audit-trail", handler: r_vendor_compliance_audit_trail },
  { pattern: "/api/vendor/mobile/register-device", handler: r_vendor_mobile_register_device },
  { pattern: "/api/xoro/writeback/cancel-po-line", handler: r_xoro_writeback_cancel_po_line },
  { pattern: "/api/xoro/writeback/reserve-update", handler: r_xoro_writeback_reserve_update },
  { pattern: "/api/internal/allocations/preview", handler: r_internal_allocations_preview },
  { pattern: "/api/internal/analytics/financial", handler: r_internal_analytics_financial },
  { pattern: "/api/internal/bank-feeds/exchange", handler: r_internal_bank_feeds_exchange },
  { pattern: "/api/internal/commissions/payouts", handler: r_internal_commissions_payouts },
  { pattern: "/api/internal/commissions/reverse", handler: r_internal_commissions_reverse },
  { pattern: "/api/internal/costing/rfq-compare", handler: r_internal_costing_rfq_compare_index },
  { pattern: "/api/internal/crm/pipeline-report", handler: r_internal_crm_pipeline_report_index },
  { pattern: "/api/internal/fixed-assets/tieout", handler: r_internal_fixed_assets_tieout },
  { pattern: "/api/internal/marketplace/inquire", handler: r_internal_marketplace_inquire },
  { pattern: "/api/internal/recon/run-inventory", handler: r_internal_recon_run_inventory },
  { pattern: "/api/internal/rfqs/messages-inbox", handler: r_internal_rfqs_messages_inbox_index },
  { pattern: "/api/internal/scorecards/generate", handler: r_internal_scorecards_generate },
  { pattern: "/api/internal/segment-pl/gl-drill", handler: r_internal_segment_pl_gl_drill },
  { pattern: "/api/internal/three-way-match/run", handler: r_internal_three_way_match_run },
  { pattern: "/api/internal/walmart/sync-orders", handler: r_internal_walmart_sync_orders },
  { pattern: "/api/vendor/marketplace/inquiries", handler: r_vendor_marketplace_inquiries_index },
  { pattern: "/api/vendor/messages/unread-count", handler: r_vendor_messages_unread_count },
  { pattern: "/api/vendor/scf/eligible-invoices", handler: r_vendor_scf_eligible_invoices },
  { pattern: "/api/internal/ai/mention-suggest", handler: r_internal_ai_mention_suggest },
  { pattern: "/api/internal/analytics/forecast", handler: r_internal_analytics_forecast },
  { pattern: "/api/internal/ar-backfill/status", handler: r_internal_ar_backfill_status },
  { pattern: "/api/internal/colors/nrf-suggest", handler: r_internal_colors_nrf_suggest },
  { pattern: "/api/internal/commissions/accrue", handler: r_internal_commissions_accrue },
  { pattern: "/api/internal/commissions/settle", handler: r_internal_commissions_settle },
  { pattern: "/api/internal/costing/add-vendor", handler: r_internal_costing_add_vendor },
  { pattern: "/api/internal/factor/chargebacks", handler: r_internal_factor_chargebacks_index },
  { pattern: "/api/internal/faire/sync-payouts", handler: r_internal_faire_sync_payouts },
  { pattern: "/api/internal/faire/sync-returns", handler: r_internal_faire_sync_returns },
  { pattern: "/api/internal/pim/attribute-defs", handler: r_internal_pim_attribute_defs_index },
  { pattern: "/api/internal/style-master/notes", handler: r_internal_style_master_notes },
  { pattern: "/api/internal/year-end-close/run", handler: r_internal_year_end_close_run },
  { pattern: "/api/internal/allocations/rules", handler: r_internal_allocations_rules },
  { pattern: "/api/internal/assistant/dismiss", handler: r_internal_assistant_dismiss },
  { pattern: "/api/internal/audit/row-history", handler: r_internal_audit_row_history },
  { pattern: "/api/internal/chargebacks/drill", handler: r_internal_chargebacks_drill },
  { pattern: "/api/internal/crm/opportunities", handler: r_internal_crm_opportunities_index },
  { pattern: "/api/internal/factor/open-items", handler: r_internal_factor_open_items },
  { pattern: "/api/internal/factor/statements", handler: r_internal_factor_statements },
  { pattern: "/api/internal/faire/sync-orders", handler: r_internal_faire_sync_orders },
  { pattern: "/api/internal/rbac/observations", handler: r_internal_rbac_observations },
  { pattern: "/api/internal/vendors/diversity", handler: r_internal_vendors_diversity },
  { pattern: "/api/vendor/marketplace/listing", handler: r_vendor_marketplace_listing_index },
  { pattern: "/api/vendor/rfqs/messages-inbox", handler: r_vendor_rfqs_messages_inbox_index },
  { pattern: "/api/xoro/writeback/expedite-po", handler: r_xoro_writeback_expedite_po },
  { pattern: "/api/internal/chargebacks/bulk", handler: r_internal_chargebacks_bulk },
  { pattern: "/api/internal/costing/projects", handler: r_internal_costing_projects_index },
  { pattern: "/api/internal/fba/sync-returns", handler: r_internal_fba_sync_returns },
  { pattern: "/api/internal/insights/summary", handler: r_internal_insights_summary },
  { pattern: "/api/internal/pim/style-colors", handler: r_internal_pim_style_colors_index },
  { pattern: "/api/internal/pim/style-thumbs", handler: r_internal_pim_style_thumbs },
  { pattern: "/api/internal/planning/vendors", handler: r_internal_planning_vendors },
  { pattern: "/api/internal/scanner/sessions", handler: r_internal_scanner_sessions_index },
  { pattern: "/api/internal/shopify/backfill", handler: r_internal_shopify_backfill },
  { pattern: "/api/internal/tax/calculations", handler: r_internal_tax_calculations },
  { pattern: "/api/vendor/compliance/summary", handler: r_vendor_compliance_summary },
  { pattern: "/api/internal/ai/suggest-iso2", handler: r_internal_ai_suggest_iso2 },
  { pattern: "/api/internal/analytics/spend", handler: r_internal_analytics_spend },
  { pattern: "/api/internal/ap-aging/detail", handler: r_internal_ap_aging_detail },
  { pattern: "/api/internal/ap-backfill/run", handler: r_internal_ap_backfill_run },
  { pattern: "/api/internal/ar-aging/detail", handler: r_internal_ar_aging_detail },
  { pattern: "/api/internal/ar-backfill/run", handler: r_internal_ar_backfill_run },
  { pattern: "/api/internal/assistant/brief", handler: r_internal_assistant_brief },
  { pattern: "/api/internal/assistant/today", handler: r_internal_assistant_today },
  { pattern: "/api/internal/fba/sync-orders", handler: r_internal_fba_sync_orders },
  { pattern: "/api/internal/pricing/resolve", handler: r_internal_pricing_resolve },
  { pattern: "/api/internal/recon/variances", handler: r_internal_recon_variances },
  { pattern: "/api/internal/reports/vendors", handler: r_internal_reports_vendors },
  { pattern: "/api/internal/tax/remittances", handler: r_internal_tax_remittances },
  { pattern: "/api/internal/users-access/me", handler: r_internal_users_access_me },
  { pattern: "/api/internal/vendors/suggest", handler: r_internal_vendors_suggest },
  { pattern: "/api/vendor/onboarding/submit", handler: r_vendor_onboarding_submit },
  { pattern: "/api/xoro/writeback/update-po", handler: r_xoro_writeback_update_po },
  { pattern: "/api/internal/ai/ops-summary", handler: r_internal_ai_ops_summary },
  { pattern: "/api/internal/auth/provision", handler: r_internal_auth_provision },
  { pattern: "/api/internal/crm/activities", handler: r_internal_crm_activities_index },
  { pattern: "/api/internal/messages/inbox", handler: r_internal_messages_inbox },
  { pattern: "/api/internal/pim/categories", handler: r_internal_pim_categories_index },
  { pattern: "/api/internal/procurement/qc", handler: r_internal_procurement_qc_index },
  { pattern: "/api/internal/recon/cutovers", handler: r_internal_recon_cutovers },
  { pattern: "/api/internal/recon/run-cash", handler: r_internal_recon_run_cash },
  { pattern: "/api/internal/shopify/stores", handler: r_internal_shopify_stores_index },
  { pattern: "/api/internal/xoro-mirror/ap", handler: r_internal_xoro_mirror_ap },
  { pattern: "/api/internal/xoro-mirror/ar", handler: r_internal_xoro_mirror_ar },
  { pattern: "/api/vendor/analytics/health", handler: r_vendor_analytics_health },
  { pattern: "/api/vendor/disputes/summary", handler: r_vendor_disputes_summary },
  { pattern: "/api/vendor/mobile/dashboard", handler: r_vendor_mobile_dashboard },
  { pattern: "/api/vendor/mobile/push-test", handler: r_vendor_mobile_push_test },
  { pattern: "/api/vendor/reports/invoices", handler: r_vendor_reports_invoices },
  { pattern: "/api/internal/ai/user-facts", handler: r_internal_ai_user_facts },
  { pattern: "/api/internal/recon/dso-dpo", handler: r_internal_recon_dso_dpo },
  { pattern: "/api/internal/reports/spend", handler: r_internal_reports_spend },
  { pattern: "/api/vendor/reports/summary", handler: r_vendor_reports_summary },
  { pattern: "/api/vendor/tax/withholding", handler: r_vendor_tax_withholding },
  { pattern: "/api/external/v1/inventory", handler: r_external_v1_inventory },
  { pattern: "/api/internal/ai/documents", handler: r_internal_ai_documents },
  { pattern: "/api/internal/analytics/fx", handler: r_internal_analytics_fx },
  { pattern: "/api/internal/auth/signout", handler: r_internal_auth_signout },
  { pattern: "/api/internal/bulk/process", handler: r_internal_bulk_process },
  { pattern: "/api/internal/costing/rfqs", handler: r_internal_costing_rfqs_index },
  { pattern: "/api/internal/edi/settings", handler: r_internal_edi_settings_index },
  { pattern: "/api/internal/hts/backfill", handler: r_internal_hts_backfill },
  { pattern: "/api/internal/recon/run-ap", handler: r_internal_recon_run_ap },
  { pattern: "/api/internal/recon/run-ar", handler: r_internal_recon_run_ar },
  { pattern: "/api/internal/recon/run-gl", handler: r_internal_recon_run_gl },
  { pattern: "/api/internal/scf/requests", handler: r_internal_scf_requests_index },
  { pattern: "/api/internal/tax/worklist", handler: r_internal_tax_worklist },
  { pattern: "/api/edi/outbound/payment", handler: r_edi_outbound_payment },
  { pattern: "/api/external/v1/invoices", handler: r_external_v1_invoices },
  { pattern: "/api/internal/ai/insights", handler: r_internal_ai_insights },
  { pattern: "/api/internal/hts/suggest", handler: r_internal_hts_suggest },
  { pattern: "/api/internal/tax/filings", handler: r_internal_tax_filings },
  { pattern: "/api/internal/recon/runs", handler: r_internal_recon_runs },
  { pattern: "/api/vendor/scf/requests", handler: r_vendor_scf_requests },
  { pattern: "/api/external/v1/orders", handler: r_external_v1_orders },
  { pattern: "/api/external/v1/styles", handler: r_external_v1_styles },
  { pattern: "/api/internal/audit/log", handler: r_internal_audit_log },
  { pattern: "/api/internal/crm/tasks", handler: r_internal_crm_tasks_index },
  { pattern: "/api/internal/tax/drill", handler: r_internal_tax_drill },
  { pattern: "/api/internal/tax/rules", handler: r_internal_tax_rules_index },
  { pattern: "/api/vendor/bulk/upload", handler: r_vendor_bulk_upload },
  { pattern: "/api/vendor/mobile/feed", handler: r_vendor_mobile_feed },
  { pattern: "/api/vendor/reports/pos", handler: r_vendor_reports_pos },
  { pattern: "/api/vendor/scf/request", handler: r_vendor_scf_request },
  { pattern: "/api/internal/fx/rates", handler: r_internal_fx_rates },
  { pattern: "/api/vendor/edi/status", handler: r_vendor_edi_status },
  { pattern: "/api/external/v1/ping", handler: r_external_v1_ping },
  { pattern: "/api/edi/outbound/po", handler: r_edi_outbound_po },
  { pattern: "/api/internal/ar-receipt-applications/:id", handler: r_internal_ar_receipt_applications_id },
  { pattern: "/api/internal/inventory-cycle-counts/:id", handler: r_internal_inventory_cycle_counts_id },
  { pattern: "/api/internal/style-customer-numbers/:id", handler: r_internal_style_customer_numbers_id },
  { pattern: "/api/internal/inventory-adjustments/:id", handler: r_internal_inventory_adjustments_id },
  { pattern: "/api/internal/style-classifications/:id", handler: r_internal_style_classifications_id },
  { pattern: "/api/internal/employee-departments/:id", handler: r_internal_employee_departments_id },
  { pattern: "/api/internal/inventory-transfers/:id", handler: r_internal_inventory_transfers_id },
  { pattern: "/api/internal/workflow-executions/:id", handler: r_internal_workflow_executions_id_index },
  { pattern: "/api/internal/adjustment-reasons/:id", handler: r_internal_adjustment_reasons_id },
  { pattern: "/api/internal/buyer-scope-master/:id", handler: r_internal_buyer_scope_master_id },
  { pattern: "/api/internal/customer-locations/:id", handler: r_internal_customer_locations_id },
  { pattern: "/api/internal/style-fabric-codes/:id", handler: r_internal_style_fabric_codes_id },
  { pattern: "/api/internal/approval-requests/:id", handler: r_internal_approval_requests_id },
  { pattern: "/api/internal/onboarding/:vendor_id", handler: r_internal_onboarding_vendor_id_index },
  { pattern: "/api/internal/adjustment-types/:id", handler: r_internal_adjustment_types_id },
  { pattern: "/api/internal/part-adjustments/:id", handler: r_internal_part_adjustments_id },
  { pattern: "/api/internal/prepack-matrices/:id", handler: r_internal_prepack_matrices_id },
  { pattern: "/api/internal/price-list-items/:id", handler: r_internal_price_list_items_id },
  { pattern: "/api/internal/price-promotions/:id", handler: r_internal_price_promotions_id },
  { pattern: "/api/internal/transfer-reasons/:id", handler: r_internal_transfer_reasons_id },
  { pattern: "/api/internal/bank-recon-runs/:id", handler: r_internal_bank_recon_runs_id },
  { pattern: "/api/internal/customer-buyers/:id", handler: r_internal_customer_buyers_id },
  { pattern: "/api/internal/customer-master/:id", handler: r_internal_customer_master_id },
  { pattern: "/api/internal/employee-titles/:id", handler: r_internal_employee_titles_id },
  { pattern: "/api/internal/journal-entries/:id", handler: r_internal_journal_entries_id },
  { pattern: "/api/internal/purchase-orders/:id", handler: r_internal_purchase_orders_id },
  { pattern: "/api/internal/approval-rules/:id", handler: r_internal_approval_rules_id },
  { pattern: "/api/internal/b2b-price-list/:id", handler: r_internal_b2b_price_list_id },
  { pattern: "/api/internal/workflow-rules/:id", handler: r_internal_workflow_rules_id },
  { pattern: "/api/internal/bank-accounts/:id", handler: r_internal_bank_accounts_id },
  { pattern: "/api/internal/payment-terms/:id", handler: r_internal_payment_terms_id },
  { pattern: "/api/internal/sales-returns/:id", handler: r_internal_sales_returns_id },
  { pattern: "/api/internal/service-items/:id", handler: r_internal_service_items_id },
  { pattern: "/api/internal/tpl-shipments/:id", handler: r_internal_tpl_shipments_id },
  { pattern: "/api/internal/vendor-master/:id", handler: r_internal_vendor_master_id },
  { pattern: "/api/internal/b2b-accounts/:id", handler: r_internal_b2b_accounts_id },
  { pattern: "/api/internal/build-orders/:id", handler: r_internal_build_orders_id },
  { pattern: "/api/internal/date-presets/:id", handler: r_internal_date_presets_id },
  { pattern: "/api/internal/edi-messages/:id", handler: r_internal_edi_messages_id },
  { pattern: "/api/internal/fabric-codes/:id", handler: r_internal_fabric_codes_id },
  { pattern: "/api/internal/fabric-mills/:id", handler: r_internal_fabric_mills_id },
  { pattern: "/api/internal/fixed-assets/:id", handler: r_internal_fixed_assets_id },
  { pattern: "/api/internal/sales-orders/:id", handler: r_internal_sales_orders_id },
  { pattern: "/api/internal/scf-programs/:id", handler: r_internal_scf_programs_id },
  { pattern: "/api/internal/style-master/:id", handler: r_internal_style_master_id },
  { pattern: "/api/vendor/sustainability/:id", handler: r_vendor_sustainability_id },
  { pattern: "/api/internal/ap-invoices/:id", handler: r_internal_ap_invoices_id },
  { pattern: "/api/internal/ar-invoices/:id", handler: r_internal_ar_invoices_id },
  { pattern: "/api/internal/ar-receipts/:id", handler: r_internal_ar_receipts_id },
  { pattern: "/api/internal/chargebacks/:id", handler: r_internal_chargebacks_id },
  { pattern: "/api/internal/gl-accounts/:id", handler: r_internal_gl_accounts_id },
  { pattern: "/api/internal/part-master/:id", handler: r_internal_part_master_id },
  { pattern: "/api/internal/price-lists/:id", handler: r_internal_price_lists_id },
  { pattern: "/api/internal/rma-reasons/:id", handler: r_internal_rma_reasons_id },
  { pattern: "/api/internal/size-scales/:id", handler: r_internal_size_scales_id },
  { pattern: "/api/marketplace/listings/:id", handler: r_marketplace_listings_id },
  { pattern: "/api/internal/gl-periods/:id", handler: r_internal_gl_periods_id },
  { pattern: "/api/internal/part-types/:id", handler: r_internal_part_types_id },
  { pattern: "/api/internal/warehouses/:id", handler: r_internal_warehouses_id },
  { pattern: "/api/internal/workspaces/:id", handler: r_internal_workspaces_id_index },
  { pattern: "/api/edi/inbound/:vendor_id", handler: r_edi_inbound_vendor_id },
  { pattern: "/api/internal/anomalies/:id", handler: r_internal_anomalies_id },
  { pattern: "/api/internal/contracts/:id", handler: r_internal_contracts_id_index },
  { pattern: "/api/internal/countries/:id", handler: r_internal_countries_id },
  { pattern: "/api/internal/drop-ship/:id", handler: r_internal_drop_ship_id },
  { pattern: "/api/internal/employees/:id", handler: r_internal_employees_id },
  { pattern: "/api/internal/hts-codes/:id", handler: r_internal_hts_codes_id },
  { pattern: "/api/vendor/attachments/:id", handler: r_vendor_attachments_id },
  { pattern: "/api/internal/api-keys/:id", handler: r_internal_api_keys_id },
  { pattern: "/api/internal/carriers/:id", handler: r_internal_carriers_id },
  { pattern: "/api/internal/disputes/:id", handler: r_internal_disputes_id_index },
  { pattern: "/api/internal/insights/:id", handler: r_internal_insights_id },
  { pattern: "/api/internal/mfg-boms/:id", handler: r_internal_mfg_boms_id },
  { pattern: "/api/internal/payments/:id", handler: r_internal_payments_id_index },
  { pattern: "/api/vendor/workspaces/:id", handler: r_vendor_workspaces_id_index },
  { pattern: "/api/internal/factors/:id", handler: r_internal_factors_id },
  { pattern: "/api/internal/genders/:id", handler: r_internal_genders_id },
  { pattern: "/api/internal/seasons/:id", handler: r_internal_seasons_id },
  { pattern: "/api/internal/vendors/:id", handler: r_internal_vendors_id_index },
  { pattern: "/api/vendor/contracts/:id", handler: r_vendor_contracts_id_index },
  { pattern: "/api/vendor/shipments/:id", handler: r_vendor_shipments_id },
  { pattern: "/api/internal/colors/:id", handler: r_internal_colors_id },
  { pattern: "/api/vendor/api-keys/:id", handler: r_vendor_api_keys_id_index },
  { pattern: "/api/vendor/disputes/:id", handler: r_vendor_disputes_id_index },
  { pattern: "/api/vendor/invoices/:id", handler: r_vendor_invoices_id },
  { pattern: "/api/internal/cases/:id", handler: r_internal_cases_id },
  { pattern: "/api/internal/rfqs/:id", handler: r_internal_rfqs_id_index },
  { pattern: "/api/vendor/bulk/:id", handler: r_vendor_bulk_id_index },
  { pattern: "/api/vendor/rfqs/:id", handler: r_vendor_rfqs_id_index },
  { pattern: "/api/b2b/orders/:id", handler: r_b2b_orders_id },
  { pattern: "/api/internal/inventory-purchased-detail", handler: r_internal_inventory_purchased_detail },
  { pattern: "/api/internal/income-statement-monthly", handler: r_internal_income_statement_monthly_index },
  { pattern: "/api/internal/notification-preferences", handler: r_internal_notification_preferences_index },
  { pattern: "/api/cron/xoro-mirror-backfill-worker", handler: r_cron_xoro_mirror_backfill_worker },
  { pattern: "/api/cron/customer-contact-reminders", handler: r_cron_customer_contact_reminders },
  { pattern: "/api/cron/walmart-settlements-weekly", handler: r_cron_walmart_settlements_weekly },
  { pattern: "/api/internal/customer-contact-notes", handler: r_internal_customer_contact_notes_index },
  { pattern: "/api/internal/inventory-cycle-counts", handler: r_internal_inventory_cycle_counts_index },
  { pattern: "/api/internal/style-customer-numbers", handler: r_internal_style_customer_numbers_index },
  { pattern: "/api/cron/notification-digest-flush", handler: r_cron_notification_digest_flush },
  { pattern: "/api/internal/inventory-adjustments", handler: r_internal_inventory_adjustments_index },
  { pattern: "/api/internal/inventory-sold-detail", handler: r_internal_inventory_sold_detail },
  { pattern: "/api/internal/phase-change-requests", handler: r_internal_phase_change_requests_index },
  { pattern: "/api/internal/style-classifications", handler: r_internal_style_classifications_index },
  { pattern: "/api/cron/shopify-refunds-backfill", handler: r_cron_shopify_refunds_backfill },
  { pattern: "/api/cron/workspace-tasks-due-soon", handler: r_cron_workspace_tasks_due_soon },
  { pattern: "/api/internal/employee-departments", handler: r_internal_employee_departments_index },
  { pattern: "/api/cron/early-payment-analytics", handler: r_cron_early_payment_analytics },
  { pattern: "/api/cron/inventory-cost-backfill", handler: r_cron_inventory_cost_backfill },
  { pattern: "/api/internal/inventory-transfers", handler: r_internal_inventory_transfers_index },
  { pattern: "/api/internal/workflow-executions", handler: r_internal_workflow_executions_index },
  { pattern: "/api/cron/crm-tasks-due-tomorrow", handler: r_cron_crm_tasks_due_tomorrow },
  { pattern: "/api/cron/fba-settlements-weekly", handler: r_cron_fba_settlements_weekly },
  { pattern: "/api/cron/inventory-onhand-check", handler: r_cron_inventory_onhand_check },
  { pattern: "/api/cron/walmart-orders-nightly", handler: r_cron_walmart_orders_nightly },
  { pattern: "/api/cron/xoro-feed-health-alert", handler: r_cron_xoro_feed_health_alert },
  { pattern: "/api/internal/adjustment-reasons", handler: r_internal_adjustment_reasons_index },
  { pattern: "/api/internal/buyer-scope-master", handler: r_internal_buyer_scope_master_index },
  { pattern: "/api/internal/customer-locations", handler: r_internal_customer_locations_index },
  { pattern: "/api/internal/customer-scorecard", handler: r_internal_customer_scorecard_index },
  { pattern: "/api/internal/inventory-snapshot", handler: r_internal_inventory_snapshot },
  { pattern: "/api/internal/style-fabric-codes", handler: r_internal_style_fabric_codes_index },
  { pattern: "/api/cron/ai-proactive-insights", handler: r_cron_ai_proactive_insights },
  { pattern: "/api/cron/ap-paid-delta-watcher", handler: r_cron_ap_paid_delta_watcher },
  { pattern: "/api/cron/ar-receipts-reconcile", handler: r_cron_ar_receipts_reconcile },
  { pattern: "/api/cron/compliance-automation", handler: r_cron_compliance_automation },
  { pattern: "/api/cron/discount-offers-daily", handler: r_cron_discount_offers_daily },
  { pattern: "/api/cron/faire-payouts-monthly", handler: r_cron_faire_payouts_monthly },
  { pattern: "/api/cron/health-scores-monthly", handler: r_cron_health_scores_monthly },
  { pattern: "/api/cron/insights-digest-daily", handler: r_cron_insights_digest_daily },
  { pattern: "/api/cron/ip-integration-health", handler: r_cron_ip_integration_health },
  { pattern: "/api/cron/shopify-payouts-daily", handler: r_cron_shopify_payouts_daily },
  { pattern: "/api/cron/walmart-returns-daily", handler: r_cron_walmart_returns_daily },
  { pattern: "/api/internal/approval-requests", handler: r_internal_approval_requests_index },
  { pattern: "/api/internal/bank-transactions", handler: r_internal_bank_transactions_index },
  { pattern: "/api/internal/preferred-vendors", handler: r_internal_preferred_vendors_index },
  { pattern: "/api/internal/sales-by-customer", handler: r_internal_sales_by_customer_index },
  { pattern: "/api/sales/upload-payment-state", handler: r_sales_upload_payment_state },
  { pattern: "/api/vendor/payment-preferences", handler: r_vendor_payment_preferences_index },
  { pattern: "/api/cron/faire-orders-nightly", handler: r_cron_faire_orders_nightly },
  { pattern: "/api/cron/faire-returns-weekly", handler: r_cron_faire_returns_weekly },
  { pattern: "/api/cron/ip-freshness-refresh", handler: r_cron_ip_freshness_refresh },
  { pattern: "/api/internal/adjustment-types", handler: r_internal_adjustment_types_index },
  { pattern: "/api/internal/income-statement", handler: r_internal_income_statement_index },
  { pattern: "/api/internal/part-adjustments", handler: r_internal_part_adjustments_index },
  { pattern: "/api/internal/prepack-matrices", handler: r_internal_prepack_matrices_index },
  { pattern: "/api/internal/price-list-items", handler: r_internal_price_list_items_index },
  { pattern: "/api/internal/price-promotions", handler: r_internal_price_promotions_index },
  { pattern: "/api/internal/transfer-reasons", handler: r_internal_transfer_reasons_index },
  { pattern: "/api/internal/vendor-scorecard", handler: r_internal_vendor_scorecard_index },
  { pattern: "/api/internal/xoro-mirror-runs", handler: r_internal_xoro_mirror_runs },
  { pattern: "/api/planning/sync-onhand-xoro", handler: r_planning_sync_onhand_xoro },
  { pattern: "/api/vendor/ai-extract-invoice", handler: r_vendor_ai_extract_invoice },
  { pattern: "/api/vendor/payment-preference", handler: r_vendor_payment_preference_index },
  { pattern: "/api/cron/bank-auto-post-fees", handler: r_cron_bank_auto_post_fees },
  { pattern: "/api/cron/fba-inventory-daily", handler: r_cron_fba_inventory_daily },
  { pattern: "/api/cron/xoro-mirror-nightly", handler: r_cron_xoro_mirror_nightly },
  { pattern: "/api/internal/ats-size-matrix", handler: r_internal_ats_size_matrix },
  { pattern: "/api/internal/bank-recon-runs", handler: r_internal_bank_recon_runs_index },
  { pattern: "/api/internal/customer-buyers", handler: r_internal_customer_buyers_index },
  { pattern: "/api/internal/customer-master", handler: r_internal_customer_master_index },
  { pattern: "/api/internal/discount-offers", handler: r_internal_discount_offers_index },
  { pattern: "/api/internal/employee-titles", handler: r_internal_employee_titles_index },
  { pattern: "/api/internal/journal-entries", handler: r_internal_journal_entries_index },
  { pattern: "/api/internal/purchase-orders", handler: r_internal_purchase_orders_index },
  { pattern: "/api/tanda/sync-sos-from-xoro", handler: r_tanda_sync_sos_from_xoro },
  { pattern: "/api/vendor/diversity-profile", handler: r_vendor_diversity_profile_index },
  { pattern: "/api/cron/fba-orders-nightly", handler: r_cron_fba_orders_nightly },
  { pattern: "/api/cron/scorecards-monthly", handler: r_cron_scorecards_monthly },
  { pattern: "/api/cron/tpl-inventory-pull", handler: r_cron_tpl_inventory_pull },
  { pattern: "/api/internal/approval-rules", handler: r_internal_approval_rules_index },
  { pattern: "/api/internal/ar-collections", handler: r_internal_ar_collections_index },
  { pattern: "/api/internal/b2b-price-list", handler: r_internal_b2b_price_list_index },
  { pattern: "/api/internal/data-freshness", handler: r_internal_data_freshness },
  { pattern: "/api/internal/part-inventory", handler: r_internal_part_inventory_index },
  { pattern: "/api/internal/part-purchases", handler: r_internal_part_purchases_index },
  { pattern: "/api/internal/sustainability", handler: r_internal_sustainability_index },
  { pattern: "/api/internal/vendor-invites", handler: r_internal_vendor_invites_index },
  { pattern: "/api/internal/workflow-rules", handler: r_internal_workflow_rules_index },
  { pattern: "/api/webhooks/resend-inbound", handler: r_webhooks_resend_inbound },
  { pattern: "/api/xoro/inventory-snapshot", handler: r_xoro_inventory_snapshot },
  { pattern: "/api/cron/anomalies-nightly", handler: r_cron_anomalies_nightly },
  { pattern: "/api/cron/app-errors-digest", handler: r_cron_app_errors_digest },
  { pattern: "/api/cron/ar-payload-ingest", handler: r_cron_ar_payload_ingest },
  { pattern: "/api/cron/benchmark-compute", handler: r_cron_benchmark_compute },
  { pattern: "/api/cron/edi-3pl-transport", handler: r_cron_edi_3pl_transport },
  { pattern: "/api/cron/fba-returns-daily", handler: r_cron_fba_returns_daily },
  { pattern: "/api/internal/balance-sheet", handler: r_internal_balance_sheet_index },
  { pattern: "/api/internal/bank-accounts", handler: r_internal_bank_accounts_index },
  { pattern: "/api/internal/client-errors", handler: r_internal_client_errors },
  { pattern: "/api/internal/global-search", handler: r_internal_global_search_index },
  { pattern: "/api/internal/notifications", handler: r_internal_notifications_index },
  { pattern: "/api/internal/payment-terms", handler: r_internal_payment_terms_index },
  { pattern: "/api/internal/sales-returns", handler: r_internal_sales_returns_index },
  { pattern: "/api/internal/service-items", handler: r_internal_service_items_index },
  { pattern: "/api/internal/tpl-providers", handler: r_internal_tpl_providers_index },
  { pattern: "/api/internal/tpl-shipments", handler: r_internal_tpl_shipments_index },
  { pattern: "/api/internal/trial-balance", handler: r_internal_trial_balance_index },
  { pattern: "/api/internal/vendor-access", handler: r_internal_vendor_access_index },
  { pattern: "/api/internal/vendor-master", handler: r_internal_vendor_master_index },
  { pattern: "/api/internal/virtual-cards", handler: r_internal_virtual_cards_index },
  { pattern: "/api/password-reset/confirm", handler: r_password_reset_confirm },
  { pattern: "/api/password-reset/request", handler: r_password_reset_request },
  { pattern: "/api/planning/sync-open-pos", handler: r_planning_sync_open_pos },
  { pattern: "/api/planning/sync-receipts", handler: r_planning_sync_receipts },
  { pattern: "/api/vendor/change-requests", handler: r_vendor_change_requests },
  { pattern: "/api/vendor/discount-offers", handler: r_vendor_discount_offers_index },
  { pattern: "/api/xoro/sync-item-costing", handler: r_xoro_sync_item_costing },
  { pattern: "/api/cron/bank-mirror-sync", handler: r_cron_bank_mirror_sync },
  { pattern: "/api/cron/compliance-daily", handler: r_cron_compliance_daily },
  { pattern: "/api/cron/menu-usage-decay", handler: r_cron_menu_usage_decay },
  { pattern: "/api/cron/po-issued-notify", handler: r_cron_po_issued_notify },
  { pattern: "/api/cron/shopify-backfill", handler: r_cron_shopify_backfill },
  { pattern: "/api/cron/subledger-tieout", handler: r_cron_subledger_tieout },
  { pattern: "/api/internal/b2b-accounts", handler: r_internal_b2b_accounts_index },
  { pattern: "/api/internal/budget-range", handler: r_internal_budget_range_index },
  { pattern: "/api/internal/build-orders", handler: r_internal_build_orders_index },
  { pattern: "/api/internal/date-presets", handler: r_internal_date_presets_index },
  { pattern: "/api/internal/edi-messages", handler: r_internal_edi_messages_index },
  { pattern: "/api/internal/edi-partners", handler: r_internal_edi_partners_index },
  { pattern: "/api/internal/fabric-codes", handler: r_internal_fabric_codes_index },
  { pattern: "/api/internal/fabric-mills", handler: r_internal_fabric_mills_index },
  { pattern: "/api/internal/finance-kpis", handler: r_internal_finance_kpis_index },
  { pattern: "/api/internal/fixed-assets", handler: r_internal_fixed_assets_index },
  { pattern: "/api/internal/ip-ai-demand", handler: r_internal_ip_ai_demand_index },
  { pattern: "/api/internal/sales-by-rep", handler: r_internal_sales_by_rep_index },
  { pattern: "/api/internal/sales-orders", handler: r_internal_sales_orders_index },
  { pattern: "/api/internal/scf-programs", handler: r_internal_scf_programs_index },
  { pattern: "/api/internal/style-master", handler: r_internal_style_master_index },
  { pattern: "/api/internal/style-matrix", handler: r_internal_style_matrix_index },
  { pattern: "/api/internal/style-orders", handler: r_internal_style_orders_index },
  { pattern: "/api/internal/users-access", handler: r_internal_users_access_index },
  { pattern: "/api/planning/sync-on-hand", handler: r_planning_sync_on_hand },
  { pattern: "/api/vendor/sustainability", handler: r_vendor_sustainability_index },
  { pattern: "/api/cron/contracts-daily", handler: r_cron_contracts_daily },
  { pattern: "/api/cron/insights-weekly", handler: r_cron_insights_weekly },
  { pattern: "/api/cron/three-way-match", handler: r_cron_three_way_match },
  { pattern: "/api/internal/allocations", handler: r_internal_allocations_index },
  { pattern: "/api/internal/ap-invoices", handler: r_internal_ap_invoices_index },
  { pattern: "/api/internal/ap-payments", handler: r_internal_ap_payments_index },
  { pattern: "/api/internal/ar-invoices", handler: r_internal_ar_invoices_index },
  { pattern: "/api/internal/ar-receipts", handler: r_internal_ar_receipts_index },
  { pattern: "/api/internal/ats-by-size", handler: r_internal_ats_by_size },
  { pattern: "/api/internal/chargebacks", handler: r_internal_chargebacks_index },
  { pattern: "/api/internal/gl-accounts", handler: r_internal_gl_accounts_index },
  { pattern: "/api/internal/mfg-reports", handler: r_internal_mfg_reports_index },
  { pattern: "/api/internal/part-master", handler: r_internal_part_master_index },
  { pattern: "/api/internal/part-matrix", handler: r_internal_part_matrix_index },
  { pattern: "/api/internal/part-thumbs", handler: r_internal_part_thumbs },
  { pattern: "/api/internal/phase-notes", handler: r_internal_phase_notes_index },
  { pattern: "/api/internal/price-lists", handler: r_internal_price_lists_index },
  { pattern: "/api/internal/rma-reasons", handler: r_internal_rma_reasons_index },
  { pattern: "/api/internal/size-scales", handler: r_internal_size_scales_index },
  { pattern: "/api/marketplace/listings", handler: r_marketplace_listings_index },
  { pattern: "/api/sales/backfill-grain", handler: r_sales_backfill_grain },
  { pattern: "/api/tanda/sync-from-xoro", handler: r_tanda_sync_from_xoro },
  { pattern: "/api/vendor/accept-invite", handler: r_vendor_accept_invite },
  { pattern: "/api/vendor/virtual-cards", handler: r_vendor_virtual_cards_index },
  { pattern: "/api/cron/bank-feed-sync", handler: r_cron_bank_feed_sync },
  { pattern: "/api/internal/categories", handler: r_internal_categories_index },
  { pattern: "/api/internal/compliance", handler: r_internal_compliance_index },
  { pattern: "/api/internal/esg-scores", handler: r_internal_esg_scores_index },
  { pattern: "/api/internal/gl-periods", handler: r_internal_gl_periods_index },
  { pattern: "/api/internal/onboarding", handler: r_internal_onboarding_index },
  { pattern: "/api/internal/part-types", handler: r_internal_part_types_index },
  { pattern: "/api/internal/sales-reps", handler: r_internal_sales_reps_index },
  { pattern: "/api/internal/scorecards", handler: r_internal_scorecards_index },
  { pattern: "/api/internal/segment-pl", handler: r_internal_segment_pl_index },
  { pattern: "/api/internal/warehouses", handler: r_internal_warehouses_index },
  { pattern: "/api/internal/workspaces", handler: r_internal_workspaces_index },
  { pattern: "/api/sales/sync-invoices", handler: r_sales_sync_invoices },
  { pattern: "/api/shopify/collections", handler: r_shopify_collections },
  { pattern: "/api/cron/push-delivery", handler: r_cron_push_delivery },
  { pattern: "/api/internal/anomalies", handler: r_internal_anomalies_index },
  { pattern: "/api/internal/cash-flow", handler: r_internal_cash_flow_index },
  { pattern: "/api/internal/contracts", handler: r_internal_contracts_index },
  { pattern: "/api/internal/countries", handler: r_internal_countries_index },
  { pattern: "/api/internal/documents", handler: r_internal_documents_index },
  { pattern: "/api/internal/drop-ship", handler: r_internal_drop_ship_index },
  { pattern: "/api/internal/employees", handler: r_internal_employees_index },
  { pattern: "/api/internal/form-1099", handler: r_internal_form_1099_index },
  { pattern: "/api/internal/gl-detail", handler: r_internal_gl_detail_index },
  { pattern: "/api/internal/hts-codes", handler: r_internal_hts_codes_index },
  { pattern: "/api/internal/upc-items", handler: r_internal_upc_items_index },
  { pattern: "/api/vendor/attachments", handler: r_vendor_attachments_index },
  { pattern: "/api/xoro/probe-filters", handler: r_xoro_probe_filters },
  { pattern: "/api/xoro/sales-history", handler: r_xoro_sales_history },
  { pattern: "/api/cron/fx-rate-sync", handler: r_cron_fx_rate_sync },
  { pattern: "/api/cron/ip-normalize", handler: r_cron_ip_normalize },
  { pattern: "/api/internal/ap-aging", handler: r_internal_ap_aging_index },
  { pattern: "/api/internal/api-keys", handler: r_internal_api_keys_index },
  { pattern: "/api/internal/ar-aging", handler: r_internal_ar_aging_index },
  { pattern: "/api/internal/carriers", handler: r_internal_carriers_index },
  { pattern: "/api/internal/channels", handler: r_internal_channels_index },
  { pattern: "/api/internal/disputes", handler: r_internal_disputes_index },
  { pattern: "/api/internal/entities", handler: r_internal_entities_index },
  { pattern: "/api/internal/insights", handler: r_internal_insights_index },
  { pattern: "/api/internal/mfg-boms", handler: r_internal_mfg_boms_index },
  { pattern: "/api/internal/payments", handler: r_internal_payments_index },
  { pattern: "/api/shopify/inventory", handler: r_shopify_inventory },
  { pattern: "/api/vendor/compliance", handler: r_vendor_compliance_index },
  { pattern: "/api/vendor/onboarding", handler: r_vendor_onboarding_index },
  { pattern: "/api/vendor/workspaces", handler: r_vendor_workspaces_index },
  { pattern: "/api/internal/budgets", handler: r_internal_budgets_index },
  { pattern: "/api/internal/factors", handler: r_internal_factors_index },
  { pattern: "/api/internal/genders", handler: r_internal_genders_index },
  { pattern: "/api/internal/seasons", handler: r_internal_seasons_index },
  { pattern: "/api/internal/vendors", handler: r_internal_vendors_index },
  { pattern: "/api/shopify/products", handler: r_shopify_products },
  { pattern: "/api/tanda/upload-sos", handler: r_tanda_upload_sos },
  { pattern: "/api/vendor/contracts", handler: r_vendor_contracts_index },
  { pattern: "/api/vendor/esg-score", handler: r_vendor_esg_score_index },
  { pattern: "/api/vendor/scorecard", handler: r_vendor_scorecard },
  { pattern: "/api/vendor/shipments", handler: r_vendor_shipments },
  { pattern: "/api/vendor/translate", handler: r_vendor_translate },
  { pattern: "/api/internal/brands", handler: r_internal_brands_index },
  { pattern: "/api/internal/colors", handler: r_internal_colors_index },
  { pattern: "/api/internal/search", handler: r_internal_search_index },
  { pattern: "/api/internal/states", handler: r_internal_states_index },
  { pattern: "/api/shopify/returns", handler: r_shopify_returns },
  { pattern: "/api/vendor/api-keys", handler: r_vendor_api_keys_index },
  { pattern: "/api/vendor/disputes", handler: r_vendor_disputes_index },
  { pattern: "/api/vendor/entities", handler: r_vendor_entities },
  { pattern: "/api/vendor/i18n-geo", handler: r_vendor_i18n_geo },
  { pattern: "/api/vendor/invoices", handler: r_vendor_invoices },
  { pattern: "/api/vendor/payments", handler: r_vendor_payments_index },
  { pattern: "/api/internal/cases", handler: r_internal_cases_index },
  { pattern: "/api/internal/items", handler: r_internal_items_index },
  { pattern: "/api/shopify/orders", handler: r_shopify_orders },
  { pattern: "/api/vendor/banking", handler: r_vendor_banking },
  { pattern: "/api/webhooks/plaid", handler: r_webhooks_plaid },
  { pattern: "/api/ap/sync-bills", handler: r_ap_sync_bills },
  { pattern: "/api/internal/rfqs", handler: r_internal_rfqs_index },
  { pattern: "/api/xoro/open-pos", handler: r_xoro_open_pos },
  { pattern: "/api/xoro/receipts", handler: r_xoro_receipts },
  { pattern: "/api/internal/tax", handler: r_internal_tax_index },
  { pattern: "/api/xoro/sync-gl", handler: r_xoro_sync_gl },
  { pattern: "/api/ai/ask-grid", handler: r_ai_ask_grid },
  { pattern: "/api/b2b/account", handler: r_b2b_account },
  { pattern: "/api/b2b/catalog", handler: r_b2b_catalog },
  { pattern: "/api/b2b/session", handler: r_b2b_session },
  { pattern: "/api/edi/inbound", handler: r_edi_inbound_index },
  { pattern: "/api/master/sync", handler: r_master_sync },
  { pattern: "/api/vendor/bulk", handler: r_vendor_bulk_index },
  { pattern: "/api/vendor/rfqs", handler: r_vendor_rfqs_index },
  { pattern: "/api/ats/upload", handler: r_ats_upload },
  { pattern: "/api/b2b/orders", handler: r_b2b_orders_index },
  { pattern: "/api/vendor/erp", handler: r_vendor_erp },
  { pattern: "/api/xoro/items", handler: r_xoro_items },
  { pattern: "/api/xoro-items-missing-sync", handler: r_xoro_items_missing_sync },
  { pattern: "/api/xoro-receipts-sync", handler: r_xoro_receipts_sync },
  { pattern: "/api/send-notification", handler: r_send_notification },
  { pattern: "/api/ats-supply-sync", handler: r_ats_supply_sync },
  { pattern: "/api/xoro-sales-sync", handler: r_xoro_sales_sync },
  { pattern: "/api/searates-proxy", handler: r_searates_proxy },
  { pattern: "/api/tanda-pos-sync", handler: r_tanda_pos_sync },
  { pattern: "/api/dropbox-proxy", handler: r_dropbox_proxy },
  { pattern: "/api/vendor-invite", handler: r_vendor_invite },
  { pattern: "/api/xoro-ap-sync", handler: r_xoro_ap_sync },
  { pattern: "/api/parse-excel", handler: r_parse_excel },
  { pattern: "/api/xoro-proxy", handler: r_xoro_proxy },
];

export function compileRoutes(routes) {
  return routes.map((r) => {
    const segs = r.pattern.split("/").filter(Boolean);
    const params = [];
    const regexParts = segs.map((seg) => {
      if (seg.startsWith(":")) { params.push(seg.slice(1)); return "([^/]+)"; }
      if (seg.startsWith("*")) { params.push(seg.slice(1)); return "(.+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    const regex = new RegExp("^/" + regexParts.join("/") + "/?$");
    return { ...r, regex, params };
  });
}
