// POST /api/tanda/upload-sos — bulk Xoro→tanda_sos upload (push model).
//
// The pull twin (tanda/sync-sos-from-xoro.js) walks Xoro from inside a Vercel
// function and OUTGREW the 300s ceiling (~12k SOs → gateway 504 with ZERO rows
// written; tanda_sos sat stale from 2026-06-18). The nightly 21:00 fetch
// (rof_xoro_project/scripts/rest_sales_orders_sync.py) already walks the same
// salesorder/getsalesorder endpoint on a machine with NO time limit — this
// endpoint lets it PUSH what it fetched, so the server does no Xoro I/O at all:
//
//   Xoro ──(21:00 rest_sales_orders_sync.py)──▶ POST here ──▶ tanda_sos
//
// Body (plain JSON or a {"_gz":"<base64>"} gzip envelope, chunkable):
//   { sos: [ <raw Xoro record ({SoEstimateHeader, SoEstimateItemLineArr}) or
//            already-flat record> ], source?: "nightly" }
// Records are flattened with the SAME flattenXoroSo the pull path uses, deduped
// by SoNumber (first sighting wins — send active statuses first), and upserted
// on so_number. Re-posting is idempotent. The caller chunks (~500 SOs/POST) to
// stay under the body limit; each chunk is independent.
//
// Auth: bearer DESIGN_CALENDAR_API_TOKEN (same gate the other nightly push
// endpoints use). Also writes an xoro_sync_logs row (sync_type
// 'nightly_so_upload') when the caller marks the LAST chunk with done:true —
// the feed-health layer reads it.

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";
import { unpackGzipEnvelope } from "../../_lib/gzipEnvelope.js";
import { flattenXoroSo, toIsoDate } from "./sync-sos-from-xoro.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const tokenTail = (req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`tanda-upload-sos:${tokenTail}`, { limit: 120, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const body = unpackGzipEnvelope(req.body) || {};
  const records = Array.isArray(body.sos) ? body.sos : [];
  const requestId = randomUUID();
  const result = {
    request_id: requestId,
    received: records.length,
    sos_unique_after_dedup: 0,
    upserted: 0,
    skipped_no_so_number: 0,
    errors: [],
  };
  if (records.length === 0 && body.done !== true) {
    return res.status(400).json({ ...result, error: "Body must carry sos: [...] (raw or flat Xoro SO records)" });
  }

  try {
    const bySo = new Map();
    for (const raw of records) {
      const flat = flattenXoroSo(raw);
      const soNumber = String(flat.SoNumber ?? "").trim();
      if (!soNumber) { result.skipped_no_so_number++; continue; }
      if (!bySo.has(soNumber)) bySo.set(soNumber, flat);
    }
    result.sos_unique_after_dedup = bySo.size;

    const now = new Date().toISOString();
    const rows = [];
    for (const [soNumber, flat] of bySo) {
      rows.push({
        so_number: soNumber,
        customer: flat.CustomerName ?? "",
        date_order: toIsoDate(flat.DateOrder),
        date_shipped: toIsoDate(flat.DateToBeShipped),
        date_cancel: toIsoDate(flat.DateToBeCancelled),
        status: flat.StatusName ?? "",
        data: flat,
        synced_at: now,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await admin
        .from("tanda_sos")
        .upsert(chunk, { onConflict: "so_number", ignoreDuplicates: false });
      if (error) { result.errors.push(`upsert chunk ${i}: ${error.message}`); continue; }
      result.upserted += chunk.length;
    }

    // Final chunk of the nightly run → freshness log for the mirror/health layer.
    if (body.done === true) {
      try {
        await admin.from("xoro_sync_logs").insert({
          sync_type: "nightly_so_upload",
          status: result.errors.length ? "error" : "complete",
          started_at: now,
          completed_at: new Date().toISOString(),
          records_processed: result.upserted,
          error_message: result.errors.length ? result.errors.join("; ").slice(0, 500) : null,
          raw_summary: { request_id: requestId, source: "tanda/upload-sos" },
        });
      } catch (e) {
        result.errors.push(`xoro_sync_logs write failed: ${String(e?.message || e)}`);
      }
    }

    return res.status(result.errors.length ? 207 : 200).json(result);
  } catch (e) {
    console.error(`[tanda/upload-sos ${requestId}] failed:`, e);
    return res.status(500).json({ ...result, error: "Upload failed", message: String(e?.message || e) });
  }
}
