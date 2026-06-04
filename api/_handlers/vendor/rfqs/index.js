// api/vendor/rfqs
//
// GET — RFQs this vendor has been invited to, with invitation state
// and the vendor's quote (if any) inlined.
// Filters: ?status=draft|published|closed|awarded
// Rows include:
//   { rfq: {...}, invitation: {status, invited_at, viewed_at}, quote: {...} | null }

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const status = url.searchParams.get("status");

  const { data: invitations, error: invErr } = await admin
    .from("rfq_invitations")
    .select("*, rfq:rfqs(id, title, description, category, status, submission_deadline, delivery_required_by, estimated_quantity, estimated_budget, currency, awarded_to_vendor_id)")
    .eq("vendor_id", caller.vendor_id)
    .order("invited_at", { ascending: false });
  if (invErr) return res.status(500).json({ error: invErr.message });

  const rfqIds = (invitations || []).map((i) => i.rfq?.id).filter(Boolean);
  let myQuotes = [];
  if (rfqIds.length > 0) {
    const { data: qts } = await admin
      .from("rfq_quotes")
      .select("*")
      .eq("vendor_id", caller.vendor_id)
      .in("rfq_id", rfqIds);
    myQuotes = qts || [];
  }
  const quoteByRfq = new Map(myQuotes.map((q) => [q.rfq_id, q]));

  // Per-RFQ line summary (style / style name / total qty) for the list columns.
  const summaryByRfq = new Map();
  if (rfqIds.length > 0) {
    const { data: items } = await admin
      .from("rfq_line_items")
      .select("rfq_id, style_code, description, quantity")
      .in("rfq_id", rfqIds)
      .order("line_index", { ascending: true });
    for (const it of items || []) {
      let s = summaryByRfq.get(it.rfq_id);
      if (!s) { s = { styles: new Set(), names: new Set(), qty: 0, count: 0 }; summaryByRfq.set(it.rfq_id, s); }
      if (it.style_code) s.styles.add(it.style_code);
      const nm = styleNameOf(it.description);
      if (nm) s.names.add(nm);
      s.qty += Number(it.quantity) || 0;
      s.count += 1;
    }
  }
  const summaryOut = (rfqId) => {
    const s = summaryByRfq.get(rfqId);
    if (!s) return { style: null, style_name: null, quantity: null, line_count: 0 };
    return {
      style: joinCapped(s.styles),
      style_name: joinCapped(s.names),
      quantity: s.qty || null,
      line_count: s.count,
    };
  };

  let rows = (invitations || [])
    .filter((i) => i.rfq)
    .map((i) => ({
      invitation: {
        id: i.id, status: i.status, invited_at: i.invited_at,
        viewed_at: i.viewed_at, declined_at: i.declined_at,
      },
      rfq: i.rfq,
      quote: quoteByRfq.get(i.rfq.id) || null,
      line_summary: summaryOut(i.rfq.id),
    }));
  if (status) rows = rows.filter((r) => r.rfq.status === status);

  return res.status(200).json(rows);
}

// The style name is the tail of the costing-built description after " — ".
function styleNameOf(description) {
  const d = description || "";
  const i = d.lastIndexOf(" — ");
  return i >= 0 ? d.slice(i + 3).trim() : "";
}

// Collapse a Set of distinct values to one display string: a single value as-is,
// the first value + "+N more" when the RFQ spans several distinct styles.
function joinCapped(set) {
  const arr = Array.from(set);
  if (arr.length === 0) return null;
  if (arr.length === 1) return arr[0];
  return `${arr[0]} +${arr.length - 1} more`;
}
