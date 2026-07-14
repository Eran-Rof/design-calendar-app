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
//     actions:      [{ name, module_key, mode, required_action, preview, commit }]  (P28-4)
//   }
//   todoItem:    { key, title, detail?, count, severity: action|warn|info, panel?, href?, drill? }
//   processItem: { key, label, state: ok|running|warn|error, detail?, last_run_at?, panel? }
//
// Pack action contract (P28-4, arch doc §4 as refined in §11) — a drafted,
// confirm-gated write the assistant can PREVIEW but never execute:
//   {
//     name:            globally-unique snake_case key; doubles as the run_action arg
//     module_key:      P14 gate (same vocabulary as todo providers)
//     mode:            "read" | "draft" | "write_confirm"
//     required_action: "write" | "post" (non-read modes) — checked at confirm
//     description:     model-facing one-liner
//     input_schema:    JSON Schema for the action's input (tool-defs.js style)
//     preview(admin, input, ctx) => { summary, commit_payload, warnings? }
//                      MODEL-REACHABLE. Read-only. MUST NOT write.
//     commit(admin, commit_payload, ctx)  NEVER model-reachable — only the
//                      authenticated confirm endpoint calls it, post-token-verify
//                      + post-RBAC. The ONLY write point.
//   }
// NO pack ships an action yet (P28-4-1 is plumbing only); the contract +
// validation exist so P28-4-2+ packs slot in with zero registry change.

import accounting from "./packs/accounting.js";
import po from "./packs/po.js";
import soAllocations from "./packs/so_allocations.js";
import planning from "./packs/planning.js";
import masterData from "./packs/master_data.js";
import manufacturing from "./packs/manufacturing.js";
import casesInbox from "./packs/cases_inbox.js";

export const PACKS = [po, soAllocations, planning, masterData, manufacturing, casesInbox, accounting];

const SEVERITIES = new Set(["action", "warn", "error", "info"]);
const ACTION_MODES = new Set(["read", "draft", "write_confirm"]);
const ACTION_REQUIRED = new Set(["write", "post"]);

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

  // P28-4 — validate the optional actions[] contract. A pack without actions
  // is unaffected (the key is optional); a pack WITH one must declare each
  // fully so run_action / the confirm endpoint can trust the shape.
  if (pack.actions !== undefined) {
    if (!Array.isArray(pack.actions)) {
      problems.push("actions must be an array");
    } else {
      for (const a of pack.actions) {
        const nm = a && typeof a.name === "string" ? a.name : null;
        if (!nm) { problems.push("action missing name"); continue; }
        if (!a.module_key) problems.push(`action ${nm} missing module_key`);
        if (!ACTION_MODES.has(a.mode)) problems.push(`action ${nm} has invalid mode`);
        if (typeof a.preview !== "function") problems.push(`action ${nm} missing preview()`);
        if (a.mode !== "read") {
          if (typeof a.commit !== "function") problems.push(`action ${nm} missing commit()`);
          if (!ACTION_REQUIRED.has(a.required_action)) problems.push(`action ${nm} needs required_action write|post`);
        }
      }
    }
  }
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

/** All pack action names — the run_action allowlist (P28-4). Globally
 *  unique (they double as the run_action arg + the confirm token `act`). */
export function allActionNames(packs = PACKS) {
  const names = [];
  for (const pack of packs) {
    for (const a of pack.actions || []) if (a && a.name) names.push(a.name);
  }
  return names;
}

/** Resolve an action by its globally-unique name, or null. */
export function actionByName(name, packs = PACKS) {
  if (!name) return null;
  for (const pack of packs) {
    for (const a of pack.actions || []) {
      if (a && a.name === name) return a;
    }
  }
  return null;
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
