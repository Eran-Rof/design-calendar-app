#!/usr/bin/env node
// One-time backfill: seed provisional selling prices for the styles on every
// already-issued PO (issued / in_transit / received) that have no selling
// history, at a 21% margin off the PO line cost. Idempotent — re-running only
// upserts the same rows and deactivates provisionals for styles that have since
// gained selling history. Uses the same seedProvisionalForPo the PO-issue hook
// calls, so behaviour matches exactly.
//
// Usage:
//   node scripts/backfill-provisional-prices.mjs            # DRY-RUN (counts only)
//   node scripts/backfill-provisional-prices.mjs --apply    # WRITE prod
//
// Prod service-role key is minted at runtime via the linked supabase CLI.

import { execFileSync } from "node:child_process";
import { seedProvisionalForPo } from "../api/_lib/pricing/provisionalPrices.js";

const PROD_REF = "qcvqvxxoperiurauoxmp";
const APPLY = process.argv.slice(2).includes("--apply");

function prodServiceKey() {
  const out = execFileSync("supabase", ["projects", "api-keys", "--project-ref", PROD_REF], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: true,
  });
  const line = out.split(/\r?\n/).find((l) => /\bservice_role\b/.test(l));
  const m = line && line.match(/(eyJ[\w-]+\.[\w-]+\.[\w-]+)/);
  if (!m) throw new Error("could not parse service_role key from `supabase projects api-keys`");
  return m[1];
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(`https://${PROD_REF}.supabase.co`, prodServiceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`# backfill-provisional-prices  mode=${APPLY ? "APPLY (writes PROD)" : "DRY-RUN"}`);
if (!APPLY) {
  console.log("# DRY-RUN: listing issued POs only; pass --apply to seed. (The seeder itself always writes, so dry-run just reports the PO set.)");
}

const { data: pos, error } = await admin.from("purchase_orders")
  .select("id, po_number, status")
  .in("status", ["issued", "in_transit", "received"])
  .order("order_date", { ascending: false });
if (error) { console.error("failed to load POs:", error.message); process.exit(1); }

console.log(`# ${pos.length} issued/in_transit/received PO(s)`);
let seeded = 0, deactivated = 0, done = 0;
for (const po of pos) {
  if (!APPLY) { done++; continue; }
  try {
    const r = await seedProvisionalForPo(admin, po.id);
    seeded += r.seeded; deactivated += r.deactivated; done++;
    if (r.seeded || r.deactivated) console.log(`  ${po.po_number || po.id}: +${r.seeded} seeded, -${r.deactivated} deactivated`);
  } catch (e) {
    console.error(`  ${po.po_number || po.id}: ERROR ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`# done: processed ${done} PO(s); ${seeded} provisional prices seeded, ${deactivated} deactivated`);
process.exit(0);
