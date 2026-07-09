// api/internal/ar-aging
//
// GET — return AR aging buckets per customer for the default entity.
//   Default mode: returns rows from view `v_ar_aging` (uses CURRENT_DATE).
//   ?as_of=YYYY-MM-DD: calls RPC ar_aging_as_of(p_entity_id, p_as_of_date).
//   ?customer_id=<uuid>: filter to a single customer (applied to both modes).
//   ?limit=N: default 500, max 2000.
//   Sorted by total_open_cents DESC.
//
// Both modes return the SAME row shape:
//   { entity_id, customer_id, customer_name, customer_code,
//     bucket_current_cents, bucket_30_cents, bucket_60_cents,
//     bucket_90_cents, bucket_120plus_cents, total_open_cents }
//
// Tangerine P4-6.

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, activeBrandId, collapseAgingByBucket } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function parseListQuery(params) {
  const out = { mode: "current", customer_id: null, limit: 500 };

  const asOf = (params.get("as_of") || "").trim();
  if (asOf) {
    if (!isISODate(asOf)) {
      return { error: "as_of must be YYYY-MM-DD" };
    }
    out.mode = "as_of";
    out.as_of = asOf;
  }

  const customerId = (params.get("customer_id") || "").trim();
  if (customerId) {
    if (!isUuid(customerId)) {
      return { error: "customer_id must be a UUID" };
    }
    out.customer_id = customerId;
  }

  const limitRaw = (params.get("limit") || "").trim();
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      return { error: "limit must be a positive integer" };
    }
    out.limit = Math.min(n, 2000);
  }

  return { data: out };
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
  const v = parseListQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    let rows;
    if (v.data.mode === "as_of") {
      // P15 C3b — brand filtered server-side via p_brand_id (null = all brands).
      const { data, error } = await admin.rpc("ar_aging_as_of", {
        p_entity_id: entityId,
        p_as_of_date: v.data.as_of,
        p_brand_id: activeBrandId(req),
      });
      if (error) return res.status(500).json({ error: error.message });
      rows = data || [];
      if (v.data.customer_id) {
        rows = rows.filter((r) => r.customer_id === v.data.customer_id);
      }
    } else {
      let q = admin
        .from("v_ar_aging")
        .select("*")
        .eq("entity_id", entityId);
      if (v.data.customer_id) q = q.eq("customer_id", v.data.customer_id);
      // P15 C3b — gated brand filter; then collapse the brand-split view rows
      // back to one row per (customer, bucket) (no-op shape change for "All").
      q = applyBrandScope(q, req);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      rows = collapseAgingByBucket(data || [], "customer_id");

      // The view carries only customer_id — resolve name/code so the panel
      // (and the Phase 2 bucket drill) can label rows. Chunked .in() lookups.
      const custIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
      const custById = new Map();
      for (let i = 0; i < custIds.length; i += 200) {
        const { data: custs, error: custErr } = await admin
          .from("customers")
          .select("id, name, code")
          .in("id", custIds.slice(i, i + 200));
        if (custErr) return res.status(500).json({ error: custErr.message });
        for (const c of custs || []) custById.set(c.id, c);
      }
      for (const r of rows) {
        const c = custById.get(r.customer_id);
        r.customer_name = c?.name || null;
        r.customer_code = c?.code || null;
      }
    }

    // Sort by open exposure DESC and apply the limit per CUSTOMER (view mode
    // returns one row per customer × bucket — slicing raw rows would silently
    // drop buckets and the panel cells would no longer tie to the drill).
    if (v.data.mode === "as_of") {
      rows.sort((a, b) => Number(b.total_outstanding_cents || 0) - Number(a.total_outstanding_cents || 0));
      rows = rows.slice(0, v.data.limit);
    } else {
      const totals = new Map();
      for (const r of rows) {
        totals.set(r.customer_id, (totals.get(r.customer_id) || 0) + Number(r.outstanding_cents || 0));
      }
      const keep = new Set(
        [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, v.data.limit).map(([id]) => id),
      );
      rows = rows.filter((r) => keep.has(r.customer_id));
      rows.sort((a, b) => (totals.get(b.customer_id) || 0) - (totals.get(a.customer_id) || 0));
    }

    return res.status(200).json({
      mode: v.data.mode,
      as_of: v.data.as_of || null,
      rows,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
