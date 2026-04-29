// Per-app event_type allowlists.
//
// Notifications are stored in a single `notifications` table — they're
// not tagged with a source app. This file maps event types to the
// app(s) that should display them, so each app's bell + inbox shows
// only what's relevant.
//
// `null` means "show everything" — used by the PLM launcher and the
// vendor portal (vendor uses `kind="vendor"` for recipient scoping
// instead of event-type filtering).

export type AppKey =
  | "tanda"
  | "design"
  | "ats"
  | "techpack"
  | "gs1"
  | "planning"
  | "rof"
  | "plm"
  | "vendor";

// PO WIP — anything procurement-, supplier-, or PO-related.
const TANDA_EVENTS = [
  "po_issued", "po_received", "po_acknowledged", "po_changed",
  "phase_change_proposed", "phase_change_approved", "phase_change_rejected", "phase_change_reopened",
  "invoice_submitted", "invoice_approved", "invoice_discrepancy", "invoice_rejected",
  "payment_sent", "payment_failed",
  "shipment_created", "shipment_delivered", "shipment_delayed",
  "compliance_expiring_soon", "compliance_submitted", "compliance_approved", "compliance_rejected",
  "onboarding_submitted", "onboarding_approved", "onboarding_rejected",
  "rfq_invited", "rfq_awarded", "rfq_published", "rfq_closed", "rfq_quote_received",
  "anomaly_detected",
  "discount_offer_made", "discount_offer_accepted",
  "scf_funded", "scf_requested",
  "dispute_opened", "dispute_message", "dispute_resolved",
  "contract_expiring_soon", "contract_signed", "contract_terminated",
  "new_message",
  "workflow_executed", "workflow_failed",
  "fx_rate_alert",
  "tax_form_due",
  "virtual_card_issued",
  "vendor_flagged",
  "scorecard_updated",
  "health_score_dropped",
];

// Design Calendar — task / collection / calendar events.
const DESIGN_EVENTS = [
  "workspace_task_assigned", "workspace_task_due_soon", "workspace_task_overdue",
  "task_assigned", "task_due_soon", "task_overdue", "task_completed",
  "collection_deadline", "collection_created", "collection_phase_changed",
  "design_review_requested",
];

// ATS — uploads, inventory, and PO receiving.
const ATS_EVENTS = [
  "ats_upload_complete", "ats_upload_failed",
  "po_received", "shipment_delivered",
  "inventory_anomaly",
];

// Tech Packs — design spec updates.
const TECHPACK_EVENTS = [
  "techpack_revision_requested", "techpack_approved", "techpack_rejected",
];

// GS1 — label generation.
const GS1_EVENTS = [
  "gs1_label_generated", "gs1_export_complete",
];

// Inventory Planning — forecast / scenario / batch / data-quality events.
const PLANNING_EVENTS = [
  "planning_forecast_ready", "planning_forecast_failed",
  "planning_run_complete", "planning_run_failed",
  "planning_scenario_created", "planning_scenario_approved", "planning_scenario_rejected",
  "planning_execution_batch_ready", "planning_execution_batch_committed",
  "planning_data_quality_alert", "planning_data_quality_resolved",
  "planning_recommendation_ready", "planning_recommendation_overridden",
  "planning_reconciliation_complete",
  "planning_accuracy_report_ready",
  "planning_approval_requested", "planning_approval_granted", "planning_approval_rejected",
  "planning_export_complete",
  "inventory_anomaly",
];

// ROF Phase Reviews — only the pending-review event.
const ROF_EVENTS = [
  "phase_change_proposed",
];

const APP_EVENTS: Record<AppKey, string[] | null> = {
  tanda: TANDA_EVENTS,
  design: DESIGN_EVENTS,
  ats: ATS_EVENTS,
  techpack: TECHPACK_EVENTS,
  gs1: GS1_EVENTS,
  planning: PLANNING_EVENTS,
  rof: ROF_EVENTS,
  plm: null,
  vendor: null,
};

export function eventMatchesApp(eventType: string, app: AppKey): boolean {
  const allowed = APP_EVENTS[app];
  if (allowed === null) return true;
  return allowed.includes(eventType);
}

export function appAllowedEvents(app: AppKey): string[] | null {
  return APP_EVENTS[app];
}
