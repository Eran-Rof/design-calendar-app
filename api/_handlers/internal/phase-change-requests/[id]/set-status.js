// api/internal/phase-change-requests/:id/set-status
//
// POST — transition a change request to any of the three states
//        (pending / approved / rejected). Fires a po_message so the
//        vendor sees the change. Unlike approve/reject, this allows
//        backing out a prior decision or flipping between approved
//        and rejected without deleting history (the po_message thread
//        preserves the trail).
//
// body: { status: "pending"|"approved"|"rejected", reviewer_name: string, note?: string }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const VALID = new Set(["pending", "approved", "rejected"]);

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const si = parts.lastIndexOf("set-status");
  return si > 0 ? parts[si - 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing request id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const status = (body?.status || "").toLowerCase();
  if (!VALID.has(status)) return res.status(400).json({ error: `status must be one of: ${[...VALID].join(", ")}` });
  const reviewer = (body?.reviewer_name || "").trim() || "Ring of Fire";
  const note = (body?.note || "").trim();

  const { data: cr, error: fetchErr } = await admin
    .from("tanda_milestone_change_requests")
    .select("id, vendor_id, po_id, po_number, phase_name, field_name, new_value, old_value, status, po_line_key")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!cr) return res.status(404).json({ error: "Change request not found" });
  if (cr.status === status) return res.status(409).json({ error: `Already ${status}` });

  // Transitioning back to pending clears reviewer metadata so the vendor's
  // grid picks it up as a fresh pending item. For approved/rejected, stamp
  // the new review metadata.
  const patch = status === "pending"
    ? {
        status,
        reviewed_at: null,
        reviewed_by_internal_id: null,
        review_note: null,
        updated_at: new Date().toISOString(),
      }
    : {
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by_internal_id: reviewer,
        review_note: note || null,
        updated_at: new Date().toISOString(),
      };

  const { data: updated, error: updErr } = await admin
    .from("tanda_milestone_change_requests")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Audit via po_message so the thread captures the full trail. Format
  // matches approve/reject messages so they read as a coherent timeline.
  try {
    const verb = status === "pending" ? "↺ Moved back to pending"
      : status === "approved" ? "✓ Approved"
      : "✗ Rejected";
    const scope = cr.po_line_key ? ` (line-level)` : "";
    await admin.from("po_messages").insert({
      po_id: cr.po_id,
      sender_type: "internal",
      sender_name: reviewer,
      body: `${verb}${scope} ${cr.phase_name} · ${cr.field_name} → ${cr.new_value ?? "(cleared)"} (was ${cr.status})${note ? `\n\n${note}` : ""}`,
      read_by_vendor: false,
      read_by_internal: true,
    });
  } catch { /* non-blocking */ }

  return res.status(200).json(updated);
}
