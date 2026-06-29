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
  | "costing"
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
  "rfq_invited", "rfq_awarded", "rfq_awarded_internal", "rfq_published", "rfq_closed", "rfq_quote_received",
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
  "production_order_requested",
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

// Costing — the RFQ lifecycle (RFQs are created, compared, and awarded from the
// Costing app). These show in the Costing app's bell and are kept OFF the PLM
// launcher (see PLM_HIDDEN) so RFQ noise doesn't pile up on the home screen.
const COSTING_EVENTS = [
  "rfq_quote_submitted", "rfq_quote_revised", "rfq_quote_received",
  "rfq_revised", "rfq_message",
  "rfq_invited", "rfq_published", "rfq_closed",
  "rfq_awarded", "rfq_awarded_internal",
];

const APP_EVENTS: Record<AppKey, string[] | null> = {
  tanda: TANDA_EVENTS,
  design: DESIGN_EVENTS,
  ats: ATS_EVENTS,
  techpack: TECHPACK_EVENTS,
  gs1: GS1_EVENTS,
  planning: PLANNING_EVENTS,
  rof: ROF_EVENTS,
  costing: COSTING_EVENTS,
  plm: null,
  vendor: null,
};

// Events that belong to the Costing app and should NOT clutter the PLM launcher
// bell. The launcher still shows everything else (null = show-all behavior).
const PLM_HIDDEN = new Set(COSTING_EVENTS);

export function eventMatchesApp(eventType: string, app: AppKey): boolean {
  // PLM launcher = show everything EXCEPT events owned by a dedicated app
  // (currently the Costing RFQ events — routed to the Costing bell instead).
  if (app === "plm") return !PLM_HIDDEN.has(eventType);
  const allowed = APP_EVENTS[app];
  if (allowed === null) return true;
  return allowed.includes(eventType);
}

export function appAllowedEvents(app: AppKey): string[] | null {
  return APP_EVENTS[app];
}

// Per-recipient app routing.
//
// An internal employee can choose which apps they receive in-app
// notifications in. When a notification is addressed to such an employee,
// the sender mirrors the employee's selected apps onto the row as
// `metadata.target_apps` (a string[] of AppKey values). A notification then
// shows in app X only when BOTH:
//   1. its event_type matches app X (eventMatchesApp), AND
//   2. target_apps is absent/null/empty/not-an-array (= all apps) OR includes X.
//
// Rows WITHOUT target_apps behave exactly as before (event-type filter only),
// so this is fully back-compat — existing and vendor-path notifications are
// unaffected.
export function targetAppsAllow(metadata: Record<string, unknown> | null | undefined, app: AppKey): boolean {
  const raw = metadata?.target_apps;
  if (raw == null) return true;            // absent/null → all apps
  if (!Array.isArray(raw)) return true;    // malformed → fail open (show)
  if (raw.length === 0) return true;       // empty → all apps
  return raw.includes(app);
}

// Combined predicate used by NotificationsShell + useAppUnreadCount: a
// notification is shown in `app` when its event matches AND its target_apps
// (if any) permits this app.
export function notificationMatchesApp(
  n: { event_type: string; metadata?: Record<string, unknown> | null },
  app: AppKey,
): boolean {
  return eventMatchesApp(n.event_type, app) && targetAppsAllow(n.metadata ?? null, app);
}
