// api/xoro/sales-history.js
//
// Planning ingest: pull wholesale sales history from Xoro, persist the
// raw payload, return a normalized preview for diagnostics.
//
// Phase 0 scope: establish the handler contract and the raw-payload
// write path. The authoritative Xoro endpoint path for sales history
// is not yet confirmed (same issue documented in xoro-receipts-sync.js),
// so callers may override with ?path=xerp/<module>/<action>. Once the
// real path is known, set SALES_PATH and drop the override.
//
// Query params:
//   date_from=YYYY-MM-DD
//   date_to=YYYY-MM-DD
//   customer=...
//   txn_type=order|ship|invoice (default: invoice)
//   fetch_all=true|false       (default: true)
//   path=override              (optional)
//
// Response:
//   { ok, raw_payload_id, deduped, record_count, normalized_preview: [...] }

import { fetchXoro, fetchXoroAll } from "../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

const SALES_PATH = "salesorder/getsalesorder"; // TODO confirm with Xoro support

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || SALES_PATH;
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const customer = url.searchParams.get("customer") || "";
  const txnType = (url.searchParams.get("txn_type") || "invoice").toLowerCase();
  const fetchAll = url.searchParams.get("fetch_all") !== "false";

  const params = { per_page: "200" };
  if (dateFrom) params.date_from = dateFrom;
  if (dateTo) params.date_to = dateTo;
  if (customer) params.customer = customer;

  const r = fetchAll
    ? await fetchXoroAll({ path, params })
    : await fetchXoro({ path, params });
  if (!r.ok || !r.body?.Result) {
    return res.status(200).json({
      ok: false,
      hint: "Xoro path likely wrong — override with ?path=xerp/<module>/<action>",
      xoro: r.body,
    });
  }
  const data = Array.isArray(r.body.Data) ? r.body.Data : [];

  const raw = await insertRawXoro(admin, {
    endpoint: "sales-history",
    params: { ...params, txn_type: txnType, path },
    payload: { data },
    periodStart: dateFrom || null,
    periodEnd: dateTo || null,
    recordCount: data.length,
    ingestedBy: "api/xoro/sales-history",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: data.length,
    txn_type: txnType,
    // Client-side preview of the first few rows. Normalization happens in
    // a separate pass (Phase 1); we keep this handler focused on ingest.
    sample: data.slice(0, 3),
  });
}
