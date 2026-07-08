// api/_lib/errorCapture.js — persist runtime errors to app_errors.
//
// The daily app-errors-digest cron groups these by fingerprint into ONE
// bell+email. Fingerprinting normalizes volatile tokens (uuids, numbers, hex
// ids) so "PO 123 not found" and "PO 456 not found" group together.
//
// captureError is awaited by callers on their ERROR path only (an extra
// ~50ms on a request that already failed is fine; fire-and-forget risks the
// lambda freezing before the insert lands). It never throws and never blocks
// longer than CAPTURE_TIMEOUT_MS.

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const CAPTURE_TIMEOUT_MS = 1500;

let _client;
function admin() {
  if (_client !== undefined) return _client;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  _client = SB_URL && KEY ? createClient(SB_URL, KEY, { auth: { persistSession: false } }) : null;
  return _client;
}

export function fingerprintOf(route, message) {
  const norm = String(message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .slice(0, 200);
  return crypto.createHash("sha1").update(`${route || ""}|${norm}`).digest("hex").slice(0, 16);
}

/**
 * @param {{source:'api'|'client'|'cron', route?:string, method?:string,
 *          message:string, stack?:string, context?:object}} e
 */
export async function captureError(e) {
  try {
    const a = admin();
    if (!a) return;
    const row = {
      source: e.source,
      route: (e.route || "").slice(0, 300) || null,
      method: (e.method || "").slice(0, 10) || null,
      message: String(e.message || "unknown error").slice(0, 2000),
      stack: e.stack ? String(e.stack).slice(0, 6000) : null,
      fingerprint: fingerprintOf(e.route, e.message),
      context: e.context && typeof e.context === "object" ? e.context : {},
    };
    await Promise.race([
      a.from("app_errors").insert(row),
      new Promise((r) => setTimeout(r, CAPTURE_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // Never let the capture path throw into the caller's error path.
    console.error("[error-capture] failed:", err?.message || err);
  }
}
