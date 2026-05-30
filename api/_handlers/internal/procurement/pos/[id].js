// api/internal/procurement/pos/[id]
//
// Tangerine P13-3 — PATCH a single procurement PO (status transitions +
// header edits while draft). Path param arrives on req.query.id per the
// dispatcher pattern.
//
// Transitions enforced server-side:
//   draft → pending_approval | cancelled
//   pending_approval → approved | cancelled
//   approved → open | cancelled
//   open → received | cancelled
//   received / closed / cancelled → terminal (no transitions out)
//
// Cancellations require a reason (T11 D3 audit).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TRANSITIONS = {
  draft:            new Set(["pending_approval", "cancelled"]),
  pending_approval: new Set(["approved", "cancelled", "draft"]),
  approved:         new Set(["open", "cancelled"]),
  open:             new Set(["received", "cancelled"]),
  received:         new Set([]),
  closed:           new Set([]),
  cancelled:        new Set([]),
};

const EDITABLE_STATUSES = new Set(["draft"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: po, error: fetchErr } = await admin
    .from("tanda_pos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!po) return res.status(404).json({ error: "PO not found" });

  if (req.method === "GET") {
    const { data: lines } = await admin
      .from("po_line_items")
      .select("*")
      .eq("po_id", id)
      .order("line_index", { ascending: true });
    return res.status(200).json({ ...po, lines: lines || [] });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePoPatch(body || {}, po.procurement_status || "draft");
    if (v.error) return res.status(400).json({ error: v.error });

    const update = v.data.header;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }
    update.updated_at = new Date().toISOString();

    const { data: updated, error: upErr } = await admin
      .from("tanda_pos")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePoPatch(body, currentStatus) {
  const header = {};

  // Status transition.
  if ("procurement_status" in body) {
    const next = body.procurement_status;
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || new Set();
    if (!allowed.has(next)) {
      return {
        error: `Cannot transition from '${currentStatus}' to '${next}'. Allowed: ${[...allowed].join(", ") || "(none — terminal)"}`,
      };
    }
    if (next === "cancelled") {
      const reason = (body.cancel_reason || "").trim();
      if (!reason) return { error: "cancel_reason is required when cancelling a PO" };
      header.cancel_reason = reason;
      header.cancelled_at = new Date().toISOString();
    }
    header.procurement_status = next;
  }

  // Header edits — draft-only.
  const editsRequested =
    "expected_landed_cost_cents" in body ||
    "date_order" in body ||
    "date_expected" in body ||
    "buyer_po" in body ||
    "buyer_name" in body;

  if (editsRequested && !EDITABLE_STATUSES.has(currentStatus)) {
    return { error: `Header edits only allowed while PO is in 'draft'; current='${currentStatus}'` };
  }

  if ("expected_landed_cost_cents" in body) {
    const elc = parseCents(body.expected_landed_cost_cents);
    if (elc.error) return { error: `expected_landed_cost_cents — ${elc.error}` };
    if (elc.value < 0n) return { error: "expected_landed_cost_cents must be >= 0" };
    header.expected_landed_cost_cents = elc.value.toString();
  }
  if ("date_order" in body) {
    if (body.date_order && !/^\d{4}-\d{2}-\d{2}$/.test(body.date_order)) {
      return { error: "date_order must be YYYY-MM-DD" };
    }
    header.date_order = body.date_order || null;
  }
  if ("date_expected" in body) {
    if (body.date_expected && !/^\d{4}-\d{2}-\d{2}$/.test(body.date_expected)) {
      return { error: "date_expected must be YYYY-MM-DD" };
    }
    header.date_expected = body.date_expected || null;
  }
  if ("buyer_po" in body) {
    header.buyer_po = body.buyer_po ? String(body.buyer_po).trim() : null;
  }
  if ("buyer_name" in body) {
    header.buyer_name = body.buyer_name ? String(body.buyer_name).trim() : null;
  }

  return { data: { header } };
}

function parseCents(raw) {
  if (raw === null || raw === undefined || raw === "") return { error: "missing" };
  if (typeof raw === "bigint") return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: "not finite" };
    if (!Number.isInteger(raw)) return { error: "must be an integer (cents)" };
    return { value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { error: `invalid integer cents: ${raw}` };
    try { return { value: BigInt(s) }; } catch { return { error: "could not parse" }; }
  }
  return { error: "must be number or string of integer cents" };
}
