// api/_handlers/cron/ar-payload-ingest.js
//
// Nightly ONGOING capture of raw Xoro invoice/getinvoice payloads into
// raw_xoro_payloads(endpoint='sales-history') — the size-grain feed that
// ar-sizegrain.js explodes into per-size AR invoice lines (#1821).
//
// Runs at 01:00 UTC, ~30 min BEFORE xoro-mirror-nightly (01:30 UTC) so freshly
// captured payloads feed that night's AR mirror explosion.
//
// ⚠️ invoice/getinvoice returns ONLY open invoices (verified #1824 — it ignores
// every filter param). Every invoice must be captured while still open; once
// paid it drops out of the reachable universe forever. This cron makes that
// capture happen every night. It is idempotent (skip-already-archived) so a
// re-run writes nothing new. See api/_lib/xoro-mirror/ar-payload-ingest.js.
//
// MODE: TAIL sweep by default — page 1 probe (authoritative TotalPages, and
// its records are archived too) + the LAST ?tail_pages=4 pages. Xoro paginates
// oldest-first, so newly opened invoices land on the tail. A full ~44-page
// walk takes ~35 min at the measured ~45s/page and cannot fit the 300s
// function budget; the one-time full sweep runs from
// scripts/backfills/ar-payload-ingest.mjs (resumable chunks). Passing
// ?page_start= switches this handler to a forward chunk walk for manual
// HTTP-driven backfills (keep max_pages ≤ 5 to stay under maxDuration).

import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll, xoroCredsFromEnv } from "../../_lib/xoro-client.js";
import {
  sweepOpenInvoicePayloads,
  makeXoroInvoiceFetchPage,
} from "../../_lib/xoro-mirror/ar-payload-ingest.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });

  // The Sales History private app is the ONLY credential that can read
  // invoice/getinvoice (the ATS/default keys 500 on it).
  const creds = xoroCredsFromEnv("sales");
  if (!creds.ok) {
    return res.status(500).json({ error: "XORO_SALES_CREDENTIALS_MISSING", detail: creds.error });
  }

  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  // Default: tail mode (page 1 probe + last 4 pages ≈ 5 × ~45s fetches, fits
  // maxDuration=300). ?page_start= flips to a forward chunk walk.
  let pageStart = null;
  let maxPages = 4;
  let tailPages = 4;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const ps = url.searchParams.get("page_start");
    if (ps != null && ps !== "") {
      pageStart = Math.max(1, parseInt(ps, 10) || 1);
      tailPages = null;
    }
    maxPages = Math.min(Math.max(1, parseInt(url.searchParams.get("max_pages") || "4", 10) || 4), 500);
    const tp = url.searchParams.get("tail_pages");
    if (tailPages != null && tp != null && tp !== "") {
      tailPages = Math.min(Math.max(1, parseInt(tp, 10) || 4), 500);
    }
  } catch { /* defaults */ }

  const fetchPage = makeXoroInvoiceFetchPage(fetchXoroAll, { perPage: 100, module: "sales" });

  try {
    const summary = await sweepOpenInvoicePayloads(
      { fetchPage, admin },
      tailPages != null
        ? { tailPages, batchSize: 50 }
        : { pageStart, maxPages, batchSize: 50 },
    );
    const ok = summary.errors.length === 0;
    return res.status(200).json({ ok, ...summary });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
