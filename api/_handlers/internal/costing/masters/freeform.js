// api/internal/costing/masters/freeform
//
// Manage the operator-only "freeform" color + vendor master lists.
//
// Storage: app_data blobs `costing_extra_colors` and `costing_extra_vendors`
// — JSON string arrays. Each entry is the freeform value the operator typed
// in a costing line. These lists do NOT replace the canonical sources
// (ip_item_master.color for colors, ip_vendor_master.vendor_name for
// vendors) — they sit alongside them in the autocomplete sources.
//
// Auto-prune: every GET cross-references the freeform entries against the
// canonical source and DROPS any name that now exists there (case-
// insensitive match). The pruned list is written back to app_data so the
// next read is consistent and the autocomplete won't show duplicates. Per
// operator ask: "once a vendor or color become part of the master data
// auto delete from master".
//
// Methods
//   GET                        → { colors: string[], vendors: string[] } (pruned)
//   POST  { kind, name }       → adds; returns the new list for kind
//   PUT   { kind, oldName, newName } → renames in-place; returns the new list
//   DELETE ?kind=&name=        → removes; returns the new list
//
//   kind ∈ { "colors", "vendors" }
//
// Auth: authenticateInternalCaller. CORS-friendly headers as siblings.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const KEY = { colors: "costing_extra_colors", vendors: "costing_extra_vendors" };

function normalize(name) {
  return typeof name === "string" ? name.trim() : "";
}
function lc(name) { return normalize(name).toLowerCase(); }

async function loadBlob(admin, kind) {
  const { data } = await admin.from("app_data")
    .select("value").eq("key", KEY[kind]).maybeSingle();
  if (!data?.value) return [];
  const raw = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
  return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];
}

async function saveBlob(admin, kind, list) {
  const value = JSON.stringify(Array.from(new Set(list)).sort());
  await admin.from("app_data")
    .upsert({ key: KEY[kind], value }, { onConflict: "key" });
}

async function canonicalSet(admin, kind) {
  const out = new Set();
  if (kind === "colors") {
    const { data } = await admin.from("ip_item_master")
      .select("color").not("color", "is", null).range(0, 99999);
    for (const r of data || []) {
      if (typeof r.color === "string" && r.color.trim()) out.add(r.color.trim().toLowerCase());
    }
  } else if (kind === "vendors") {
    const { data: vm } = await admin.from("ip_vendor_master")
      .select("vendor_name").not("vendor_name", "is", null).range(0, 9999);
    for (const r of vm || []) {
      if (typeof r.vendor_name === "string" && r.vendor_name.trim()) out.add(r.vendor_name.trim().toLowerCase());
    }
    // Vendors that came in via Xoro sync occasionally land on `vendors`
    // directly (instead of ip_vendor_master). Treat those as canonical
    // too so freeform additions get pruned once the sync catches up.
    const { data: vs } = await admin.from("vendors")
      .select("name, legal_name").range(0, 9999);
    for (const r of vs || []) {
      if (typeof r.name === "string" && r.name.trim()) out.add(r.name.trim().toLowerCase());
      if (typeof r.legal_name === "string" && r.legal_name.trim()) out.add(r.legal_name.trim().toLowerCase());
    }
  }
  return out;
}

async function getPrunedList(admin, kind) {
  const raw = await loadBlob(admin, kind);
  if (raw.length === 0) return [];
  const canon = await canonicalSet(admin, kind);
  const pruned = raw.filter((name) => !canon.has(name.toLowerCase()));
  // Write back if anything got dropped so the next request is consistent.
  if (pruned.length !== raw.length) {
    try { await saveBlob(admin, kind, pruned); } catch { /* non-fatal */ }
  }
  return pruned;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const [colors, vendors] = await Promise.all([
      getPrunedList(admin, "colors"),
      getPrunedList(admin, "vendors"),
    ]);
    return res.status(200).json({ colors, vendors });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  if (req.method === "POST") {
    const kind = body?.kind;
    const name = normalize(body?.name);
    if (kind !== "colors" && kind !== "vendors") return res.status(400).json({ error: "kind must be 'colors' or 'vendors'" });
    if (!name) return res.status(400).json({ error: "name is required" });
    const current = await loadBlob(admin, kind);
    if (current.some((c) => c.toLowerCase() === name.toLowerCase())) {
      return res.status(200).json({ kind, list: await getPrunedList(admin, kind) });
    }
    const next = [...current, name];
    await saveBlob(admin, kind, next);
    return res.status(200).json({ kind, list: await getPrunedList(admin, kind) });
  }

  if (req.method === "PUT") {
    const kind = body?.kind;
    const oldName = normalize(body?.oldName);
    const newName = normalize(body?.newName);
    if (kind !== "colors" && kind !== "vendors") return res.status(400).json({ error: "kind must be 'colors' or 'vendors'" });
    if (!oldName || !newName) return res.status(400).json({ error: "oldName and newName are required" });
    const current = await loadBlob(admin, kind);
    const next = current.map((c) => (c.toLowerCase() === oldName.toLowerCase() ? newName : c));
    await saveBlob(admin, kind, next);
    return res.status(200).json({ kind, list: await getPrunedList(admin, kind) });
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const kind = url.searchParams.get("kind");
    const name = normalize(url.searchParams.get("name"));
    if (kind !== "colors" && kind !== "vendors") return res.status(400).json({ error: "kind must be 'colors' or 'vendors'" });
    if (!name) return res.status(400).json({ error: "name is required" });
    const current = await loadBlob(admin, kind);
    const next = current.filter((c) => c.toLowerCase() !== name.toLowerCase());
    await saveBlob(admin, kind, next);
    return res.status(200).json({ kind, list: next });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
