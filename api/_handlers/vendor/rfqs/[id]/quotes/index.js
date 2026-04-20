// api/vendor/rfqs/:id/quotes
//
// POST — create or update the vendor's draft quote for this RFQ.
//   body: {
//     total_price, lead_time_days, valid_until, notes,
//     lines: [{ rfq_line_item_id, unit_price, quantity, notes? }]
//   }
// Once the quote is submitted, this endpoint refuses further edits —
// use /api/vendor/rfqs/:id/quotes/submit to lock, or delete + recreate
// via a new draft (not currently supported).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
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

  const { data: invitation } = await admin
    .from("rfq_invitations").select("id, status").eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!invitation) return res.status(403).json({ error: "Not invited to this RFQ" });

  const { data: rfq } = await admin.from("rfqs").select("id, status, submission_deadline").eq("id", rfqId).maybeSingle();
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  if (rfq.status === "closed" || rfq.status === "awarded") return res.status(409).json({ error: `RFQ is ${rfq.status} — submissions are closed` });
  if (rfq.submission_deadline && new Date(rfq.submission_deadline) < new Date()) return res.status(409).json({ error: "Submission deadline has passed" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { total_price, lead_time_days, valid_until, notes, lines = [] } = body || {};

  const { data: existing } = await admin.from("rfq_quotes").select("*").eq("rfq_id", rfqId).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (existing && existing.status !== "draft") return res.status(409).json({ error: `Quote is already ${existing.status}; cannot edit` });

  const payload = {
    rfq_id: rfqId,
    vendor_id: caller.vendor_id,
    status: "draft",
    total_price: total_price != null ? Number(total_price) : null,
    lead_time_days: lead_time_days != null ? parseInt(lead_time_days, 10) : null,
    valid_until: valid_until || null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  };

  let quote;
  if (existing) {
    const { data, error } = await admin.from("rfq_quotes").update(payload).eq("id", existing.id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    quote = data;
  } else {
    const { data, error } = await admin.from("rfq_quotes").insert(payload).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    quote = data;
  }

  // Replace lines idempotently
  await admin.from("rfq_quote_lines").delete().eq("quote_id", quote.id);
  if (Array.isArray(lines) && lines.length > 0) {
    const lineRows = lines.map((l) => ({
      quote_id: quote.id,
      rfq_line_item_id: l.rfq_line_item_id,
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      quantity: l.quantity != null ? parseInt(l.quantity, 10) : null,
      notes: l.notes || null,
    })).filter((l) => l.rfq_line_item_id);
    if (lineRows.length > 0) {
      const { error } = await admin.from("rfq_quote_lines").insert(lineRows);
      if (error) return res.status(200).json({ ...quote, lines_error: error.message });
    }
  }

  return res.status(201).json(quote);
}
