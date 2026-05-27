// api/internal/inventory-cycle-counts/[id]
//
// GET    — fetch a single cycle count with embedded lines (and computed
//          variance — already a stored generated column).
// PATCH  — header-level: allow `status='cancelled'` transition only (nothing
//          else is mutable on the header; counts go through /lines).
// DELETE — only when status='in_progress' AND no line has counted_qty set.
//          Otherwise 409.
//
// Tangerine P3 Chunk 6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Validate PATCH body. Pure for testability.
// Only allowed mutation at the header level is status → 'cancelled'.
export function validatePatch(body) {
  const b = body || {};
  if (!Object.prototype.hasOwnProperty.call(b, "status")) {
    return { error: "Only `status` is mutable on the header (set to 'cancelled')" };
  }
  if (b.status !== "cancelled") {
    return { error: "Only status='cancelled' is allowed via PATCH (use /finalize to complete)" };
  }
  // Reject any other fields
  const allowed = new Set(["status"]);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) {
      return { error: `Field '${k}' is not mutable via PATCH` };
    }
  }
  return { data: { status: "cancelled" } };
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

  if (req.method === "GET") {
    const { data: header, error: hErr } = await admin
      .from("inventory_cycle_counts")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (hErr) return res.status(500).json({ error: hErr.message });
    if (!header) return res.status(404).json({ error: "Cycle count not found" });

    // Fetch lines with paginated read (could exceed 1000 for large counts).
    const PAGE = 1000;
    const lines = [];
    let from = 0;
    for (let page = 0; page < 200; page++) {
      const { data, error } = await admin
        .from("inventory_cycle_count_lines")
        .select("*")
        .eq("cycle_count_id", id)
        .order("created_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) break;
      lines.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    return res.status(200).json({ ...header, lines });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Only allow cancellation from in_progress.
    const { data: current, error: cErr } = await admin
      .from("inventory_cycle_counts")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: cErr.message });
    if (!current) return res.status(404).json({ error: "Cycle count not found" });
    if (current.status !== "in_progress") {
      return res.status(409).json({
        error: `Cannot cancel: status is '${current.status}'. Only in_progress counts can be cancelled.`,
      });
    }

    const { data, error } = await admin
      .from("inventory_cycle_counts")
      .update({ status: "cancelled" })
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Only when status='in_progress' AND no line has counted_qty set.
    const { data: header, error: hErr } = await admin
      .from("inventory_cycle_counts")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (hErr) return res.status(500).json({ error: hErr.message });
    if (!header) return res.status(404).json({ error: "Cycle count not found" });

    if (header.status !== "in_progress") {
      return res.status(409).json({
        error: `Cannot delete: status is '${header.status}'. Only in_progress counts can be deleted.`,
      });
    }

    const { count, error: cErr } = await admin
      .from("inventory_cycle_count_lines")
      .select("id", { count: "exact", head: true })
      .eq("cycle_count_id", id)
      .not("counted_qty", "is", null);
    if (cErr) return res.status(500).json({ error: cErr.message });
    if ((count ?? 0) > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${count} line(s) have counted_qty entered. Cancel instead.`,
      });
    }

    const { error: dErr } = await admin
      .from("inventory_cycle_counts")
      .delete()
      .eq("id", id);
    if (dErr) return res.status(500).json({ error: dErr.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
