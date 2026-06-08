// api/internal/edi/tpl/:provider_id/inventory-advice
//
// 3PL nightly inventory reconciliation ingest. The 3PL reports its current
// on-hand per SKU — as an X12 846 (Inventory Advice), a CSV, or JSON — and this
// endpoint:
//   1. parses the snapshot into { sku_code, qty_on_hand } lines,
//   2. resolves each sku_code → ip_item_master.id,
//   3. stores tpl_inventory_snapshots + _lines (+ an edi_messages audit row for X12),
//   4. computes the variance vs Tangerine on-hand (inventory_layers) at the
//      provider's location AND total, writing tpl_inventory_differences,
//   5. returns a summary.
//
// POST body (any of):
//   • raw X12 846 string, or { raw: "<X12>" }
//   • { lines: [{ sku, qty }], source?, snapshot_date? }
//   • { csv: "sku,qty\n...", source? }   (header row optional)
//
// GET ?provider_id=&snapshot_id=   → that snapshot's differences (+ summary)
// GET ?provider_id=                → the provider's latest snapshot's differences
// GET ?provider_id=&list=1         → recent snapshots (history)
//
// Routes: internal/edi/tpl/[provider_id]/inventory-advice.js

import { createClient } from "@supabase/supabase-js";
import { parse846 } from "../../../../../_lib/edi/builder.js";
import { parseEnvelope } from "../../../../../_lib/edi/parser.js";

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

// CSV → [{ sku, qty_on_hand }]. Accepts "sku,qty" rows; skips a header row whose
// 2nd column isn't numeric. Tolerates extra columns (sku is col 1, qty is col 2).
function parseCsv(text) {
  const lines = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.length < 2) continue;
    const sku = cells[0];
    const qty = Number(cells[1]);
    if (!sku || !Number.isFinite(qty)) continue; // header / junk
    lines.push({ sku, qty_on_hand: qty });
  }
  return lines;
}

// Sum inventory_layers.remaining_qty for a set of item ids, returning two maps:
// total per item, and per (item @ a target location). Chunked .in() for safety.
async function fetchOnHand(admin, entityId, itemIds, locationId) {
  const total = new Map();
  const atLoc = new Map();
  for (let i = 0; i < itemIds.length; i += 400) {
    const chunk = itemIds.slice(i, i + 400);
    const { data } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty, location_id")
      .eq("entity_id", entityId)
      .in("item_id", chunk)
      .gt("remaining_qty", 0);
    for (const l of data || []) {
      const q = Number(l.remaining_qty) || 0;
      total.set(l.item_id, (total.get(l.item_id) || 0) + q);
      if (locationId && l.location_id === locationId) atLoc.set(l.item_id, (atLoc.get(l.item_id) || 0) + q);
    }
  }
  return { total, atLoc };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const providerId = getProviderId(req);
  if (!providerId || !UUID_RE.test(String(providerId))) return res.status(400).json({ error: "Invalid provider id" });

  const { data: provider } = await admin
    .from("tpl_providers")
    .select("id, name, entity_id, location_id")
    .eq("id", providerId)
    .maybeSingle();
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
        .eq("tpl_provider_id", provider.id)
        .order("created_at", { ascending: false })
        .limit(60);
      return res.status(200).json({ provider: { id: provider.id, name: provider.name }, snapshots: snaps || [] });
    }
    let snapshotId = qsSnap;
    if (!snapshotId) {
      const { data: latest } = await admin
        .from("tpl_inventory_snapshots")
        .select("id")
        .eq("tpl_provider_id", provider.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
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

  // ── POST: ingest a snapshot + compute differences ──────────────────────────
  let lines = null;     // [{ sku, qty_on_hand }]
  let source = "manual";
  let raw = null;
  let snapshotDate = new Date().toISOString().slice(0, 10);

  const bodyStr = typeof req.body === "string" ? req.body : null;
  let body = req.body;
  if (bodyStr) { try { body = JSON.parse(bodyStr); } catch { body = null; } }

  if (bodyStr && /\bISA\b|~\s*GS\b|\bLIN\b/.test(bodyStr) && !body) {
    // Looks like raw X12 846.
    try {
      const env = parseEnvelope(bodyStr);
      const txn = env.groups?.[0]?.transactions?.[0];
      const parsed = parse846((txn?.segments || []).map((s) => s));
      lines = (parsed.lines || []).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty_on_hand: Number(l.qty_on_hand) || 0 }));
      source = "edi846"; raw = bodyStr;
    } catch (e) {
      return res.status(400).json({ error: `Could not parse 846 envelope: ${e?.message || e}` });
    }
  } else if (body && typeof body === "object") {
    if (typeof body.raw === "string") {
      try {
        const env = parseEnvelope(body.raw);
        const txn = env.groups?.[0]?.transactions?.[0];
        const parsed = parse846((txn?.segments || []).map((s) => s));
        lines = (parsed.lines || []).filter((l) => l.sku).map((l) => ({ sku: l.sku, qty_on_hand: Number(l.qty_on_hand) || 0 }));
        source = "edi846"; raw = body.raw;
      } catch (e) {
        return res.status(400).json({ error: `Could not parse 846 envelope: ${e?.message || e}` });
      }
    } else if (typeof body.csv === "string") {
      lines = parseCsv(body.csv); source = "csv"; raw = body.csv;
    } else if (Array.isArray(body.lines)) {
      lines = body.lines.map((l) => ({ sku: String(l.sku ?? l.sku_code ?? "").trim(), qty_on_hand: Number(l.qty ?? l.qty_on_hand ?? 0) || 0 })).filter((l) => l.sku);
      source = body.source === "edi846" ? "edi846" : "json"; raw = JSON.stringify(body.lines);
    }
    if (body.snapshot_date && /^\d{4}-\d{2}-\d{2}$/.test(body.snapshot_date)) snapshotDate = body.snapshot_date;
  } else if (bodyStr) {
    // Plain CSV text body.
    lines = parseCsv(bodyStr); source = "csv"; raw = bodyStr;
  }

  if (!lines || lines.length === 0) {
    return res.status(400).json({ error: "No inventory lines found. Provide an X12 846, a CSV ('sku,qty' rows), or { lines:[{sku,qty}] }." });
  }

  // Collapse duplicate SKUs (sum), normalize.
  const byShu = new Map();
  for (const l of lines) {
    const sku = String(l.sku).trim();
    if (!sku) continue;
    byShu.set(sku, (byShu.get(sku) || 0) + (Number(l.qty_on_hand) || 0));
  }
  const skuList = [...byShu.keys()];

  // Resolve sku_code → item id (chunked).
  const itemBySku = new Map();
  for (let i = 0; i < skuList.length; i += 400) {
    const chunk = skuList.slice(i, i + 400);
    const { data } = await admin.from("ip_item_master").select("id, sku_code").eq("entity_id", provider.entity_id).in("sku_code", chunk);
    for (const r of data || []) itemBySku.set(r.sku_code, r.id);
  }
  const matched = skuList.filter((s) => itemBySku.has(s)).length;

  // Insert snapshot + lines.
  const { data: snap, error: snapErr } = await admin.from("tpl_inventory_snapshots").insert({
    entity_id: provider.entity_id,
    tpl_provider_id: provider.id,
    snapshot_date: snapshotDate,
    source,
    line_count: skuList.length,
    matched_count: matched,
    raw_content: raw && raw.length < 500000 ? raw : null,
  }).select("id").single();
  if (snapErr) return res.status(500).json({ error: `Snapshot store failed: ${snapErr.message}` });

  const lineRows = skuList.map((sku) => ({ snapshot_id: snap.id, sku_code: sku, item_id: itemBySku.get(sku) || null, qty_on_hand: byShu.get(sku) }));
  for (let i = 0; i < lineRows.length; i += 500) {
    await admin.from("tpl_inventory_snapshot_lines").insert(lineRows.slice(i, i + 500));
  }

  // Audit row for X12 ingests.
  if (source === "edi846" && raw) {
    await admin.from("edi_messages").insert({
      vendor_id: null, direction: "inbound", transaction_set: "846", status: "processed",
      raw_content: raw, parsed_content: { line_count: skuList.length, matched }, tpl_provider_id: provider.id,
    });
  }

  // ── Reconcile vs Tangerine on-hand ─────────────────────────────────────────
  const matchedItemIds = [...itemBySku.values()];
  const { total, atLoc } = await fetchOnHand(admin, provider.entity_id, matchedItemIds, provider.location_id);

  const diffRows = [];
  for (const sku of skuList) {
    const itemId = itemBySku.get(sku) || null;
    const qty3pl = byShu.get(sku);
    const qtyLoc = itemId ? (atLoc.get(itemId) || 0) : 0;
    const qtyTot = itemId ? (total.get(itemId) || 0) : 0;
    diffRows.push({
      entity_id: provider.entity_id, snapshot_id: snap.id, tpl_provider_id: provider.id, snapshot_date: snapshotDate,
      sku_code: sku, item_id: itemId, qty_3pl: qty3pl, qty_tangerine_location: qtyLoc, qty_tangerine_total: qtyTot,
      direction: "both",
    });
  }

  // Items Tangerine holds AT the 3PL location that the 3PL did NOT report (3PL=0).
  if (provider.location_id) {
    const reportedItems = new Set(matchedItemIds);
    const { data: locRows } = await admin
      .from("inventory_layers")
      .select("item_id, remaining_qty")
      .eq("entity_id", provider.entity_id)
      .eq("location_id", provider.location_id)
      .gt("remaining_qty", 0);
    const locSum = new Map();
    for (const l of locRows || []) locSum.set(l.item_id, (locSum.get(l.item_id) || 0) + (Number(l.remaining_qty) || 0));
    const missingIds = [...locSum.keys()].filter((id) => !reportedItems.has(id));
    if (missingIds.length) {
      const skuByItem = new Map();
      for (let i = 0; i < missingIds.length; i += 400) {
        const { data } = await admin.from("ip_item_master").select("id, sku_code").in("id", missingIds.slice(i, i + 400));
        for (const r of data || []) skuByItem.set(r.id, r.sku_code);
      }
      const totMissing = await fetchOnHand(admin, provider.entity_id, missingIds, provider.location_id);
      for (const id of missingIds) {
        diffRows.push({
          entity_id: provider.entity_id, snapshot_id: snap.id, tpl_provider_id: provider.id, snapshot_date: snapshotDate,
          sku_code: skuByItem.get(id) || "(unknown)", item_id: id, qty_3pl: 0,
          qty_tangerine_location: locSum.get(id) || 0, qty_tangerine_total: totMissing.total.get(id) || 0,
          direction: "only_tangerine",
        });
      }
    }
  }

  for (let i = 0; i < diffRows.length; i += 500) {
    await admin.from("tpl_inventory_differences").insert(diffRows.slice(i, i + 500));
  }

  const mismatchLoc = diffRows.filter((d) => Number(d.qty_3pl) !== Number(d.qty_tangerine_location)).length;
  const mismatchTot = diffRows.filter((d) => Number(d.qty_3pl) !== Number(d.qty_tangerine_total)).length;

  return res.status(201).json({
    ok: true,
    snapshot_id: snap.id,
    snapshot_date: snapshotDate,
    source,
    lines: skuList.length,
    matched_skus: matched,
    unmatched_skus: skuList.length - matched,
    differences_recorded: diffRows.length,
    mismatch_vs_location: mismatchLoc,
    mismatch_vs_total: mismatchTot,
    has_location: !!provider.location_id,
    message: `Snapshot ingested for ${provider.name} (${skuList.length} SKUs, ${matched} matched). ${mismatchTot} differ vs Tangerine total on-hand.`,
  });
}
