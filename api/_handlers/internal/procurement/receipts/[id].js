// api/internal/procurement/receipts/[id]
//
// Tangerine P13-3 — GET / PATCH a single tanda_po_receipts row + lines.
//
// PATCH supports:
//   - status transition (draft → pending_approval → approved → posted)
//   - notes edit (while draft)
//   - lines replace (while draft)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TRANSITIONS = {
  draft:            new Set(["pending_approval"]),
  pending_approval: new Set(["approved", "draft"]),
  approved:         new Set(["posted"]),
  posted:           new Set([]),
};

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

  const { data: receipt, error: fetchErr } = await admin
    .from("tanda_po_receipts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!receipt) return res.status(404).json({ error: "Receipt not found" });

  if (req.method === "GET") {
    const [{ data: lines }, { data: rollups }] = await Promise.all([
      admin.from("tanda_po_receipt_lines").select("*").eq("receipt_id", id),
      admin.from("tanda_po_receipt_rollups").select("*").eq("receipt_id", id).order("created_at"),
    ]);
    return res.status(200).json({
      ...receipt,
      lines: lines || [],
      rollups: rollups || [],
    });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateReceiptPatch(body || {}, receipt.status);
    if (v.error) return res.status(400).json({ error: v.error });

    const update = v.data.header;
    update.updated_at = new Date().toISOString();
    if (Object.keys(update).length === 1) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { data: updated, error: upErr } = await admin
      .from("tanda_po_receipts")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });

    // Optional lines replace.
    if (v.data.lines) {
      await admin.from("tanda_po_receipt_lines").delete().eq("receipt_id", id);
      if (v.data.lines.length > 0) {
        const rows = v.data.lines.map((ln) => ({
          receipt_id: id,
          po_line_item_id: ln.po_line_item_id,
          qty_received: ln.qty_received,
          qty_accepted: ln.qty_accepted,
          qty_rejected: ln.qty_rejected,
          unit_cost_cents: ln.unit_cost_cents,
          inventory_location_id: ln.inventory_location_id,
        }));
        const { error: lErr } = await admin.from("tanda_po_receipt_lines").insert(rows);
        if (lErr) return res.status(500).json({ error: `Failed to replace lines: ${lErr.message}` });
      }
    }

    return res.status(200).json(updated);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}

function isUuid(s) { return typeof s === "string" && UUID_RE.test(s); }

export function validateReceiptPatch(body, currentStatus) {
  const header = {};
  let lines = null;

  if ("status" in body) {
    const next = body.status;
    const allowed = ALLOWED_TRANSITIONS[currentStatus] || new Set();
    if (!allowed.has(next)) {
      return {
        error: `Cannot transition from '${currentStatus}' to '${next}'. Allowed: ${[...allowed].join(", ") || "(none — terminal)"}`,
      };
    }
    header.status = next;
  }

  const editsLocked = currentStatus !== "draft";

  if ("notes" in body) {
    if (editsLocked) return { error: `Cannot edit notes while status='${currentStatus}'` };
    header.notes = body.notes ? String(body.notes).trim() : null;
  }
  if ("receipt_date" in body) {
    if (editsLocked) return { error: `Cannot edit receipt_date while status='${currentStatus}'` };
    if (body.receipt_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.receipt_date)) {
      return { error: "receipt_date must be YYYY-MM-DD" };
    }
    header.receipt_date = body.receipt_date;
  }
  if ("received_by_employee_id" in body) {
    if (editsLocked) return { error: `Cannot edit received_by_employee_id while status='${currentStatus}'` };
    if (body.received_by_employee_id && !isUuid(body.received_by_employee_id)) {
      return { error: "received_by_employee_id must be a uuid" };
    }
    header.received_by_employee_id = body.received_by_employee_id || null;
  }

  if ("lines" in body) {
    if (editsLocked) return { error: `Cannot replace lines while status='${currentStatus}'` };
    if (!Array.isArray(body.lines)) {
      return { error: "lines must be an array" };
    }
    const normalized = [];
    for (let i = 0; i < body.lines.length; i++) {
      const ln = body.lines[i] || {};
      if (!isUuid(ln.po_line_item_id)) {
        return { error: `line ${i + 1}: po_line_item_id must be a uuid` };
      }
      const qr = parseInt(ln.qty_received, 10);
      if (!Number.isFinite(qr) || qr <= 0) {
        return { error: `line ${i + 1}: qty_received must be > 0` };
      }
      const qa = parseInt(ln.qty_accepted ?? qr, 10);
      if (!Number.isFinite(qa) || qa < 0) {
        return { error: `line ${i + 1}: qty_accepted must be >= 0` };
      }
      const qj = ln.qty_rejected === undefined || ln.qty_rejected === null ? 0 : parseInt(ln.qty_rejected, 10);
      if (!Number.isFinite(qj) || qj < 0) {
        return { error: `line ${i + 1}: qty_rejected must be >= 0` };
      }
      if (qa + qj > qr) {
        return { error: `line ${i + 1}: qty_accepted + qty_rejected cannot exceed qty_received` };
      }
      const uc = parseCents(ln.unit_cost_cents);
      if (uc.error) return { error: `line ${i + 1}: unit_cost_cents — ${uc.error}` };
      if (uc.value < 0n) return { error: `line ${i + 1}: unit_cost_cents must be >= 0` };
      normalized.push({
        po_line_item_id: ln.po_line_item_id,
        qty_received: qr,
        qty_accepted: qa,
        qty_rejected: qj,
        unit_cost_cents: uc.value.toString(),
        inventory_location_id: ln.inventory_location_id || null,
      });
    }
    lines = normalized;
  }

  return { data: { header, lines } };
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
