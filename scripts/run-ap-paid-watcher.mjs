#!/usr/bin/env node
// CLI driver for the AP AmountPaid delta-watcher (api/_lib/ap-paid-watcher.js).
//
// Usage:
//   node scripts/run-ap-paid-watcher.mjs [--dry-run]
//
// Run this right after importing a fresh Bills-register / Payments export
// (import-bills-register.mjs) instead of waiting for the 06:30 UTC cron —
// the run is idempotent, so cron + manual runs never double-post.
//
// Env: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env/.env.local.
// If the service key is stale ("Unregistered API key" — it rotates), the
// script self-heals by revealing the live service_role JWT via the Supabase
// Management API with SUPABASE_PAT (#1668 recipe).

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { runApPaidWatcher } from "../api/_lib/ap-paid-watcher.js";

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
let SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SERVICE_KEY) { console.error("Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

async function buildAdmin() {
  let admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await admin.from("entities").select("id").limit(1);
  if (!error) return admin;
  if (!/api key/i.test(error.message || "")) throw new Error(`Supabase probe failed: ${error.message}`);
  const PAT = env.SUPABASE_PAT || process.env.SUPABASE_PAT;
  if (!PAT) throw new Error(`service key rejected (${error.message}) and no SUPABASE_PAT to reveal a live one`);
  const ref = new URL(SB_URL).hostname.split(".")[0];
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!r.ok) throw new Error(`Management API key reveal failed: ${r.status}`);
  const keys = await r.json();
  const svc = (keys || []).find((k) => k.name === "service_role" && k.api_key);
  if (!svc) throw new Error("no service_role key in Management API response");
  console.error("(.env service key stale — using live service_role key from the Management API)");
  SERVICE_KEY = svc.api_key;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

const dryRun = process.argv.includes("--dry-run");
const admin = await buildAdmin();
const out = await runApPaidWatcher(admin, { dryRun });
console.log(JSON.stringify(out, null, 2));
process.exit(out.errors.length ? 1 : 0);
