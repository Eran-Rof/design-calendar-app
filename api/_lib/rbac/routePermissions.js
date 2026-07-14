// api/_lib/rbac/routePermissions.js
//
// P14 RBAC — central route → (module_key, action) registry.
//
// Maps an internal API path + HTTP method to the permission it requires. Used
// by the dispatcher's log-only observer (chunk 2) and, later, the chunk-3
// reject middleware. Centralising this (vs a codemod touching every handler)
// keeps the (module, action) declarations in one reviewable place; enforcement
// semantics are identical. Unmapped paths return null → the observer skips them
// (vendor/cron/public routes, and any internal route not yet catalogued).
//
// MODULE_ACTIONS mirrors the available_actions seeded in
// 20260707000000_p14_chunk1_rbac_schema.sql. We only ever emit a (module,
// action) the module actually exposes — so the observer never logs a
// "would-deny" for an action that exists for nobody (which would be noise,
// not signal).

const R = ["read"];
const RW = ["read", "write", "export"];
const RX = ["read", "export"];
const POSTABLE = ["read", "write", "post", "void", "export"];

export const MODULE_ACTIONS = {
  style_master: RW, product_master: RW, vendor_master: RW, customer_master: RW,
  coa: RW, gl_periods: POSTABLE, je_entry: RW, je_post: POSTABLE,
  ar_invoices: POSTABLE, ar_receipts: POSTABLE, ap_invoices: POSTABLE, ap_payments: POSTABLE,
  bank_recon: POSTABLE, inventory: RW, po_wip: RW, procurement: ["read", "write", "post", "export"],
  ats: RX, sales_comps: RX, costing: RW, gs1: RW, tech_pack: RW,
  shopify: RX, marketplaces: RX, parallel_run: RX, workflows: RW, notifications: RW,
  users_access: RW, audit_log: RX, analytics: RX, compliance: RW, sourcing: RW,
  finance_misc: RW, tenancy_admin: RW,
};

// Second path segment under /api/internal/ → module_key. Longest-prefix wins
// is unnecessary because we key on the single segment after /api/internal/.
const SEGMENT_MODULE = {
  "style-master": "style_master", "style-fabric-codes": "style_master",
  "pim": "product_master",
  "vendors": "vendor_master", "vendor-master": "vendor_master",
  "customers": "customer_master", "customer-master": "customer_master",
  "coa": "coa", "gl-accounts": "coa",
  "gl-periods": "gl_periods",
  // Month-End Close — per-period close checklist + period locking. Rides the
  // existing gl_periods module (POSTABLE: read/write/post/void/export) rather
  // than minting a new module_key: close/reopen ARE period-status management,
  // and reusing the seeded module keeps live-enforce RBAC working without new
  // role grants (admin + accountant already hold gl_periods post; viewer
  // reads). Reads=read, run-checks/sign-off=write, close/reopen=post (see the
  // action refinement in routePermissionFor).
  "month-end-close": "gl_periods",
  "journal-entries": "je_entry",
  "ar-invoices": "ar_invoices", "ar-receipts": "ar_receipts",
  "ap-invoices": "ap_invoices", "ap-payments": "ap_payments", "payments": "ap_payments",
  "bank-recon-runs": "bank_recon", "bank-transactions": "bank_recon", "bank-feeds": "bank_recon",
  "inventory-adjustments": "inventory", "inventory-cycle-counts": "inventory", "scanner": "inventory",
  "procurement": "procurement",
  "costing": "costing",
  "recon": "parallel_run", "xoro-mirror": "parallel_run",
  "shopify": "shopify", "disputes": "shopify",
  "fba": "marketplaces", "walmart": "marketplaces", "faire": "marketplaces", "marketplace": "marketplaces",
  "workflow-rules": "workflows", "workflow-executions": "workflows",
  "approval-requests": "workflows", "approval-rules": "workflows",
  "notifications": "notifications",
  // RBAC admin surface (matrix + role/override writes). NOTE: the bare "users"
  // segment is the PERSONALIZATION surface (/users/me/preferences, favorites,
  // entity-switch) — every signed-in user manages their OWN prefs, so it is
  // intentionally UNMAPPED (not gated). Only the distinct "users-access" admin
  // route requires the users_access permission.
  // P28 "assistant" segment (Today page aggregate + dismissals) is
  // deliberately UNMAPPED: like users-access/me the payload self-filters by
  // the CALLER'S own effective permissions (summary counts only), and every
  // drill target it links to is enforced on its own route. Gating it would
  // 403 the legacy PLM-session path that has no per-user JWT.
  "users-access": "users_access",
  "audit": "audit_log",
  "analytics": "analytics", "insights": "analytics", "scorecards": "analytics",
  // Factor Module (Rosenthal). Phase 1 mapped this to analytics (read-only
  // reports); Phase 2 adds the chargeback dispute PATCH, so the segment moves
  // to finance_misc (read/write/export) — GETs stay read-gated, the dispute
  // write is enforceable.
  "factor": "finance_misc",
  // Chargeback Management module (#1744). Same finance_misc class as factor:
  // GETs (worklist + dilution) are read-gated, the disposition/owner/reason
  // PATCH is write-gated.
  "chargebacks": "finance_misc",
  // 3-Way Match (PO <-> receipt <-> AP bill) — payables control. Reads +
  // the accept/dispute + re-run + tolerance writes gate on ap_invoices.
  "three-way-match": "ap_invoices",
  // Drill-through Phase 2 — aging bucket drill + Segment P&L GL drill. Same
  // read-only report class as scorecards (analytics = read + export).
  "ar-aging": "analytics", "ap-aging": "analytics", "segment-pl": "analytics",
  // Inventory On-Hand Accuracy monitor — read-only feed reconciliation report.
  "inventory-accuracy": "analytics",
  "compliance": "compliance", "sustainability": "compliance",
  "rfqs": "sourcing",
  "tax": "finance_misc", "scf": "finance_misc", "virtual-cards": "finance_misc",
  "discount-offers": "finance_misc", "contracts": "finance_misc",
  "entities": "tenancy_admin",
};

/**
 * @param {string} pathname e.g. "/api/internal/ar-invoices/123/post"
 * @param {string} method   HTTP method
 * @returns {{module: string, action: string} | null}
 */
export function routePermissionFor(pathname, method) {
  if (typeof pathname !== "string" || !pathname.startsWith("/api/internal/")) return null;
  // Self-read of one's OWN effective permissions (P14-4 menu hide). Must NOT be
  // gated on users_access — a viewer has to read their own perms to hide their
  // own menus. (It's a UX-only surface; the server still enforces every action.)
  if (/^\/api\/internal\/users-access\/me\/?$/.test(pathname)) return null;
  const seg = pathname.slice("/api/internal/".length).split("/")[0];
  let module = SEGMENT_MODULE[seg];
  if (!module) return null;

  const m = String(method || "GET").toUpperCase();
  let action;
  if (m === "GET" || m === "HEAD") action = "read";
  else if (/\/void(\/|$)/.test(pathname)) action = "void";
  else if (/\/(post|pay|approve|fund|settle)(\/|$)/.test(pathname)) action = "post";
  else if (seg === "month-end-close" && /\/(close|reopen)(\/|$)/.test(pathname)) action = "post"; // period lock/unlock = post-grade
  else action = "write"; // POST/PUT/PATCH/DELETE create/update

  // JE draft vs posting split: the journal-entries surface covers both, but
  // post/void belong to the je_post module (je_entry only does read/write).
  if (module === "je_entry" && (action === "post" || action === "void")) module = "je_post";

  // Clamp to what the module actually exposes; never emit a permission that
  // exists for nobody (e.g. a write on a read-only report module).
  const avail = MODULE_ACTIONS[module] || [];
  if (!avail.includes(action)) return null;
  return { module, action };
}
