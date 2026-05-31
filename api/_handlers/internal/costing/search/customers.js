// api/internal/costing/search/customers
// GET ?q=<text>&entity_id=<uuid>  → up to 25 active customers
//
// Returns customers row + `display_name` resolved from ip_customer_master.name
// (Xoro-synced friendly name keyed by customer_code = customers.code).
// 100% coverage of EXCEL: codes today, so the picker always shows the
// friendly form ("Ross Procurement") instead of the raw "EXCEL:ROSSPROCUREMENT".
// Mirrors how ATS resolves customer names (src/ats/exportSalesFetch.ts).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const q = (url.searchParams.get("q") || "").trim();
  const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];

  let query = admin.from("customers")
    .select("id, entity_id, code, customer_type, default_currency, status, billing_address, payment_terms")
    .eq("status", "active")
    .is("deleted_at", null)
    .limit(25);
  if (entityId) query = query.eq("entity_id", entityId);
  if (q) {
    const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
    // ILIKE on code OR the jsonb path billing_address->>'name'/'company' so
    // operators can type either the customer code (RCB) or part of the
    // display name (Macy's). PostgREST's .or() takes a comma-separated
    // string of column filters; billing_address->>name is the jsonb arrow
    // operator producing text for ILIKE.
    query = query.or(
      `code.ilike.${like},billing_address->>name.ilike.${like},billing_address->>company.ilike.${like}`,
    );
  }
  query = query.order("code", { ascending: true });

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with ip_customer_master.name (the friendly name Xoro syncs)
  // keyed by customer_code = customers.code. Single bulk fetch.
  const rows = data || [];
  const codes = Array.from(new Set(rows.map((r) => r.code).filter((c) => typeof c === "string" && c.length > 0)));
  const nameByCode = new Map();
  if (codes.length > 0) {
    try {
      const { data: ipcm } = await admin.from("ip_customer_master")
        .select("customer_code, name")
        .in("customer_code", codes);
      for (const r of ipcm || []) {
        if (r.customer_code && r.name) nameByCode.set(r.customer_code, r.name);
      }
    } catch (e) {
      // Non-fatal — picker still works with the raw code as fallback.
      console.warn("[costing/search/customers] ip_customer_master enrichment failed:", e.message);
    }
  }
  const enriched = rows.map((r) => ({ ...r, display_name: nameByCode.get(r.code) || null }));
  return res.status(200).json({ rows: enriched });
}
