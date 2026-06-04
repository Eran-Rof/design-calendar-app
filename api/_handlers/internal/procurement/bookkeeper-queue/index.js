// api/internal/procurement/bookkeeper-queue
//
// P13 — Bookkeeper Approval Queue (list endpoint).
//
// GET ?limit=N (default 200, max 500)
//   → lists the AP "rollup" invoices auto-created by P13 receiving
//     (freight / duty / broker), held for bookkeeper review.
//     Filters: entity_id = default (ROF), is_receipt_rollup = true,
//              status = 'pending_bookkeeper_approval'. Newest first.
//     Each row is enriched with `vendor: { id, name }`.
//
// Approve / Reject (approve → GL-post) live in the sibling [id].js handler,
// which is owned elsewhere — this file is GET-only.
//
// Service-role client + anon-read RLS, consistent with the other internal
// procurement / AP handlers.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

const SELECT_COLS =
  "id, entity_id, vendor_id, invoice_number, invoice_date, due_date, status, " +
  "gl_status, total_amount_cents, currency, source, description, " +
  "is_receipt_rollup, rollup_parent_receipt_id, created_at";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  let limit = parseInt(url.searchParams.get("limit") || "200", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 500);

  const { data, error } = await admin
    .from("invoices")
    .select(SELECT_COLS)
    .eq("entity_id", entityId)
    .eq("is_receipt_rollup", true)
    .eq("status", "pending_bookkeeper_approval")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];

  // Resolve vendor names with a single second query (no FK-embed in this
  // codebase's invoice handlers; safest to map by id).
  const vendorIds = [...new Set(rows.map((r) => r.vendor_id).filter(Boolean))];
  let vendorMap = {};
  if (vendorIds.length > 0) {
    const { data: vendors, error: vErr } = await admin
      .from("vendors")
      .select("id, name")
      .in("id", vendorIds);
    if (vErr) return res.status(500).json({ error: vErr.message });
    for (const v of vendors || []) vendorMap[v.id] = v;
  }

  const enriched = rows.map((r) => ({
    ...r,
    vendor: r.vendor_id ? vendorMap[r.vendor_id] || null : null,
  }));

  return res.status(200).json(enriched);
}
