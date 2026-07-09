#!/usr/bin/env node
// Import the Xoro Bills register export (Bills_07082026.csv) into the
// ap_bill_register_import staging table, resolving vendors as we go.
//
// Usage:
//   node scripts/import-bills-register.mjs <path-to-csv> [--create-vendors] [--dry-run]
//
// - Parses the register CSV (UTF-8 BOM, "$ 1,234.19" money, "-" = empty,
//   MM/DD/YYYY dates, quoted fields).
// - Verifies the register identity per row:
//     Total = Paid + Discounts + TotalCreditsApplied + Due
//   (TotalCreditsApplied already CONTAINS VendorCredits + Prepayments.)
// - Resolves each Vendor name → vendors.id:
//     1) exact vendor_name match already established in ap_payment_import
//        (keeps bill and payment subledger entries on the SAME vendor row)
//     2) vendors.name case-insensitive
//     3) vendors.aliases case-insensitive
//     4) with --create-vendors: create a minimal vendors row (code VEND-NNNNN
//        via MAX(suffix)+1) — otherwise report unmatched and leave vendor_id
//        NULL (posting refuses NULL-vendor rows).
// - Upserts staging rows on bill_number (re-runs are safe; posting state
//   columns are preserved on conflict).
//
// Posting itself is scripts/post-bills-register.mjs.

import { readFileSync } from "fs";
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

// ── CSV parsing ──────────────────────────────────────────────────────────────
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

export const moneyCents = (s) => {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s || s === "-") return 0;
  const neg = /^\(.*\)$/.test(s) || s.includes("-");
  const n = s.replace(/[$,()\s]/g, "").replace(/-/g, "");
  if (n === "") return 0;
  const cents = Math.round(parseFloat(n) * 100);
  return neg ? -cents : cents;
};

export const usDate = (s) => {
  s = String(s || "").trim();
  if (!s || s === "-" || s.startsWith("01/01/0001")) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
};

const usTimestamp = (s) => {
  const d = usDate(s);
  return d; // we only keep the date part for created_datetime fidelity we store the date at midnight
};

const str = (v) => (v == null ? "" : String(v).trim());
const nul = (v) => { const s = str(v); return !s || s === "-" ? null : s; };

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const createVendors = args.includes("--create-vendors");
  const dryRun = args.includes("--dry-run");
  if (!csvPath) { console.error("usage: node scripts/import-bills-register.mjs <csv> [--create-vendors] [--dry-run]"); process.exit(1); }

  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  const h = Object.fromEntries(rows[0].map((x, i) => [x.trim(), i]));
  const need = ["Bill Date", "Vendor", "Bill Number", "Status", "Total Amount", "Amount Paid", "Amount Due"];
  for (const n of need) if (h[n] == null) { console.error(`CSV missing column: ${n}`); process.exit(1); }

  const bills = rows.slice(1).map((r) => ({
    bill_number: str(r[h["Bill Number"]]),
    vendor_bill_number: nul(r[h["Vendor Bill#"]]),
    receipt_date: usDate(r[h["Receipt Date"]]),
    bill_date: usDate(r[h["Bill Date"]]),
    due_date: usDate(r[h["Due Date"]]),
    discount_date: usDate(r[h["Discount Date"]]),
    payment_term: nul(r[h["Payment Term"]]),
    vendor_name: str(r[h["Vendor"]]),
    vendor_type: nul(r[h["Vendor Type"]]),
    store: nul(r[h["Store"]]),
    status: str(r[h["Status"]]),
    total_cents: moneyCents(r[h["Total Amount"]]),
    paid_cents: moneyCents(r[h["Amount Paid"]]),
    discounts_cents: moneyCents(r[h["Discounts Applied"]]),
    due_cents: moneyCents(r[h["Amount Due"]]),
    credits_cents: moneyCents(r[h["Total Credits Applied"]]),
    vendor_credits_cents: moneyCents(r[h["Vendor Credits Applied"]]),
    prepayments_cents: moneyCents(r[h["Prepayments Applied"]]),
    payment_amount_cents: moneyCents(r[h["Payment Amount"]]),
    total_qty: (() => { const s = str(r[h["Total Qty"]]); const n = Number(s.replace(/,/g, "")); return s && Number.isFinite(n) ? n : null; })(),
    created_datetime: usTimestamp(r[h["Create Datetime"]]),
    created_by: nul(r[h["Created By"]]),
    modified_date: usDate(r[h["Modified Datetime"]]),
    modified_by: nul(r[h["Modified By"]]),
    buyer_name: nul(r[h["Buyer Name"]]),
  })).filter((b) => b.bill_number);

  console.log(`parsed ${bills.length} bills`);

  // Register identity check: Total = Paid + Discounts + Credits + Due.
  let identityBad = 0;
  for (const b of bills) {
    if (b.total_cents !== b.paid_cents + b.discounts_cents + b.credits_cents + b.due_cents) {
      identityBad++;
      if (identityBad <= 10) console.error(`  identity FAIL ${b.bill_number}: T ${b.total_cents} ≠ P ${b.paid_cents} + D ${b.discounts_cents} + C ${b.credits_cents} + Due ${b.due_cents}`);
    }
    if (b.credits_cents !== b.vendor_credits_cents + b.prepayments_cents) {
      identityBad++;
      if (identityBad <= 10) console.error(`  credits split FAIL ${b.bill_number}: C ${b.credits_cents} ≠ VC ${b.vendor_credits_cents} + PP ${b.prepayments_cents}`);
    }
  }
  if (identityBad) { console.error(`${identityBad} identity failures — aborting (register semantics changed?)`); process.exit(1); }
  console.log("register identity holds on every row (Total = Paid + Discounts + Credits + Due; Credits = VendorCredits + Prepayments)");

  // Duplicate bill numbers would break the staging UNIQUE + JE idempotency.
  const seen = new Set();
  for (const b of bills) {
    if (seen.has(b.bill_number)) { console.error(`duplicate bill number ${b.bill_number} — aborting`); process.exit(1); }
    seen.add(b.bill_number);
  }

  // ── vendor resolution ──────────────────────────────────────────────────────
  // 1) names already resolved by the payments staging (same Xoro name space)
  const payVendorByName = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("ap_payment_import")
      .select("vendor_name, vendor_id").not("vendor_id", "is", null)
      .order("payment_number", { ascending: true }).range(from, from + 999);
    if (error) { console.error("ap_payment_import read failed:", error.message); process.exit(1); }
    for (const r of data || []) if (!payVendorByName.has(r.vendor_name.toLowerCase())) payVendorByName.set(r.vendor_name.toLowerCase(), r.vendor_id);
    if (!data || data.length < 1000) break;
  }
  // 2/3) vendors by name + aliases
  const vendors = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("vendors")
      .select("id, name, code, aliases").is("deleted_at", null)
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.error("vendors read failed:", error.message); process.exit(1); }
    vendors.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const vendorByName = new Map();
  for (const v of vendors) {
    vendorByName.set(v.name.trim().toLowerCase(), v.id);
    for (const a of v.aliases || []) if (a) vendorByName.set(String(a).trim().toLowerCase(), v.id);
  }

  const unmatched = new Map(); // name → bill count
  const resolved = new Map();  // name(lower) → vendor_id
  for (const b of bills) {
    const key = b.vendor_name.toLowerCase();
    if (resolved.has(key)) continue;
    const id = payVendorByName.get(key) || vendorByName.get(key) || null;
    if (id) resolved.set(key, id);
    else unmatched.set(b.vendor_name, (unmatched.get(b.vendor_name) || 0) + 1);
  }
  console.log(`vendors: ${resolved.size} resolved, ${unmatched.size} unmatched`);
  if (unmatched.size) {
    for (const [name, n] of unmatched) console.log(`  UNMATCHED vendor: ${JSON.stringify(name)} (${n}+ bills)`);
    if (!createVendors) {
      console.log("re-run with --create-vendors to create the missing vendors rows");
    } else if (!dryRun) {
      // autoCode: MAX(suffix)+1, not COUNT+1 (feedback_autocode_max_not_count).
      let maxSuffix = 0;
      for (const v of vendors) { const m = /^VEND-(\d+)$/.exec(v.code || ""); if (m) maxSuffix = Math.max(maxSuffix, Number(m[1])); }
      for (const [name] of unmatched) {
        const code = `VEND-${String(++maxSuffix).padStart(5, "0")}`;
        const { data, error } = await admin.from("vendors")
          .insert({ name, code, status: "active" }).select("id").single();
        if (error) { console.error(`  create vendor ${name} failed: ${error.message}`); process.exit(1); }
        resolved.set(name.toLowerCase(), data.id);
        console.log(`  created vendor ${code} ${name}`);
      }
      unmatched.clear();
    }
  }

  if (dryRun) { console.log("dry-run — no staging writes"); return; }

  // ── upsert staging (preserve posting-state columns on conflict) ───────────
  let upserted = 0;
  for (let i = 0; i < bills.length; i += 500) {
    const chunk = bills.slice(i, i + 500).map((b) => ({ ...b, vendor_id: resolved.get(b.vendor_name.toLowerCase()) || null }));
    const { error } = await admin.from("ap_bill_register_import")
      .upsert(chunk, { onConflict: "bill_number", ignoreDuplicates: false });
    if (error) { console.error(`staging upsert failed at ${i}: ${error.message}`); process.exit(1); }
    upserted += chunk.length;
  }
  console.log(`staged ${upserted} bills into ap_bill_register_import`);
}

main().catch((e) => { console.error(e); process.exit(1); });
