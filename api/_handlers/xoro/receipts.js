// api/xoro/receipts.js
//
// Raw-audit ingest for PO item receipts. Mirrors xoro-receipts-sync.js but
// writes the untouched Xoro payload to the raw_xoro_payloads layer instead
// of the normalized receipts / receipt_line_items tables. Keeps the audit
// (replayable raw) and consumer (structured) concerns independent.
//
// Path: bill/getitemreceipt via module="bill" — the CONFIRMED endpoint
// (2026-07-21). The Item Receipt resource is nested under the `bill` module
// because it shares the "Bill & Item Receipt Management" Private App scope;
// the ATS/Sales keys 500 on it. (The prior `itemreceipt/getitemreceipt`
// guess never existed — every candidate under that prefix returned a
// generic 500. See rof_xoro_project/scripts/probe_receipt_endpoints.py.)

import { fetchXoro, fetchXoroAll } from "../../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

const RECEIPT_PATH = "bill/getitemreceipt";
const RECEIPT_MODULE = "bill";

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
    ? await fetchXoroAll({ path, params, module: RECEIPT_MODULE })
    : await fetchXoro({ path, params, module: RECEIPT_MODULE });
  if (!r.ok || !r.body?.Result) {
    return res.status(200).json({
      ok: false,
      hint: "check VITE_XORO_BILL_API_KEY/SECRET (module=bill) and path=bill/getitemreceipt",
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
