// localStorage helpers extracted from WholesalePlanningWorkbench.
//
// All persistence the planner-facing workbench cares about (collapsed
// card flags, last-upload timestamps, system-suggestions toggle) flows
// through one place — easier to audit which keys we own + safer when
// adding a new persisted flag.
//
// Every helper is wrapped in try/catch because:
//   • localStorage throws in private-window / quota-exceeded modes
//   • SSR / Node renders have no localStorage at all
// Returning safe defaults on error keeps the planner-facing UI on.

// ── Key registry — every persisted key the workbench writes ──────────

export const STORAGE_KEYS = {
  // Card collapse flags (Σ values "1" or "0").
  collapseSales:  "ws_planning_collapse_sales",
  collapseTotals: "ws_planning_collapse_totals",
  // "1" means OFF; default ON. The negative-flag shape mirrors
  // existing legacy data and prevents an empty-string read from
  // accidentally flipping the default.
  systemSuggestionsOff: "ws_planning_system_suggestions_off",
  // ISO timestamps of the last successful Excel upload, per kind.
  lastUploadSales:  "ip_last_upload_sales",
  lastUploadMaster: "ip_last_upload_master",
} as const;

export type UploadKind = "sales" | "master";

const LAST_UPLOAD_KEY_BY_KIND: Record<UploadKind, string> = {
  sales:  STORAGE_KEYS.lastUploadSales,
  master: STORAGE_KEYS.lastUploadMaster,
};

// ── Boolean flags (collapse cards, etc.) ─────────────────────────────

export function loadCollapsedFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

export function saveCollapsedFlag(key: string, val: boolean): void {
  try { localStorage.setItem(key, val ? "1" : "0"); } catch { /* ignore */ }
}

// ── System-suggestions toggle (negative-flag shape) ──────────────────

// Default ON. Returns false only when the flag is explicitly "1".
export function loadSystemSuggestionsOn(): boolean {
  try { return localStorage.getItem(STORAGE_KEYS.systemSuggestionsOff) !== "1"; }
  catch { return true; }
}

export function saveSystemSuggestionsOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(STORAGE_KEYS.systemSuggestionsOff);
    else    localStorage.setItem(STORAGE_KEYS.systemSuggestionsOff, "1");
  } catch { /* ignore quota */ }
}

// ── Last-upload timestamps (sales + master Excel ingest) ─────────────

export function loadLastUpload(kind: UploadKind): string | null {
  try { return localStorage.getItem(LAST_UPLOAD_KEY_BY_KIND[kind]); }
  catch { return null; }
}

export function rememberUpload(kind: UploadKind): string {
  const iso = new Date().toISOString();
  try { localStorage.setItem(LAST_UPLOAD_KEY_BY_KIND[kind], iso); }
  catch { /* ignore quota */ }
  return iso;
}
