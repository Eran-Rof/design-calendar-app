// api/xoro/receipts.js
//
// Planning ingest for PO receipts. Mirrors xoro-receipts-sync.js but
// writes to the raw_xoro_payloads layer instead of the vendor-portal
// receipts table. Keeps the two concerns independent.

import { fetchXoro, fetchXoroAll } from "../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

// Matches the RECEIPT_PATH convention in xoro-receipts-sync.js — both
// handlers will converge on the real path once Xoro confirms.
const RECEIPT_PATH = "itemreceipt/getitemreceipt";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || RECEIPT_PATH;
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const poNumber = url.searchParams.get("po_number") || "";
  const fetchAll = url.searchParams.get("fetch_all") !== "false";

  const params = { per_page: "200" };
  if (dateFrom) params.date_from = dateFrom;
  if (dateTo) params.date_to = dateTo;
  if (poNumber) params.po_number = poNumber;

  const r = fetchAll
    ? await fetchXoroAll({ path, params })
    : await fetchXoro({ path, params });
  if (!r.ok || !r.body?.Result) {
    return res.status(200).json({
      ok: false,
      hint: "Xoro path not confirmed — try ?path=<module>/<action>",
      xoro: r.body,
    });
  }
  const data = Array.isArray(r.body.Data) ? r.body.Data : [];

  const raw = await insertRawXoro(admin, {
    endpoint: "receipts",
    params: { ...params, path },
    payload: { data },
    periodStart: dateFrom || null,
    periodEnd: dateTo || null,
    recordCount: data.length,
    ingestedBy: "api/xoro/receipts",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: data.length,
    sample: data.slice(0, 3),
  });
}
