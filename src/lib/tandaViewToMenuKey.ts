// Cross-cutter T4-3 — Tanda view-string → menu_key mapping.
//
// TandA.tsx tracks the active panel as a single `view` string (e.g.
// "dashboard", "vendors", "shipments"). The personalization registry
// (src/lib/menuKeys.ts) keys POWIP items as "powip/<area>/<slug>". This
// helper bridges the two so the nav onClick handlers can call
// `logClick(tandaViewToMenuKey(view))` without each click site having
// to know the full registry shape.
//
// Returns null for unknown views (e.g. internal-only views that aren't
// in the registry). Callers should silently no-op on null.

const MAP: Record<string, string> = {
  // Top-level nav
  dashboard:       "powip/dashboard",
  list:            "powip/list",
  grid:            "powip/grid",
  templates:       "powip/templates",
  teams:           "powip/teams",
  email:           "powip/email",
  activity:        "powip/activity",
  notifications:   "powip/notifications",
  timeline:        "powip/timeline",
  archive:         "powip/archive",

  // Vendors flyout
  vendors:               "powip/vendors/directory",
  onboarding:            "powip/vendors/onboarding",
  preferred_vendors:     "powip/vendors/preferred",
  scorecards:            "powip/vendors/scorecards",
  health_scores:         "powip/vendors/health-scores",
  diversity:             "powip/vendors/diversity",
  sustainability:        "powip/vendors/sustainability",
  esg_scores:            "powip/vendors/esg-scores",

  // Operations
  shipments:             "powip/ops/shipments",
  match:                 "powip/ops/match",
  messages:              "powip/ops/messages",
  phase_reviews:         "powip/ops/phase-reviews",
  anomalies:             "powip/ops/anomalies",
  workspaces:            "powip/ops/workspaces",

  // Compliance
  compliance:            "powip/compliance/documents",
  compliance_automation: "powip/compliance/automation",
  compliance_audit:      "powip/compliance/audit",

  // Sourcing
  rfqs:                       "powip/sourcing/rfqs",
  marketplace:                "powip/sourcing/marketplace",
  marketplace_inquiries:      "powip/sourcing/marketplace-inquiries",
  benchmark:                  "powip/sourcing/benchmark",
  insights:                   "powip/sourcing/insights",

  // Finance
  payments:               "powip/finance/payments",
  discount_offers:        "powip/finance/discount-offers",
  scf:                    "powip/finance/scf",
  virtual_cards:          "powip/finance/virtual-cards",
  fx:                     "powip/finance/fx",
  tax:                    "powip/finance/tax",

  // Analytics & Admin
  analytics:              "powip/admin/analytics",
  spend:                  "powip/admin/spend",
  workflow_rules:         "powip/admin/workflow-rules",
  workflow_executions:    "powip/admin/workflow-executions",
  entities:               "powip/admin/entities",
};

/**
 * Maps a TandA view string to the corresponding menu_key in the
 * personalization registry, or null when the view isn't tracked.
 */
export function tandaViewToMenuKey(view: string | null | undefined): string | null {
  if (!view) return null;
  return MAP[view] ?? null;
}
