// api/internal/phase-change-requests/:id/approve
//
// POST — approve a pending vendor change request. Flips status → approved,
//        records reviewer + optional note, and fires a po_message so the
//        vendor sees the approval in the PO message thread.
//
// body: { reviewer_name: string, note?: string }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const ai = parts.lastIndexOf("approve");
  return ai > 0 ? parts[ai - 1] : null;
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
  const reviewer = (body?.reviewer_name || "").trim() || "Ring of Fire";
  const note = (body?.note || "").trim() || null;

  const { data: cr, error: fetchErr } = await admin
    .from("tanda_milestone_change_requests")
    .select("id, vendor_id, po_id, po_number, phase_name, field_name, new_value, old_value, status, po_line_key")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!cr) return res.status(404).json({ error: "Change request not found" });
  if (cr.status !== "pending") return res.status(409).json({ error: `Already ${cr.status}` });

  const { data: updated, error: updErr } = await admin
    .from("tanda_milestone_change_requests")
    .update({
      status: "approved",
      reviewed_at: new Date().toISOString(),
      reviewed_by_internal_id: reviewer,
      review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Fire po_message so the vendor thread lights up.
  try {
    await admin.from("po_messages").insert({
      po_id: cr.po_id,
      sender_type: "internal",
      sender_name: reviewer,
      body: `✓ Approved ${cr.phase_name}${cr.po_line_key ? ` (line ${cr.po_line_key})` : ""} · ${cr.field_name} → ${cr.new_value ?? "(cleared)"}${note ? `\n\n${note}` : ""}`,
      read_by_vendor: false,
      read_by_internal: true,
    });
  } catch { /* non-blocking */ }

  return res.status(200).json(updated);
}
