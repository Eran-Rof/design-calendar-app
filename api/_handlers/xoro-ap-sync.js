// api/xoro-ap-sync.js — Vercel Node.js Serverless Function
//
// Phase 2.7 — pulls bills (AP invoices) from Xoro and updates our
// invoices table with payment status. Called on-demand from the internal
// TandA UI, and nightly by the cron at api/cron/xoro-ap-sync.js.
//
// The actual sync logic now lives in api/_lib/xoro-ap-sync.js
// (runXoroApSync) so the manual handler and the cron share ONE source of
// truth. This handler just parses query params, calls it, and maps the
// result to the same HTTP responses the manual endpoint has always
// returned. Accepts query params date_from / date_to / po_number.

import { runXoroApSync, BILL_PATH } from "../_lib/xoro-ap-sync.js";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const poNumber = url.searchParams.get("po_number") || "";

  const result = await runXoroApSync({
    date_from: dateFrom,
    date_to: dateTo,
    po_number: poNumber,
    origin: `https://${req.headers.host}`,
  });

  // Map the shared function's result to the historical HTTP responses.
  if (result?.error === "Server not configured") {
    return res.status(500).json(result);
  }
  if (typeof result?.error === "string" && result.error.startsWith("Xoro fetch failed")) {
    return res.status(500).json({ error: result.error, path: result.path || BILL_PATH });
  }
  // "Xoro returned an error or empty dataset" historically returned 200.
  return res.status(200).json(result);
}
