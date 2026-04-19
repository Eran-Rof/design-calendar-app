// api/internal/compliance/[id]/review.js
//
// PUT /api/internal/compliance/:id/review
//   body: { status: 'approved' | 'rejected', notes?, reviewer_name? }
// Updates the compliance_documents row (status, reviewed_at, reviewed_by,
// rejection_reason when rejected) and fires a notification to the vendor.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // id is the segment before /review — Vercel passes it via req.query.id when
  // the filename is [id], but we double-parse the URL as a fallback.
  const id = (req.query && req.query.id) || (() => {
    const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
    // .../internal/compliance/<id>/review
    const reviewIdx = parts.lastIndexOf("review");
    return reviewIdx > 0 ? parts[reviewIdx - 1] : null;
  })();
  if (!id) return res.status(400).json({ error: "Missing document id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { status, notes, reviewer_name } = body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
  if (status === "rejected" && !(notes && String(notes).trim())) return res.status(400).json({ error: "notes required when rejecting" });

  const { data: doc, error: fetchErr } = await admin
    .from("compliance_documents")
    .select("id, vendor_id, document_type_id, document_type:compliance_document_types(name)")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  const { error: updErr } = await admin
    .from("compliance_documents")
    .update({
      status,
      rejection_reason: status === "rejected" ? String(notes).trim() : null,
      reviewed_by: reviewer_name || "Internal",
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  // Fire notification to the vendor (fire-and-forget)
  const typeName = doc.document_type?.name || "Document";
  const title = status === "approved"
    ? `Document approved: ${typeName}`
    : `Action needed: ${typeName} was not accepted`;
  const bodyText = status === "approved"
    ? `Your ${typeName} has been approved. No further action needed.`
    : `Your ${typeName} was not approved. Reason: ${String(notes).trim()}. Please re-upload a corrected document in the vendor portal.`;
  try {
    const origin = `https://${req.headers.host}`;
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: status === "approved" ? "compliance_doc_approved" : "compliance_doc_rejected",
        title,
        body: bodyText,
        link: "/vendor/compliance",
        recipient: { vendor_id: doc.vendor_id },
      }),
    }).catch(() => {});
  } catch { /* never block the response */ }

  return res.status(200).json({ ok: true, id, status });
}
