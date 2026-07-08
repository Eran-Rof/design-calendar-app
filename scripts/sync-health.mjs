#!/usr/bin/env node
// scripts/sync-health.mjs — print the Xoro-bridge feed health (v_xoro_feed_health)
// from PROD. The CLI twin of the Sync Health panel / xoro-feed-health-alert cron.
//
//   npm run sync-health            # table of every feed
//   npm run sync-health -- --bad   # exit 1 if any feed is stale/never (for scripts)
//
// Reads SUPABASE_PAT from .env.local and queries via the Management API
// (same transport as run-sql-prod.mjs).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROD_REF = "qcvqvxxoperiurauoxmp";
const BAD_ONLY_EXIT = process.argv.includes("--bad");

function pat() {
  for (const f of [".env.local", ".env.staging"]) {
    try {
      const line = readFileSync(resolve(ROOT, f), "utf8").split("\n").find((l) => l.startsWith("SUPABASE_PAT"));
      if (line) return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  console.error("✗ SUPABASE_PAT not found in .env.local");
  process.exit(2);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROD_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${pat()}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: "select * from v_xoro_feed_health order by (status = 'ok'), feed" }),
});
if (!res.ok) { console.error(`✗ query failed: ${res.status} ${await res.text()}`); process.exit(2); }
const rows = await res.json();

const ICON = { ok: "🟢", stale: "🔴", never: "🔴" };
let bad = 0;
console.log("Xoro bridge — feed health\n");
for (const r of rows) {
  if (r.status !== "ok") bad++;
  const age = r.last_at ? `${r.hours_since}h ago (${String(r.last_at).slice(0, 16)})` : "NEVER";
  console.log(`${ICON[r.status] || "??"} ${r.feed.padEnd(20)} ${String(r.status).toUpperCase().padEnd(6)} last: ${age.padEnd(30)} threshold: ${r.threshold_hours}h`);
  console.log(`   ${r.label}`);
}
console.log(`\n${rows.length - bad}/${rows.length} feeds ok${bad ? ` — ${bad} NOT flowing` : ""}`);
process.exit(BAD_ONLY_EXIT && bad ? 1 : 0);
