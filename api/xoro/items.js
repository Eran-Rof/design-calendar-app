// api/xoro/items.js
//
// Planning ingest: item master refresh. Pulls the Xoro item catalog and
// stores it raw. Normalization into ip_item_master is handled in a
// separate pass (Phase 1) so we can hand-tune the mapper without
// re-fetching.

import { fetchXoro, fetchXoroAll } from "../_lib/xoro-client.js";
import { insertRawXoro, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

const ITEMS_PATH = "item/getitem"; // TODO confirm with Xoro

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.searchParams.get("path") || ITEMS_PATH;
  const modifiedSince = url.searchParams.get("modified_since") || "";
  const fetchAll = url.searchParams.get("fetch_all") !== "false";

  const params = { per_page: "500" };
  if (modifiedSince) params.modified_since = modifiedSince;

  const r = fetchAll
    ? await fetchXoroAll({ path, params })
    : await fetchXoro({ path, params });
  if (!r.ok || !r.body?.Result) {
    return res.status(200).json({
      ok: false,
      hint: "Xoro path not confirmed — override with ?path=...",
      xoro: r.body,
    });
  }
  const data = Array.isArray(r.body.Data) ? r.body.Data : [];

  const raw = await insertRawXoro(admin, {
    endpoint: "items",
    params: { ...params, path },
    payload: { data },
    recordCount: data.length,
    ingestedBy: "api/xoro/items",
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
