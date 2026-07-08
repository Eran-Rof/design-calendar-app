// api/_lib/accounting/revenueRouting.js
//
// ONE resolver for "which revenue + COGS account does this sale post to?" —
// the operator's 2026-07-07 COA spec (accounts 4005-4016 under the 4000
// header, COGS twins 5010-5018 under 5000). Used by BOTH posting paths:
//   • the Xoro-bridge daily revenue JEs (ip_sales_history grain), and
//   • native AR invoice creation (create-invoice stamps line accounts).
//
// Rule order (first match wins) — mirrors the operator's definitions:
//   1. sample        → 4010, NO COGS (samples expense out via 5206 — decided
//                      2026-07-07; the posting path must not emit COGS)
//   2. shipping line → 4014 PT ecom / 4015 ROF ecom / 4016 wholesale, NO COGS
//   3. consignment   → 4007 / 5018
//   4. private label → 4012 / 5015  (any PL sale, any brand)
//   5. Psycho Tuna   → ecom 4008 / 5013, else wholesale 4009 / 5012
//   6. ROF ecom      → 4011 / 5014  (ringoffireclothing.com Shopify, all brands)
//   7. kids gender   → 4006 / 5011  (B / C / G — Boys, Child, Girls)
//   8. catch-all     → 4005 / 5010  (all brands, all other genders)
//
// Inputs are NORMALIZED by the caller (adapters differ per source):
//   brandCode   brand_master.code ('ROF','PT','PL','AXECROWN',…) — the STYLE's
//               brand (style_master.brand_id), never ar_invoice_lines.brand_id
//               (defaulted, unreliable) or ip_item_master.brand_id (stale).
//   genderCode  style_master.gender_code ('M','W','B','C','G','U', null).
//   channel     'wholesale' | 'ecom_rof' | 'ecom_pt' | 'consignment'
//               (bridge: ip_channel_master ROF/ROF ECOM/PT/PT ECOM;
//                native: channel_master — map DTC by brand).
//   isPrivateLabel  style_code ends in 'PL' (the catalog convention) OR
//                   brand code 'PL'.
//   isSample / isShipping  caller-detected line semantics.
//
// Returns { revenueCode, cogsCode } — cogsCode === null means DO NOT post
// COGS for this line (samples, shipping). Account codes, not ids: callers
// resolve ids per entity (accounts may be re-numbered by the operator; codes
// are the spec).

const KIDS_GENDERS = new Set(["B", "C", "G"]);

export function resolveRevenueRouting(input = {}) {
  const brand = String(input.brandCode || "").toUpperCase();
  const gender = String(input.genderCode || "").toUpperCase();
  const channel = String(input.channel || "wholesale").toLowerCase();
  const pt = brand === "PT";

  if (input.isSample) return { revenueCode: "4010", cogsCode: null };
  if (input.isShipping) {
    if (channel === "ecom_pt") return { revenueCode: "4014", cogsCode: null };
    if (channel === "ecom_rof") return { revenueCode: "4015", cogsCode: null };
    return { revenueCode: "4016", cogsCode: null };
  }
  if (channel === "consignment") return { revenueCode: "4007", cogsCode: "5018" };
  if (input.isPrivateLabel || brand === "PL") return { revenueCode: "4012", cogsCode: "5015" };
  // Ecom is STORE-scoped ("all brands from the … store"), so the store wins
  // over the item's brand: psychotuna.com → 4008, ringoffireclothing.com → 4011.
  if (channel === "ecom_pt") return { revenueCode: "4008", cogsCode: "5013" };
  if (channel === "ecom_rof") return { revenueCode: "4011", cogsCode: "5014" };
  // Wholesale: PT is brand-scoped (CEO-confirmed: brand beats kids gender).
  if (pt) return { revenueCode: "4009", cogsCode: "5012" };
  if (KIDS_GENDERS.has(gender)) return { revenueCode: "4006", cogsCode: "5011" };
  return { revenueCode: "4005", cogsCode: "5010" };
}

// AR-side routing per the same COA spec: factored → 1107, credit-card →
// 1105 (posted before reconciliation to matching invoices), else house 1108.
// `customer` needs { is_factored, payment_processor }. Falls back to house.
export function resolveArAccountCode(customer = {}) {
  if (customer.is_factored) return "1107";
  if (customer.payment_processor) return "1105";
  return "1108";
}

// Private-label detection from the catalog convention: style codes ending in
// 'PL' (see the per-shop PL SKU work) — optionally preceded by a digit block.
export function isPrivateLabelStyle(styleCode) {
  return /PL$/i.test(String(styleCode || "").trim());
}

// Bridge adapter: ip_channel_master names → normalized channel.
export function channelFromIpChannelName(name) {
  const n = String(name || "").trim().toUpperCase();
  if (n === "PT ECOM") return "ecom_pt";
  if (n === "ROF ECOM") return "ecom_rof";
  return "wholesale";
}

// Native adapter: channel_master codes (DTC/WHOLESALE/FBA/WALMART/FAIRE) →
// normalized channel. DTC = a Shopify storefront; which one is the item's
// brand's store (PT → psychotuna.com, everything else → ringoffireclothing.com).
// Marketplaces (FBA/WALMART/FAIRE) route as wholesale until they get their own
// revenue accounts.
export function channelFromChannelMasterCode(code, brandCode) {
  const c = String(code || "").trim().toUpperCase();
  if (c === "DTC") return String(brandCode || "").toUpperCase() === "PT" ? "ecom_pt" : "ecom_rof";
  return "wholesale";
}
