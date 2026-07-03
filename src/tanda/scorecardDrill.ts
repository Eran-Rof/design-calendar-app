// src/tanda/scorecardDrill.ts
//
// Scorecard drill-through helper. The vendor/customer scorecards let the
// operator click a metric/section to jump into the underlying list module
// (Purchase Orders, Sales Orders, AP/AR Invoices, Journal Entries) filtered to
// that party.
//
// Tangerine drives the active module from the `?m=<moduleKey>` URL param and
// re-reads it on `popstate` (browser back/forward). We therefore navigate by
// rewriting the URL with the target module key + a party-filter param and
// dispatching a synthetic `popstate` event so Tangerine swaps the panel without
// a full reload. The target panel reads its own filter param (`vendor`,
// `customer`, or `q`) on mount.
//
// We must NOT edit Tangerine.tsx / menuKeys (owned by a parallel PR), so this
// keeps the cross-module hop entirely on the URL contract those already honor.

export type DrillModuleKey =
  | "purchase_orders"
  | "sales_orders"
  | "ap_invoices"
  | "ar_invoices"
  | "journal_entries";

/**
 * Navigate to a target list module, seeding one party-filter query param.
 *
 * @param module  target moduleKey (must exist in Tangerine's module list)
 * @param filter  the param the target panel reads on mount, e.g.
 *                { vendor: id } | { customer: id } | { q: code }
 */
export function drillToModule(
  module: DrillModuleKey,
  filter: Record<string, string>,
): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  // Clear any stale party filters from a previous drill so panels don't get
  // crossed-wired params.
  for (const k of ["vendor", "customer", "q"]) url.searchParams.delete(k);
  url.searchParams.set("m", module);
  for (const [k, v] of Object.entries(filter)) {
    if (v) url.searchParams.set(k, v);
  }
  window.history.pushState({ module }, "", url.toString());
  // Tangerine's own popstate handler re-reads ?m= and mounts the target panel.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Read a single query param once (panel mount). Mirrors how ATSContext reads
 * `?style=`. Returns "" when absent so callers can use it directly as seed.
 */
export function readDrillParam(name: string): string {
  if (typeof window === "undefined") return "";
  return (new URLSearchParams(window.location.search).get(name) || "").trim();
}

/**
 * Strip one-shot drill params from the URL after a panel has SEEDED its filters
 * from them (call once on mount, in an effect that runs AFTER the useState
 * initializers read the values). Without this the params linger in the URL, so
 * when the operator leaves the panel and returns it re-applies the stale filter
 * — e.g. a `?q=` from one drill silently hid the whole Sales-Orders / Purchase-
 * Orders list on the next visit. Uses replaceState so it doesn't add history.
 */
export function consumeDrillParams(names: string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const n of names) if (url.searchParams.has(n)) { url.searchParams.delete(n); changed = true; }
  if (changed) window.history.replaceState(window.history.state, "", url.toString());
}
