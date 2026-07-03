#!/usr/bin/env node
// Rebuild Tangerine's synced on-hand inventory_layers from the authoritative
// nightly ATS/Xoro snapshot (ip_inventory_snapshot source='manual'). This is
// the controlled-rollout runner for the phantom-on-hand recurrence fix
// (Option A). The same logic runs nightly inside /api/planning/sync-on-hand
// when ONHAND_LAYER_SYNC=apply; this script lets the operator dry-run and stage
// it per style first.
//
// DRY-RUN by default (no writes). See api/_lib/inventory/onhand-sync.js for the
// manage/skip invariants (skips by-size + any natively-touched style).
//
// Usage:
//   node scripts/rebuild-onhand-sync.mjs                       # dry-run, whole feed
//   node scripts/rebuild-onhand-sync.mjs --style CYB0074,RYB0335   # dry-run, scoped
//   node scripts/rebuild-onhand-sync.mjs --apply --style RYB0335   # WRITE prod, one style
//   node scripts/rebuild-onhand-sync.mjs --apply                   # WRITE prod, whole feed
//   node scripts/rebuild-onhand-sync.mjs --date 2026-06-29         # pin the feed date
//
// Prod service-role key is minted at runtime via the linked supabase CLI
// (same pattern as ingest-size-onhand.mjs); nothing is persisted.

import { execFileSync } from "node:child_process";
import { rebuildOnHandSync } from "../api/_lib/inventory/onhand-sync.js";

const PROD_REF = "qcvqvxxoperiurauoxmp";
const ROF_ENTITY_ID = "404b8a6b-0d2d-44d2-8539-9064ff0fafee";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const APPLY = has("--apply");
const styleCodes = (val("--style") || "").split(",").map((s) => s.trim()).filter(Boolean);
const snapshotDate = val("--date") || null;

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

console.log(`# rebuild-onhand-sync  mode=${APPLY ? "APPLY (writes PROD)" : "DRY-RUN"}`);
if (styleCodes.length) console.log(`# styles: ${styleCodes.join(", ")}`);

const res = await rebuildOnHandSync(admin, {
  apply: APPLY,
  styleCodes: styleCodes.length ? styleCodes : null,
  snapshotDate,
  entityId: ROF_ENTITY_ID,
});

console.log(JSON.stringify(res, null, 2));
process.exit(res.error ? 1 : 0);
