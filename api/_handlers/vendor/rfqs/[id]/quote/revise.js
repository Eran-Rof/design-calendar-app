// api/vendor/rfqs/:id/quote/revise
//
// POST — let a vendor RESUBMIT a revised quote after they've already
// submitted, while the RFQ is still open. We snapshot the CURRENT quote
// header + lines into rfq_quote_revisions, then REOPEN the quote
// (status='draft', revision+1) so the vendor can edit and re-submit via the
// existing /quotes + /quotes/submit flow — which becomes the new revision.
//
// Allowed ONLY when:
//   • quote.status IN ('submitted','under_review')
//   • rfq.status NOT IN ('closed','awarded')
//   • the submission deadline has not passed
// Otherwise 409.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("rfqs");
  return idx >= 0 ? parts[idx + 1] : null;
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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const rfqId = getId(req);
  if (!rfqId) return res.status(400).json({ error: "Missing rfq id" });

  const { data: rfq } = await admin.from("rfqs").select("id, status, submission_deadline").eq("id", rfqId).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (rfq.status === "closed" || rfq.status === "awarded") return res.status(409).json({ error: `RFQ is ${rfq.status} — revisions are closed` });
  if (rfq.submission_deadline && new Date(rfq.submission_deadline) < new Date()) return res.status(409).json({ error: "Submission deadline has passed" });

  const { data: quote } = await admin.from("rfq_quotes").select("*").eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!quote) return res.status(404).json({ error: "No quote found" });
  if (quote.status !== "submitted" && quote.status !== "under_review") {
    return res.status(409).json({ error: `Quote is ${quote.status} — only a submitted or under-review quote can be revised` });
  }

  // Snapshot the CURRENT quote header + its lines before reopening.
  const { data: lines } = await admin
    .from("rfq_quote_lines")
    .select("rfq_line_item_id, unit_price, quantity, notes")
    .eq("quote_id", quote.id);

  const snapshot = {
    total_price: quote.total_price,
    lead_time_days: quote.lead_time_days,
    valid_until: quote.valid_until,
    notes: quote.notes,
    lines: (lines || []).map((l) => ({
      rfq_line_item_id: l.rfq_line_item_id,
      unit_price: l.unit_price,
      quantity: l.quantity,
      notes: l.notes,
    })),
  };

  const currentRevision = quote.revision != null ? quote.revision : 1;
  const { error: revErr } = await admin.from("rfq_quote_revisions").insert({
    quote_id: quote.id,
    rfq_id: rfqId,
    vendor_id: caller.vendor_id,
    revision: currentRevision,
    snapshot,
    submitted_at: quote.submitted_at || null,
  });
  if (revErr) return res.status(500).json({ error: `Could not snapshot revision: ${revErr.message}` });

  // Reopen the quote for editing — back to draft, revision bumped.
  const nowIso = new Date().toISOString();
  const { error: upErr } = await admin.from("rfq_quotes").update({
    status: "draft",
    revision: currentRevision + 1,
    updated_at: nowIso,
  }).eq("id", quote.id);
  if (upErr) return res.status(500).json({ error: upErr.message });

  // Flip the invitation back to 'viewed' so the internal view reflects the
  // quote is being revised (best-effort).
  await admin.from("rfq_invitations").update({ status: "viewed" }).eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id);

  return res.status(200).json({ ok: true, quote_id: quote.id, status: "draft", revision: currentRevision + 1 });
}
