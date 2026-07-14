// P28 Assistant-First — capability-pack registry.
//
// Every module that participates in the Today page / assistant registers
// ONE pack here (arch doc §4). Adding a module to the assistant = adding
// one pack file + one import line. Nothing in the aggregator, handler, or
// UI is module-specific.
//
// Pack contract (validated by validatePack + the foundation test):
//   {
//     key:          stable pack id ("po")
//     label:        display name
//     module_keys:  P14 module_key[] this pack's content gates on
//     todos:        [{ key, module_key, run(admin, ctx) => todoItem[] }]
//     processes:    [{ key, module_key, run(admin, ctx) => processItem[] }]
//     suggestions:  [{ key, module_key, derive(aggregate) => suggestionItem[] }]
//     panels:       { <tangerine module key>: {} } — routable destinations
//   }
//   todoItem:    { key, title, detail?, count, severity: action|warn|info, panel?, href?, drill? }
//   processItem: { key, label, state: ok|running|warn|error, detail?, last_run_at?, panel? }

import accounting from "./packs/accounting.js";
import po from "./packs/po.js";

export const PACKS = [po, accounting];

const SEVERITIES = new Set(["action", "warn", "error", "info"]);

/** Structural validation — used by tests and (cheaply) by dev tooling.
 *  Returns an array of problem strings; empty = valid.                 */
export function validatePack(pack) {
  const problems = [];
  if (!pack || typeof pack !== "object") return ["pack is not an object"];
  if (!pack.key || typeof pack.key !== "string") problems.push("missing key");
  if (!pack.label) problems.push("missing label");
  if (!Array.isArray(pack.module_keys) || pack.module_keys.length === 0) problems.push("missing module_keys");
  for (const kind of ["todos", "processes"]) {
    for (const p of pack[kind] || []) {
      if (!p.key) problems.push(`${kind} provider missing key`);
      if (!p.module_key) problems.push(`${kind} provider ${p.key} missing module_key`);
      if (typeof p.run !== "function") problems.push(`${kind} provider ${p.key} missing run()`);
    }
  }
  for (const r of pack.suggestions || []) {
    if (!r.key) problems.push("suggestion rule missing key");
    if (!r.module_key) problems.push(`suggestion ${r.key} missing module_key`);
    if (typeof r.derive !== "function") problems.push(`suggestion ${r.key} missing derive()`);
  }
  if (!pack.panels || typeof pack.panels !== "object") problems.push("missing panels");
  return problems;
}

/** All provider keys across packs — must be globally unique (they double
 *  as assistant_dismissals.item_key values).                             */
export function allProviderKeys(packs = PACKS) {
  const keys = [];
  for (const pack of packs) {
    for (const kind of ["todos", "processes", "suggestions"]) {
      for (const p of pack[kind] || []) keys.push(p.key);
    }
  }
  return keys;
}

/** Union of routable panel keys — the open_panel allowlist (Phase 2). */
export function panelKeys(packs = PACKS) {
  const out = new Set();
  for (const pack of packs) for (const k of Object.keys(pack.panels || {})) out.add(k);
  return out;
}

/** Severity vocabulary guard for tests. */
export function isValidSeverity(s) {
  return SEVERITIES.has(s);
}
