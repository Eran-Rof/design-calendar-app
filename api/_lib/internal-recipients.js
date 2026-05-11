// api/_lib/internal-recipients.js
//
// Shared resolver for INTERNAL_*_EMAILS env vars. Centralizes the
// category→env-var mapping and surfaces empty results as a console.warn
// so missing config no longer fails silently in Vercel logs.
//
// Usage:
//   import { getInternalRecipients } from "../../_lib/internal-recipients.js";
//   const { emails, empty } = getInternalRecipients("invoice", { event: "invoice_submitted" });
//   for (const email of emails) { /* send-notification */ }
//
// Each category has a primary env var. If the primary is empty, we DO
// NOT silently fall back to INTERNAL_COMPLIANCE_EMAILS — that historical
// fallback drowned the compliance team with every alert in the system.
// Callers that genuinely want the compliance fallback can pass
// { fallback: "compliance" } explicitly.

const CATEGORY_VARS = {
  invoice:       "INTERNAL_INVOICE_EMAILS",
  shipment:      "INTERNAL_SHIPMENT_EMAILS",
  dispute:       "INTERNAL_DISPUTE_EMAILS",
  message:       "INTERNAL_MESSAGE_EMAILS",
  compliance:    "INTERNAL_COMPLIANCE_EMAILS",
  contract:      "INTERNAL_CONTRACT_EMAILS",
  onboarding:    "INTERNAL_ONBOARDING_EMAILS",
  procurement:   "INTERNAL_PROCUREMENT_EMAILS",
  finance:       "INTERNAL_FINANCE_EMAILS",
  edi:           "INTERNAL_EDI_EMAILS",
  vendor_alert:  "INTERNAL_VENDOR_ALERT_EMAILS",
};

const ROLE_TO_CATEGORY = {
  finance_manager: "finance",
  procurement:     "procurement",
  compliance:      "compliance",
  vendor_ops:      "vendor_alert",
  edi_ops:         "edi",
  disputes_team:   "dispute",
  onboarding_team: "onboarding",
};

function parseList(value) {
  if (!value) return [];
  return String(value).split(",").map((e) => e.trim()).filter(Boolean);
}

function warnEmpty({ category, vars, event }) {
  const detail = event ? ` (event="${event}")` : "";
  // Single warn per call site. Vercel surfaces these in function logs.
  console.warn(`[internal-recipients] No recipients configured for category="${category}"${detail}. Set ${vars.join(" or ")} in Vercel env vars to enable internal email alerts.`);
}

/**
 * Resolve the recipient list for a category.
 *
 * @param {string} category — one of CATEGORY_VARS keys (e.g. "invoice")
 * @param {object} [options]
 * @param {string} [options.event] — event_type for the warn message (e.g. "invoice_submitted")
 * @param {"compliance"|null} [options.fallback] — explicit fallback chain. Default: null (no fallback).
 * @param {string[]} [options.extras] — additional emails to merge in (e.g. contract.internal_owner)
 * @returns {{ emails: string[], empty: boolean, varsConsulted: string[] }}
 */
export function getInternalRecipients(category, options = {}) {
  const { event = null, fallback = null, extras = [] } = options;
  const primaryVar = CATEGORY_VARS[category];
  if (!primaryVar) {
    console.warn(`[internal-recipients] Unknown category "${category}" — returning empty list.`);
    return { emails: [], empty: true, varsConsulted: [] };
  }

  const consulted = [primaryVar];
  const set = new Set(parseList(process.env[primaryVar]));

  if (set.size === 0 && fallback === "compliance" && category !== "compliance") {
    consulted.push("INTERNAL_COMPLIANCE_EMAILS");
    for (const e of parseList(process.env.INTERNAL_COMPLIANCE_EMAILS)) set.add(e);
  }

  for (const e of extras || []) {
    if (e && typeof e === "string") set.add(e.trim());
  }

  const emails = Array.from(set).filter(Boolean);
  const empty = emails.length === 0;
  if (empty) warnEmpty({ category, vars: consulted, event });

  return { emails, empty, varsConsulted: consulted };
}

/**
 * Resolve recipients for a workflow role (used by api/_lib/workflow.js).
 * Maps to a category internally; preserves the old "fallback to compliance"
 * behavior because workflow rules are typically critical.
 */
export function getRoleRecipients(role, options = {}) {
  const category = ROLE_TO_CATEGORY[role];
  if (!category) {
    console.warn(`[internal-recipients] Unknown workflow role "${role}" — returning empty list.`);
    return { emails: [], empty: true, varsConsulted: [] };
  }
  return getInternalRecipients(category, { ...options, fallback: "compliance" });
}
