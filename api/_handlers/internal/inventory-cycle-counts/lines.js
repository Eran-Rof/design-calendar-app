// api/internal/inventory-cycle-counts/:id/lines/:line_id
//
// PATCH — update a single line's counted_qty (and optional notes).
//         Body: { counted_qty: number, notes?: string }
//
//         Constraints:
//           - parent cycle_count must be status='in_progress'
//           - counted_qty must be a finite non-negative number
//           - parent line must match :id and :line_id
//
// The URL pattern `/api/internal/inventory-cycle-counts/:id/lines/:line_id`
// is dispatched here. Both path params are read from req.query.
//
// Tangerine P3 Chunk 6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Pure validator — exported for tests.
export function validateLinePatch(body) {
  const b = body || {};
  if (!Object.prototype.hasOwnProperty.call(b, "counted_qty")) {
    return { error: "counted_qty is required" };
  }
  if (b.counted_qty === null) {
    // Allow clearing a previously entered count
    const out = { counted_qty: null };
    if (b.notes != null) out.notes = String(b.notes).trim() || null;
    return { data: out };
  }
  const n = Number(b.counted_qty);
  if (!Number.isFinite(n)) {
    return { error: "counted_qty must be a finite number" };
  }
  if (n < 0) {
    return { error: "counted_qty must be non-negative" };
  }
  const out = { counted_qty: n };
  if (b.notes != null) out.notes = String(b.notes).trim() || null;
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const cycleCountId = req.query?.id;
  const lineId = req.query?.line_id;

  if (!cycleCountId || !UUID_RE.test(cycleCountId)) {
    return res.status(400).json({ error: "Invalid cycle count id" });
  }
  if (!lineId || !UUID_RE.test(lineId)) {
    return res.status(400).json({ error: "Invalid line id" });
  }

  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateLinePatch(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Verify parent status + line belongs to count
  const { data: line, error: lErr } = await admin
    .from("inventory_cycle_count_lines")
    .select("id, cycle_count_id, counted_qty, system_qty")
    .eq("id", lineId)
    .maybeSingle();
  if (lErr) return res.status(500).json({ error: lErr.message });
  if (!line) return res.status(404).json({ error: "Line not found" });
  if (line.cycle_count_id !== cycleCountId) {
    return res.status(400).json({ error: "Line does not belong to this cycle count" });
  }

  const { data: cc, error: ccErr } = await admin
    .from("inventory_cycle_counts")
    .select("status")
    .eq("id", cycleCountId)
    .maybeSingle();
  if (ccErr) return res.status(500).json({ error: ccErr.message });
  if (!cc) return res.status(404).json({ error: "Cycle count not found" });
  if (cc.status !== "in_progress") {
    return res.status(409).json({
      error: `Cannot edit line: cycle count status is '${cc.status}'.`,
    });
  }

  const { data, error } = await admin
    .from("inventory_cycle_count_lines")
    .update(v.data)
    .eq("id", lineId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
