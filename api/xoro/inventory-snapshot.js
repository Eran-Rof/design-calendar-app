// api/xoro/inventory-snapshot.js
//
// Planning ingest: point-in-time inventory snapshot from Xoro. By
// convention, one call per (warehouse, date). If the Xoro path supports
// pulling all warehouses in one go, caller passes fetch_all=true.

import { fetchXoro, fetchXoroAll } from "../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

const INVENTORY_PATH = "inventory/getinventory"; // TODO confirm with Xoro

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || INVENTORY_PATH;
  const warehouse = url.searchParams.get("warehouse") || "";
  const asOf = url.searchParams.get("as_of") || new Date().toISOString().slice(0, 10);
  const fetchAll = url.searchParams.get("fetch_all") !== "false";

  const params = { per_page: "500" };
  if (warehouse) params.warehouse = warehouse;
  if (asOf) params.as_of = asOf;

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
    endpoint: "inventory-snapshot",
    params: { ...params, path },
    payload: { data },
    periodStart: asOf,
    periodEnd: asOf,
    recordCount: data.length,
    ingestedBy: "api/xoro/inventory-snapshot",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: data.length,
    as_of: asOf,
    sample: data.slice(0, 3),
  });
}
