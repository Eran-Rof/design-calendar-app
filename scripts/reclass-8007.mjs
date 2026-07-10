#!/usr/bin/env node
// 8007 "Uncategorized Expense" cleanup driver (vendor default expense accounts).
//
// Background: the per-bill AP GL engine (#1662/#1666/#1668) routes a bill's
// non-item/tax slice to the vendor's default expense account
// (vendors.default_gl_expense_account_id) and falls back to 8007
// Uncategorized Expense when the vendor has none. Historically ~$8.9M landed
// in 8007, so the P&L showed one lump instead of real expense categories.
//
// This driver:
//   report        read-only — 8007 activity by vendor x month, mapping
//                 coverage, and writes the CEO review CSV for vendors we do
//                 NOT auto-map (docs/tangerine/ap-8007-review.csv)
//   set-defaults  set vendors.default_gl_expense_account_id for the
//                 HIGH-confidence name mappings below (only when NULL —
//                 an operator-set default is never overwritten)
//   reclass       post one JE per (vendor, month): DR the vendor's default
//                 expense account / CR 8007 for that month's 8007 activity.
//                 Runs for EVERY vendor with a validated default expense
//                 account (so operator mappings added later are picked up by
//                 a re-run), except the EXCLUDE list.
//   verify        8007 + 2000 balances, trial-balance imbalance, 8007 by
//                 month after reclass
//
// Non-negotiables honored:
//   - JEs are dated to the SOURCE months (month-end; current month uses the
//     latest source line date), never today.
//   - T11: audit_reason on every post. T10: journal_type
//     'vendor_expense_reclass', source_module 'ap',
//     source_table 'vendor_expense_reclass', source_id '<vendor_id>:<YYYY-MM>'
//     (the uq_je_source_basis index makes reruns idempotent).
//   - 2000 is never touched (expense -> expense only).
//   - Rosenthal & Rosenthal is EXCLUDED: factoring costs are already booked
//     by the #1670 factor_cost JEs (6802/6803/6804) from the Rosenthal
//     statements — reclassing its AP-bill 8007 charges into the 68xx set
//     could double-count. Flagged for CEO/controller reconciliation instead.
//
// Usage: node scripts/reclass-8007.mjs <report|set-defaults|reclass|verify> [--dry-run] [--limit=N]

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    return Object.fromEntries(text.split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  } catch { return {}; }
}
const env = { ...loadEnv(".env"), ...loadEnv(".env.local") };
const SB_URL = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

const $ = (c) => ((c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (cents) => {
  const neg = cents < 0; const abs = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

// ── HIGH-confidence vendor -> expense account mapping ────────────────────────
// Unambiguous name matches only (several accounts are tailor-made for the
// vendor, e.g. 6378 Xoro Subscription, 6713 Website Advertising Google).
// Anything debatable stays in 8007 and goes to the review CSV instead.
const HIGH = [
  // freight / shipping / customs
  ["GPA Logistics Group Inc.", "6348", "3PL/logistics provider — Logistics Warehouse Expense"],
  ["UPS", "5405", "parcel carrier — Shipping Expense"],
  ["FedEx", "5405", "parcel carrier — Shipping Expense"],
  ["USPS", "6356", "postal service — Postage Expense"],
  ["Master Int'l Air, Inc.", "5402", "air freight forwarder — Freight In"],
  ["City Logistics-ACH", "5401", "trucking/drayage — Freight Expense"],
  ["CSL Express Line", "5401", "freight carrier — Freight Expense"],
  ["Worldwide Express", "5401", "freight carrier — Freight Expense"],
  ["Flexport", "5402", "freight forwarder — Freight In"],
  // insurance
  ["Kaiser Permanente", "6338", "health insurer — Medical Insurance"],
  ["Blue Shield CA", "6338", "health insurer — Medical Insurance"],
  ["Health First New York", "6338", "health insurer — Medical Insurance"],
  ["Amtrust", "6339", "workers' comp carrier"],
  ["Republic Indemnity", "6339", "workers' comp carrier"],
  ["Mercury Insurance Company", "6335", "auto insurer — Auto Insurance"],
  // rent
  ["5200 White Oak", "6360", "landlord (property address) — Rent Expense"],
  // professional fees
  ["RKE Certified Public Accountants", "6301", "CPA firm — Accounting Service"],
  ["Sandi Ordonez Accounting Services", "6301", "accounting services"],
  ["Elevate Accounting Department", "6301", "accounting services"],
  ["Cypress LLP", "6344", "law firm — Legal & Professional"],
  ["Power Del Valle LLP", "6344", "law firm — Legal & Professional"],
  // software / subscriptions / IT
  ["Xorosoft", "6378", "ERP vendor — Xoro Subscription (tailor-made account)"],
  ["Shopify", "6718", "Website Hosting Shopfiy (tailor-made account)"],
  ["Orderful Inc.", "6326", "EDI platform — EDI Processing"],
  ["DI Central", "6326", "EDI platform — EDI Processing"],
  ["EDI Partners", "6326", "EDI services — EDI Processing"],
  ["Intuit", "6302", "QuickBooks — Accounting Software"],
  ["GS1 US, INC.", "6371", "UPC registry — UPC Codes Expense (tailor-made)"],
  ["ComputerCare, Inc.", "6313", "IT maintenance — Computer Maintenance"],
  // advertising
  ["Google LLC - Ads", "6713", "Website Advertising Google (tailor-made)"],
  ["Meta Platforms, Inc. - Ads", "6614", "Meta Platforms Advertising (tailor-made)"],
  // payroll / commissions
  ["Paycor Inc", "6132", "payroll provider — Payroll processing fees"],
  ["Meredith Levitt", "6127", "Sales Commissions - Meredith Le (tailor-made)"],
  ["Patricia Thornton", "5105", "Commissions Expense - Patrica T (tailor-made)"],
  ["Righton Surf LLC", "6133", "Sales Commission - Right On Surf (tailor-made)"],
  // telecom
  ["AT&T Mobility-Auto", "6352", "Mobile Phone Expense"],
  ["Spectrum", "6382", "Internet Service Provider"],
  // automobiles
  ["Porsche", "6304", "auto financing — Auto Expense"],
  ["Tesla Finance LLC", "6304", "auto financing — Auto Expense"],
  ["Mercedes Benz Financial Services", "6304", "auto financing — Auto Expense"],
  ["Bentley Financial Services", "6304", "auto financing — Auto Expense"],
  ["Whitney Auto Service", "6304", "auto repair — Auto Expense"],
  ["DMV", "6346", "vehicle registration — Licenses & Fees"],
  // travel / meals
  ["Delta Airlines", "6303", "airline — Air Fare"],
  ["Jet Blue", "6303", "airline — Air Fare"],
  ["American Airlines", "6303", "airline — Air Fare"],
  ["Westin Hotels and Resorts", "6332", "hotel — Hotel Expense"],
  ["Hilton Hotels & Resorts Orlando", "6332", "hotel — Hotel Expense"],
  ["Hilton Hotels", "6332", "hotel — Hotel Expense"],
  ["AC Hotels by Marriott", "6332", "hotel — Hotel Expense"],
  ["Booking.com", "6332", "lodging bookings — Hotel Expense"],
  ["Uber", "6370", "rides — Travel"],
  ["Shamshiri Restaurant", "6349", "restaurant — Meals & Entertainment"],
  ["Rosies Kitchen", "6349", "restaurant — Meals & Entertainment"],
  ["Western Bagel", "6349", "food — Meals & Entertainment"],
  ["The Stand", "6349", "restaurant — Meals & Entertainment"],
  ["Mercato", "6349", "restaurant — Meals & Entertainment"],
  ["Doordash", "6349", "food delivery — Meals & Entertainment"],
  ["BevMo!", "6349", "beverages — Meals & Entertainment"],
  // trade shows / storage / charity
  ["SURF EXPO", "6608", "Trade Show Booth - Surf Expo (tailor-made)"],
  ["Southwest Mobile Storage", "6368", "Storage Container Expense (tailor-made)"],
  ["Chabad of Woodland Hills", "6309", "Charitable Contributions"],
];

// Vendors NEVER auto-reclassed even if a default account is set.
const EXCLUDE = new Map([
  ["Rosenthal & Rosenthal", "factor — #1670 factor_cost JEs already book statement fees to 6802/6803/6804; reclassing AP-bill 8007 charges risks double-counting. CEO/controller to reconcile the two sources first."],
]);

// MEDIUM/LOW suggestions for the review CSV — NOT auto-posted.
const SUGGEST = new Map([
  ["Factory 1", ["", "MEDIUM", "garment manufacturer — likely inventory/COGS (1201/5001), not an opex category; out of scope for expense->expense reclass"]],
  ["CNX America Corp.", ["6348", "MEDIUM", "name suggests logistics but unverified"]],
  ["Interland Clothing", ["", "MEDIUM", "garment vendor — likely inventory/COGS; CEO confirm"]],
  ["United Aryan (EPZ) Limited", ["", "MEDIUM", "garment manufacturer (Kenya) — likely inventory/COGS"]],
  ["NEXT ELEVATION", ["", "LOW", "unknown vendor — CEO identify"]],
  ["Dynamic Full Ltd.", ["", "MEDIUM", "HK garment vendor — likely inventory/COGS"]],
  ["Anhui Taihe Jiarun Garment Co Ltd", ["", "MEDIUM", "garment manufacturer — likely inventory/COGS"]],
  ["2253 Apparel, Inc.", ["", "MEDIUM", "apparel vendor — likely inventory/COGS"]],
  ["The Luxury Collection", ["", "LOW", "ambiguous (apparel vs hotel brand)"]],
  ["Bien Roulee Fashion", ["", "MEDIUM", "apparel vendor — likely inventory/COGS"]],
  ["iWin Group Corp.", ["", "LOW", "unknown vendor"]],
  ["Aztlan Trading Inc.", ["", "LOW", "unknown vendor"]],
  ["Lanny K.W. Inc.", ["", "LOW", "unknown vendor"]],
  ["Avery Dennison", ["6374", "MEDIUM", "tags/labels/trims — Warehouse Supplies, or trim inventory; CEO pick"]],
  ["California Supply, Inc.", ["6374", "MEDIUM", "supplies vendor — Warehouse Supplies?"]],
  ["Packaging & More", ["6374", "MEDIUM", "packaging — Warehouse Supplies?"]],
  ["Fineline Technologies", ["6374", "MEDIUM", "price tickets/RFID tags — Warehouse Supplies or ticket accounts 5022/5023"]],
  ["Venbrook Group LLC", ["6337", "MEDIUM", "commercial insurance broker — which policy line (GL/WC/property) unknown; no generic Insurance postable account"]],
  ["The Hartford", ["6337", "MEDIUM", "business insurer — GL vs workers' comp split unknown"]],
  ["Capital Premium for Travelers EPLI", ["6336", "MEDIUM", "EPLI premium financing — E&O vs GL insurance"]],
  ["Accordia Life and Annuity Company", ["", "MEDIUM", "life insurance — possibly officer life (may be non-deductible); CEO decide"]],
  ["American General Life Insurance Company", ["", "MEDIUM", "life insurance — CEO decide"]],
  ["Banner Life Insurance Company", ["", "MEDIUM", "life insurance — CEO decide"]],
  ["Banner Health", ["6338", "MEDIUM", "medical provider — Medical Insurance?"]],
  ["Bitton & Associates", ["6344", "MEDIUM", "related-party name (Bitton) — legal/consulting? CEO confirm"]],
  ["Isaac Bitton", ["", "MEDIUM", "related party — CEO classify (guaranteed payments / consulting?)"]],
  ["Remote Techs, Inc.", ["6311", "MEDIUM", "IT services — Computer Consulting?"]],
  ["Sourcefit", ["6130", "MEDIUM", "offshore staffing/BPO — Contractors?"]],
  ["Freelancer", ["6130", "MEDIUM", "freelance platform — Contractors or Design Freelance 5202"]],
  ["U.S. Small Business Administration", ["6342", "MEDIUM", "SBA loan payments — interest portion to 6342, principal is liability not expense; controller split"]],
  ["State of California Franchise Tax Board", ["6369", "MEDIUM", "income/franchise tax — CEO/CPA decide expense vs equity treatment"]],
  ["Franchise Tax Board", ["6369", "MEDIUM", "income/franchise tax — CEO/CPA decide"]],
  ["California Department of Tax and Fee Admin", ["6386", "MEDIUM", "state taxes & fees"]],
  ["City of Los Angeles-Office of Finance", ["6307", "MEDIUM", "LA business tax — Business License"]],
  ["City of LA Business Tax", ["6307", "MEDIUM", "LA business tax — Business License"]],
  ["Los Angeles County Tax Collector", ["6359", "MEDIUM", "property tax"]],
  ["Utah Department of Agriculture and Food", ["6346", "MEDIUM", "licenses & fees"]],
  ["U.S. Customs and Border Protection", ["5120", "MEDIUM", "customs duty — ROF has no Customs Duty account (5110 belongs to entity SAG); 5120 Brokerage + Clearance or 5130 Section 301 Tariffs — CEO pick"]],
  ["Valley Bank", ["6306", "MEDIUM", "bank charges vs loan payment — verify"]],
  ["Marlin Business Bank -Peac Solutions", ["6327", "MEDIUM", "equipment lease financing — Equipment Rental"]],
  ["Attentive Mobile Inc.", ["6601", "MEDIUM", "SMS marketing SaaS — Advertising & Marketing"]],
  ["Shutter Stock", ["6325", "MEDIUM", "stock imagery subscription"]],
  ["Apple.com", ["6312", "MEDIUM", "hardware — Computer Hardware"]],
  ["Amazon", ["6354", "MEDIUM", "mixed retail — Office Supplies?"]],
  ["Costco Warehouse", ["6381", "MEDIUM", "mixed retail — Break Room Supplies?"]],
  ["E360 Travelers", ["6370", "MEDIUM", "travel agency? verify not Travelers insurance"]],
  ["Expo Solutions", ["5140", "MEDIUM", "trade show services"]],
  ["Orange County Covention Center Exhibitor", ["5140", "MEDIUM", "trade show venue"]],
  ["Hello! Freeman", ["5140", "MEDIUM", "trade show contractor (Freeman)"]],
  ["Trade Aider", ["5204", "MEDIUM", "QC/inspection platform — Inspections Expense"]],
  ["Filco carting", ["6310", "MEDIUM", "waste removal — Cleaning & Maintenance"]],
  ["Action Carting Environmental Services, Inc.", ["6310", "MEDIUM", "waste removal — Cleaning & Maintenance"]],
  ["Coway USA", ["6327", "MEDIUM", "water purifier rental — Equipment Rental"]],
  ["JSHU Investments", ["6360", "MEDIUM", "possible landlord — Rent? verify"]],
  ["Photo Editor Company", ["6704", "MEDIUM", "photo services"]],
  ["Solomar Fixtures Inc.", ["6353", "MEDIUM", "fixtures — Office Equipment?"]],
  ["Lehosheet Yad L.A", ["6309", "MEDIUM", "likely charity — verify"]],
  ["Millennium Steel", ["6364", "MEDIUM", "repairs/materials — verify"]],
  ["Paypal", ["6384", "MEDIUM", "merchant/deposit fees"]],
  ["eBay", ["6520", "MEDIUM", "Marketplace Fees"]],
  ["Etsy, Inc.", ["6520", "MEDIUM", "Marketplace Fees"]],
  ["Walmart", ["6520", "MEDIUM", "marketplace fees vs supplies — verify"]],
]);

async function fetchAll(table, select, mod = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(select).range(from, from + 999);
    q = mod(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function loadContext() {
  const { data: entity, error: eErr } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("ROF entity not found");
  const accts = await fetchAll("gl_accounts", "id, code, name, is_postable, is_control, status",
    (q) => q.eq("entity_id", entity.id));
  const acctById = new Map(accts.map((a) => [a.id, a]));
  const postableByCode = new Map();
  for (const a of accts) {
    if (a.is_postable && !a.is_control && a.status === "active") {
      if (postableByCode.has(a.code)) throw new Error(`GL code ${a.code} is ambiguous (duplicate postable accounts) — refuse to map by code`);
      postableByCode.set(a.code, a);
    }
  }
  const a8007 = postableByCode.get("8007");
  const a2000 = accts.find((a) => a.code === "2000");
  if (!a8007 || !a2000) throw new Error("GL accounts 8007/2000 missing");
  return { entity_id: entity.id, a8007, a2000, acctById, postableByCode };
}

// All posted 8007 lines from the per-bill AP engine, resolved to
// (vendor_id, YYYY-MM) buckets. Reclass JEs themselves (journal_type
// 'vendor_expense_reclass') are excluded by the journal_type filter, so the
// computation is stable across re-runs.
async function load8007Activity(ctx) {
  const lines = await fetchAll(
    "journal_entry_lines",
    "debit, credit, journal_entries!inner(posting_date, status, journal_type, source_table, source_id)",
    (q) => q.eq("account_id", ctx.a8007.id)
      .eq("journal_entries.status", "posted")
      .eq("journal_entries.journal_type", "ap_invoice_historical")
      .eq("journal_entries.source_table", "invoices")
      .order("id", { ascending: true }),
  );
  const invoiceIds = [...new Set(lines.map((l) => l.journal_entries.source_id))];
  const vendorByInvoice = new Map();
  for (let i = 0; i < invoiceIds.length; i += 200) {
    const { data, error } = await admin.from("invoices").select("id, vendor_id").in("id", invoiceIds.slice(i, i + 200));
    if (error) throw new Error(`invoices read failed: ${error.message}`);
    for (const r of data || []) vendorByInvoice.set(r.id, r.vendor_id);
  }
  // buckets: vendor_id -> ym -> { cents, n, maxDate }
  const buckets = new Map();
  let unattributed = 0;
  for (const l of lines) {
    const je = l.journal_entries;
    const vendor_id = vendorByInvoice.get(je.source_id);
    if (!vendor_id) { unattributed += 1; continue; }
    const ym = String(je.posting_date).slice(0, 7);
    const cents = Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100);
    let byYm = buckets.get(vendor_id);
    if (!byYm) { byYm = new Map(); buckets.set(vendor_id, byYm); }
    const b = byYm.get(ym) || { cents: 0, n: 0, maxDate: "" };
    b.cents += cents; b.n += 1;
    if (String(je.posting_date) > b.maxDate) b.maxDate = String(je.posting_date);
    byYm.set(ym, b);
  }
  if (unattributed) console.log(`⚠️ ${unattributed} 8007 lines could not be attributed to a vendor (invoice row missing)`);
  return { buckets, lineCount: lines.length };
}

async function loadVendors() {
  const rows = await fetchAll("vendors", "id, name, default_gl_expense_account_id", (q) => q.order("id", { ascending: true }));
  return new Map(rows.map((v) => [v.id, v]));
}

// Validated default expense account per vendor (same rules as the #1666 sweep:
// postable, non-control, active, this entity).
function validDefault(ctx, vendor) {
  const aid = vendor.default_gl_expense_account_id;
  if (!aid) return null;
  const a = ctx.acctById.get(aid);
  if (!a || !a.is_postable || a.is_control || a.status !== "active") return null;
  return a;
}

function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of ym
  return d.toISOString().slice(0, 10);
}

async function postJe(payload, healQuery) {
  const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload });
  if (!error) return { jeId };
  if (/duplicate key|uq_je_source/i.test(error.message || "")) {
    const { data: existing } = await healQuery();
    if (existing) return { jeId: existing.id, healed: true };
  }
  return { error: error.message };
}

// ── phases ───────────────────────────────────────────────────────────────────

async function phaseReport() {
  const ctx = await loadContext();
  const { buckets, lineCount } = await load8007Activity(ctx);
  const vendors = await loadVendors();
  const highByName = new Map(HIGH.map(([n, code, why]) => [n, { code, why }]));

  const rows = [];
  let total = 0;
  for (const [vendor_id, byYm] of buckets) {
    const v = vendors.get(vendor_id) || { name: `(unknown ${vendor_id})` };
    const cents = [...byYm.values()].reduce((s, b) => s + b.cents, 0);
    total += cents;
    const def = vendors.get(vendor_id) ? validDefault(ctx, vendors.get(vendor_id)) : null;
    const high = highByName.get(v.name);
    let tier, target, why;
    if (EXCLUDE.has(v.name)) { tier = "EXCLUDED"; target = ""; why = EXCLUDE.get(v.name); }
    else if (high) { tier = "HIGH"; target = high.code; why = high.why; }
    else if (def) { tier = "DEFAULT"; target = def.code; why = "vendor already has an operator-set default expense account"; }
    else if (SUGGEST.has(v.name)) { const [code, t, r] = SUGGEST.get(v.name); tier = t; target = code; why = r; }
    else { tier = "LOW"; target = ""; why = "no confident name match — CEO classify"; }
    rows.push({ vendor_id, name: v.name, cents, months: byYm.size, tier, target, why, byYm });
  }
  rows.sort((a, b) => b.cents - a.cents);

  const sumTier = (t) => rows.filter((r) => r.tier === t).reduce((s, r) => s + r.cents, 0);
  console.log(`8007 activity: ${lineCount} lines, ${rows.length} vendors, $${$(total)}`);
  for (const t of ["HIGH", "DEFAULT", "MEDIUM", "LOW", "EXCLUDED"]) {
    console.log(`  ${t}: ${rows.filter((r) => r.tier === t).length} vendors  $${$(sumTier(t))}`);
  }
  console.log("\nauto-reclass set (HIGH + DEFAULT), top 25:");
  for (const r of rows.filter((r) => r.tier === "HIGH" || r.tier === "DEFAULT").slice(0, 25)) {
    console.log(`  ${r.name} -> ${r.target}: $${$(r.cents)} over ${r.months} mo (${r.tier})`);
  }

  // review CSV: everything NOT auto-reclassed
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csvRows = [["vendor", "total", "months_active", "monthly_totals", "suggested_account", "confidence", "reason"].join(",")];
  for (const r of rows.filter((x) => x.tier === "MEDIUM" || x.tier === "LOW" || x.tier === "EXCLUDED")) {
    const monthly = [...r.byYm.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ym, b]) => `${ym}: $${$(b.cents)}`).join("; ");
    const sug = r.target ? `${r.target} — ${(ctx.postableByCode.get(r.target) || {}).name || ""}` : "";
    csvRows.push([esc(r.name), esc(`$${$(r.cents)}`), r.months, esc(monthly), esc(sug), r.tier === "EXCLUDED" ? "FLAG" : r.tier, esc(r.why)].join(","));
  }
  const csvPath = resolve(ROOT, "docs/tangerine/ap-8007-review.csv");
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csvRows.join("\n") + "\n");
  console.log(`\nreview CSV (${csvRows.length - 1} vendors) -> ${csvPath}`);
  return rows;
}

async function phaseSetDefaults({ dryRun }) {
  const ctx = await loadContext();
  const vendors = await loadVendors();
  const byName = new Map([...vendors.values()].map((v) => [v.name, v]));
  let set = 0, kept = 0, missing = 0;
  for (const [name, code, why] of HIGH) {
    const v = byName.get(name);
    if (!v) { missing += 1; console.log(`  vendor not found: ${name}`); continue; }
    const acct = ctx.postableByCode.get(code);
    if (!acct) throw new Error(`mapping account ${code} not postable/active — fix mapping`);
    if (v.default_gl_expense_account_id) {
      kept += 1;
      const cur = ctx.acctById.get(v.default_gl_expense_account_id);
      if (v.default_gl_expense_account_id !== acct.id) {
        console.log(`  KEEPING operator default on ${name}: ${cur ? cur.code : v.default_gl_expense_account_id} (mapping suggested ${code})`);
      }
      continue;
    }
    if (dryRun) { set += 1; console.log(`  would set ${name} -> ${code} ${acct.name} (${why})`); continue; }
    const { error } = await admin.from("vendors").update({ default_gl_expense_account_id: acct.id }).eq("id", v.id);
    if (error) throw new Error(`set default failed for ${name}: ${error.message}`);
    set += 1;
    console.log(`  set ${name} -> ${code} ${acct.name}`);
  }
  console.log(`set-defaults${dryRun ? " (dry-run)" : ""}: ${set} set, ${kept} already had one (kept), ${missing} vendor names not found`);
}

async function phaseReclass({ dryRun, limit }) {
  const ctx = await loadContext();
  const { buckets } = await load8007Activity(ctx);
  const vendors = await loadVendors();
  const today = new Date().toISOString().slice(0, 10);

  let posted = 0, postedCents = 0, healed = 0, skippedNoDefault = 0, excluded = 0, errors = 0, done = 0;
  const work = [...buckets.entries()].map(([vendor_id, byYm]) => ({ vendor_id, byYm, v: vendors.get(vendor_id) }))
    .filter((w) => w.v)
    .sort((a, b) => (a.v.name < b.v.name ? -1 : 1));

  for (const w of work) {
    if (EXCLUDE.has(w.v.name)) {
      excluded += 1;
      console.log(`  EXCLUDED ${w.v.name}: $${$([...w.byYm.values()].reduce((s, b) => s + b.cents, 0))} left in 8007 — ${EXCLUDE.get(w.v.name)}`);
      continue;
    }
    const target = validDefault(ctx, w.v);
    if (!target) { skippedNoDefault += 1; continue; }
    if (target.id === ctx.a8007.id) { skippedNoDefault += 1; continue; } // default IS 8007 — nothing to move

    for (const [ym, b] of [...w.byYm.entries()].sort((a, x) => (a[0] < x[0] ? -1 : 1))) {
      if (b.cents === 0) continue;
      if (limit && done >= limit) break;
      done += 1;
      // SOURCE-month dating: month-end; for the in-flight current month use
      // the latest 8007 line date so we never post a future-dated JE.
      const me = monthEnd(ym);
      const posting_date = me > today ? b.maxDate : me;
      const lines = [
        {
          line_number: 1,
          account_id: target.id,
          debit: b.cents > 0 ? dollars(b.cents) : "0",
          credit: b.cents < 0 ? dollars(-b.cents) : "0",
          memo: `Reclass from 8007 — ${w.v.name} — ${ym} (${b.n} bill line${b.n === 1 ? "" : "s"})`,
        },
        {
          line_number: 2,
          account_id: ctx.a8007.id,
          debit: b.cents < 0 ? dollars(-b.cents) : "0",
          credit: b.cents > 0 ? dollars(b.cents) : "0",
          memo: `Reclass to ${target.code} ${target.name} — ${w.v.name} — ${ym}`,
        },
      ];
      if (dryRun) { posted += 1; postedCents += b.cents; continue; }
      const payload = {
        entity_id: ctx.entity_id,
        basis: "ACCRUAL",
        journal_type: "vendor_expense_reclass",
        posting_date,
        source_module: "ap",
        source_table: "vendor_expense_reclass",
        source_id: `${w.vendor_id}:${ym}`,
        description: `8007 reclass — ${w.v.name} — ${ym} -> ${target.code} ${target.name}`,
        audit_reason: `AP 8007 Uncategorized Expense cleanup: move $${$(b.cents)} of ${ym} charges from vendor ${w.v.name} to its default expense account ${target.code} ${target.name} (vendor default expense mapping; per-vendor-per-month reclass dated to the source month). Expense-to-expense only — AP 2000 untouched.`,
        lines,
      };
      const r = await postJe(payload, () => admin.from("journal_entries").select("id")
        .eq("source_table", "vendor_expense_reclass").eq("source_id", `${w.vendor_id}:${ym}`)
        .eq("basis", "ACCRUAL").maybeSingle());
      if (r.error) { errors += 1; console.error(`  ${w.v.name} ${ym}: ${r.error}`); continue; }
      if (r.healed) healed += 1;
      posted += 1; postedCents += b.cents;
      if (posted % 100 === 0) console.log(`  … ${posted} reclass JEs ($${$(postedCents)})`);
    }
    if (limit && done >= limit) break;
  }
  console.log(`reclass${dryRun ? " (dry-run)" : ""}: ${posted} (vendor, month) JEs moving $${$(postedCents)} out of 8007 (${healed} pre-existing/healed), ${skippedNoDefault} vendors left (no default account), ${excluded} excluded, ${errors} errors`);
  if (errors) process.exit(1);
}

async function phaseVerify() {
  const ctx = await loadContext();
  // trial balance: 8007, 2000, and whole-ledger imbalance
  const tb = await fetchAll("v_trial_balance", "code, name, debit_cents, credit_cents",
    (q) => q.eq("entity_id", ctx.entity_id).eq("basis", "ACCRUAL"));
  const toC = (v) => Math.round(Number(v || 0));
  let imbalance = 0;
  for (const r of tb) imbalance += toC(r.debit_cents) - toC(r.credit_cents);
  const row8007 = tb.find((r) => r.code === "8007");
  const row2000 = tb.find((r) => r.code === "2000");
  const net8007 = row8007 ? toC(row8007.debit_cents) - toC(row8007.credit_cents) : 0;
  const net2000 = row2000 ? toC(row2000.debit_cents) - toC(row2000.credit_cents) : 0;
  console.log(`GL 8007 net DR: $${$(net8007)}`);
  console.log(`GL 2000 net CR: $${$(-net2000)}  (must equal $9,947,831.51 -> diff $${$(-net2000 - 994783151)})`);
  console.log(`trial-balance imbalance: $${$(imbalance)} (must be 0.00)`);

  // 8007 by month AFTER (all journal types)
  const lines = await fetchAll(
    "journal_entry_lines",
    "debit, credit, journal_entries!inner(posting_date, status)",
    (q) => q.eq("account_id", ctx.a8007.id).eq("journal_entries.status", "posted").order("id", { ascending: true }),
  );
  const byYm = new Map();
  for (const l of lines) {
    const ym = String(l.journal_entries.posting_date).slice(0, 7);
    byYm.set(ym, (byYm.get(ym) || 0) + Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100));
  }
  console.log("\n8007 by month after reclass:");
  for (const [ym, c] of [...byYm.entries()].sort()) console.log(`  ${ym}: $${$(c)}`);

  // every reclass JE balanced?
  const reclassJes = await fetchAll("journal_entries", "id, posting_date, description",
    (q) => q.eq("journal_type", "vendor_expense_reclass").eq("status", "posted"));
  const jeIds = reclassJes.map((j) => j.id);
  let jeImbalance = 0, checked = 0;
  for (let i = 0; i < jeIds.length; i += 100) {
    const { data, error } = await admin.from("journal_entry_lines")
      .select("journal_entry_id, debit, credit").in("journal_entry_id", jeIds.slice(i, i + 100)).range(0, 9999);
    if (error) throw new Error(error.message);
    const per = new Map();
    for (const l of data || []) {
      per.set(l.journal_entry_id, (per.get(l.journal_entry_id) || 0) + Math.round(Number(l.debit || 0) * 100) - Math.round(Number(l.credit || 0) * 100));
    }
    for (const [, c] of per) { checked += 1; if (c !== 0) jeImbalance += 1; }
  }
  console.log(`\nreclass JEs posted: ${reclassJes.length}; balanced: ${checked - jeImbalance}/${checked} (unbalanced: ${jeImbalance})`);
}

// ── entry ────────────────────────────────────────────────────────────────────
const phase = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

const phases = {
  report: phaseReport,
  "set-defaults": phaseSetDefaults,
  reclass: phaseReclass,
  verify: phaseVerify,
};
if (!phases[phase]) {
  console.error(`usage: node scripts/reclass-8007.mjs <${Object.keys(phases).join("|")}> [--dry-run] [--limit=N]`);
  process.exit(1);
}
phases[phase]({ dryRun, limit }).catch((e) => { console.error(e); process.exit(1); });
