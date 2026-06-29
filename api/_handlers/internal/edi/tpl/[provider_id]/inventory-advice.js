// api/internal/edi/tpl/:provider_id/inventory-advice
//
// 3PL nightly inventory reconciliation ingest. The 3PL reports its current
// on-hand per SKU — as an X12 846 (Inventory Advice), a CSV, or JSON — and this
// endpoint parses it into { sku, qty_on_hand } lines and hands them to the
// shared reconcile (api/_lib/tplInventoryRecon.js): store the dated snapshot,
// resolve sku→item, and compute the variance vs Tangerine on-hand (location +
// total) into tpl_inventory_differences. The nightly SFTP-pull cron uses the
// same reconcile.
//
// POST body (any of):
//   • raw X12 846 string, or { raw: "<X12>" }
//   • { lines: [{ sku, qty }], source?, snapshot_date? }
//   • { csv: "sku,qty\n...", source? }   (header row optional)
//
// GET ?provider_id=&snapshot_id=   → that snapshot's differences (+ summary)
// GET ?provider_id=                → the provider's latest snapshot's differences
// GET ?provider_id=&list=1         → recent snapshots (history)

import { createClient } from "@supabase/supabase-js";
import { parse846 } from "../../../../../_lib/edi/builder.js";
import { parseEnvelope } from "../../../../../_lib/edi/parser.js";
import { reconcileSnapshot, parseInventoryCsv } from "../../../../../_lib/tplInventoryRecon.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
function getProviderId(req) {
  if (req.query && req.query.provider_id) return req.query.provider_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("tpl");
  return idx >= 0 ? parts[idx + 1] : null;
}
// Parse a raw X12 846 envelope → [{ sku, qty_on_hand }].
function linesFrom846(x12) {
  const env = parseEnvelope(x12);
  const txn = env.groups?.[0]?.transactions?.[0];
  const parsed = parse846((txn?.segments || []).map((s) => s));
  return (parsed.lines || []).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty_on_hand: Number(l.qty_on_hand) || 0 }));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const providerId = getProviderId(req);
  if (!providerId || !UUID_RE.test(String(providerId))) return res.status(400).json({ error: "Invalid provider id" });

  const { data: provider } = await admin
    .from("tpl_providers").select("id, name, entity_id, location_id").eq("id", providerId).maybeSingle();
  if (!provider) return res.status(404).json({ error: "3PL provider not found" });

  // ── GET: read differences ─────────────────────────────────────────────────
  if (req.method === "GET") {
    const q = req.query || {};
    let qsList = q.list, qsSnap = q.snapshot_id;
    try {
      const url = new URL(req.url, `https://${req.headers.host || "x"}`);
      qsList = qsList ?? url.searchParams.get("list");
      qsSnap = qsSnap ?? url.searchParams.get("snapshot_id");
    } catch { /* req.query is enough */ }
    if (qsList) {
      const { data: snaps } = await admin
        .from("tpl_inventory_snapshots")
        .select("id, snapshot_date, source, line_count, matched_count, created_at")
        .eq("tpl_provider_id", provider.id).order("created_at", { ascending: false }).limit(60);
      return res.status(200).json({ provider: { id: provider.id, name: provider.name }, snapshots: snaps || [] });
    }
    let snapshotId = qsSnap;
    if (!snapshotId) {
      const { data: latest } = await admin
        .from("tpl_inventory_snapshots").select("id").eq("tpl_provider_id", provider.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      snapshotId = latest?.id || null;
    }
    if (!snapshotId) return res.status(200).json({ provider: { id: provider.id, name: provider.name }, snapshot: null, differences: [] });
    const [{ data: snap }, { data: diffs }] = await Promise.all([
      admin.from("tpl_inventory_snapshots").select("id, snapshot_date, source, line_count, matched_count, created_at").eq("id", snapshotId).maybeSingle(),
      admin.from("tpl_inventory_differences").select("sku_code, qty_3pl, qty_tangerine_location, qty_tangerine_total, direction").eq("snapshot_id", snapshotId).order("sku_code"),
    ]);
    return res.status(200).json({ provider: { id: provider.id, name: provider.name, has_location: !!provider.location_id }, snapshot: snap || null, differences: diffs || [] });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── POST: parse input → lines → reconcile ──────────────────────────────────
  let lines = null, source = "manual", raw = null, snapshotDate = null;
  const bodyStr = typeof req.body === "string" ? req.body : null;
  let body = req.body;
  if (bodyStr) { try { body = JSON.parse(bodyStr); } catch { body = null; } }

  try {
    if (bodyStr && /\bISA\b|\bLIN\b/.test(bodyStr) && !body) {
      lines = linesFrom846(bodyStr); source = "edi846"; raw = bodyStr;
    } else if (body && typeof body === "object") {
      if (typeof body.raw === "string") { lines = linesFrom846(body.raw); source = "edi846"; raw = body.raw; }
      else if (typeof body.csv === "string") { lines = parseInventoryCsv(body.csv); source = "csv"; raw = body.csv; }
      else if (Array.isArray(body.lines)) {
        lines = body.lines.map((l) => ({ sku: String(l.sku ?? l.sku_code ?? "").trim(), qty_on_hand: Number(l.qty ?? l.qty_on_hand ?? 0) || 0 })).filter((l) => l.sku);
        source = body.source === "edi846" ? "edi846" : "json"; raw = JSON.stringify(body.lines);
      }
      if (body.snapshot_date) snapshotDate = body.snapshot_date;
    } else if (bodyStr) {
      lines = parseInventoryCsv(bodyStr); source = "csv"; raw = bodyStr;
    }
  } catch (e) {
    return res.status(400).json({ error: `Could not parse inventory input: ${e?.message || e}` });
  }

  if (!lines || lines.length === 0) {
    return res.status(400).json({ error: "No inventory lines found. Provide an X12 846, a CSV ('sku,qty' rows), or { lines:[{sku,qty}] }." });
  }

  const result = await reconcileSnapshot(admin, provider, lines, { source, raw, snapshotDate });
  if (!result.ok) return res.status(500).json({ error: result.error || "Reconcile failed" });
  return res.status(201).json(result);
}
