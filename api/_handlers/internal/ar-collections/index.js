// api/internal/ar-collections
//
// GET — the AR Collections worklist.
//   ?group=customer (default) → v_ar_collections_customer_rollup, one row per
//        account (the view a collector actually works from — ~dozens of rows).
//   ?group=invoice&customer=<uuid> → v_ar_collections_worklist, the open
//        invoices behind an account (drawer). Chunked fetch-all so a big account
//        (e.g. thousands of open Shopify/Macy's invoices) is NOT silently
//        truncated at PostgREST's 1000-row cap.
//
//   Filters (both groups): exclude_factored=1, bucket, status, owner (uuid),
//     has_promise=open|broken, q (name/code/invoice# search).
//
// Read-only. Never posts GL, never mutates invoices.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS = ["current", "1-30", "31-60", "61-90", "91-120", "120+"];
const STATUSES = ["current", "watch", "overdue", "promised", "disputed", "escalated", "in_collections"];
const PAGE = 1000;
const HARD_CAP = 8000; // safety ceiling for invoice-mode fetch-all

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (error || !data) return null;
  return data.id;
}

function applyCommonFilters(q, p) {
  if (p.exclude_factored) q = q.eq("is_factored", false);
  if (p.status) q = q.eq("collection_status", p.status);
  if (p.owner) q = q.eq("assigned_owner_user_id", p.owner);
  if (p.customer) q = q.eq("customer_id", p.customer);
  return q;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const sp = url.searchParams;
  const group = (sp.get("group") || "customer").trim();

  const p = {
    exclude_factored: sp.get("exclude_factored") === "1" || sp.get("exclude_factored") === "true",
    bucket: (sp.get("bucket") || "").trim() || null,
    status: (sp.get("status") || "").trim() || null,
    owner: (sp.get("owner") || "").trim() || null,
    customer: (sp.get("customer") || "").trim() || null,
    has_promise: (sp.get("has_promise") || "").trim() || null,
    q: (sp.get("q") || "").trim() || null,
  };
  if (p.bucket && !BUCKETS.includes(p.bucket)) return res.status(400).json({ error: "invalid bucket" });
  if (p.status && !STATUSES.includes(p.status)) return res.status(400).json({ error: "invalid status" });
  if (p.owner && !UUID_RE.test(p.owner)) return res.status(400).json({ error: "owner must be a UUID" });
  if (p.customer && !UUID_RE.test(p.customer)) return res.status(400).json({ error: "customer must be a UUID" });

  try {
    if (group === "customer") {
      let q = admin.from("v_ar_collections_customer_rollup").select("*").eq("entity_id", entityId);
      q = applyCommonFilters(q, p);
      if (p.has_promise === "open") q = q.eq("has_open_promise", true);
      if (p.has_promise === "broken") q = q.eq("has_broken_promise", true);
      if (p.q) q = q.or(`customer_name.ilike.%${p.q}%,customer_code.ilike.%${p.q}%`);
      q = q.order("open_cents", { ascending: false }).limit(2000);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ group: "customer", rows: data || [], truncated: (data || []).length >= 2000 });
    }

    // group === "invoice": chunked fetch-all up to HARD_CAP.
    const rows = [];
    let from = 0;
    let truncated = false;
    for (;;) {
      let q = admin.from("v_ar_collections_worklist").select("*").eq("entity_id", entityId);
      q = applyCommonFilters(q, p);
      if (p.bucket) q = q.eq("age_bucket", p.bucket);
      if (p.has_promise === "open") q = q.eq("promise_open", true);
      if (p.has_promise === "broken") q = q.eq("promise_broken", true);
      if (p.q) q = q.or(`customer_name.ilike.%${p.q}%,customer_code.ilike.%${p.q}%,invoice_number.ilike.%${p.q}%`);
      q = q.order("days_past_due", { ascending: false }).range(from, from + PAGE - 1);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
      if (rows.length >= HARD_CAP) { truncated = true; break; }
    }
    return res.status(200).json({ group: "invoice", rows, truncated });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
