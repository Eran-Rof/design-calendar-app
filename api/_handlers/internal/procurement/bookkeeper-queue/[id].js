// api/internal/procurement/bookkeeper-queue/:id
//
// P13 / C1 — bookkeeper decision on a receipt-rollup AP invoice.
//   POST { action:'approve' }            → status='approved' (released to the
//          normal AP queue; gl_status stays 'unposted' so the existing, proven
//          AP post flow posts the JE — this handler does NOT post the GL itself).
//   POST { action:'reject', reason }     → status='rejected', gl_status='void',
//          reason appended to description.
//
// Only acts on is_receipt_rollup invoices currently pending_bookkeeper_approval.
// (One-click approve-AND-post is a documented fast-follow; kept separate here so
// this chunk introduces no new GL-posting code.)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const action = body?.action;
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be 'approve' or 'reject'" });

  const { data: inv, error } = await admin.from("invoices")
    .select("id, status, is_receipt_rollup, description, invoice_number").eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (!inv.is_receipt_rollup || inv.status !== "pending_bookkeeper_approval") {
    return res.status(409).json({ error: "Invoice is not a rollup invoice pending bookkeeper approval." });
  }

  if (action === "approve") {
    const { error: uErr } = await admin.from("invoices").update({ status: "approved" }).eq("id", id);
    if (uErr) return res.status(500).json({ error: uErr.message });
    return res.status(200).json({ id, status: "approved", message: `Invoice ${inv.invoice_number} approved — released to AP for posting.` });
  }

  // reject
  const reason = (body?.reason || "").toString().trim();
  if (!reason) return res.status(400).json({ error: "A reason is required to reject." });
  const newDesc = `${inv.description || ""}\n[REJECTED] ${reason}`.trim();
  const { error: uErr } = await admin.from("invoices").update({ status: "rejected", gl_status: "void", description: newDesc }).eq("id", id);
  if (uErr) return res.status(500).json({ error: uErr.message });
  return res.status(200).json({ id, status: "rejected", message: `Invoice ${inv.invoice_number} rejected.` });
}
