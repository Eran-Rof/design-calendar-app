// api/xoro/open-pos.js
//
// Planning ingest for the open PO book. Xoro already surfaces POs through
// xoro-proxy.js (used by TandA) but that endpoint is shaped for per-PO
// operational work. Here we pull a flattened cross-PO snapshot for
// planning and write to raw_xoro_payloads.

import { fetchXoro, fetchXoroAll } from "../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

// Xoro's confirmed path for POs is `purchaseorder/getpurchaseorder` (used
// by xoro-proxy callers). We default to it here, still allow override.
const OPEN_POS_PATH = "purchaseorder/getpurchaseorder";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || OPEN_POS_PATH;
  const status = url.searchParams.get("status") || "Open";
  const fetchAll = url.searchParams.get("fetch_all") !== "false";

  const params = { per_page: "200", status };

  const r = fetchAll
    ? await fetchXoroAll({ path, params })
    : await fetchXoro({ path, params });
  if (!r.ok || !r.body?.Result) {
    return res.status(200).json({ ok: false, xoro: r.body });
  }
  const data = Array.isArray(r.body.Data) ? r.body.Data : [];

  const raw = await insertRawXoro(admin, {
    endpoint: "open-pos",
    params: { ...params, path },
    payload: { data },
    recordCount: data.length,
    ingestedBy: "api/xoro/open-pos",
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
