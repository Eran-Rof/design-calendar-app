// api/internal/pricing/resolve
//
// M43 — resolve a suggested unit price for a (customer, style, qty) via the
// unified pricing engine. Used by internal SO/AR line auto-fill and ad-hoc
// price checks. Read-only; service-role. The operator can always override the
// suggested price on the line.
//
// GET ?customer_id=&style_id=&qty=&date=  →
//   { price_cents, base_price_cents, currency, min_qty, source_list_id,
//     source_list_code, applied_promotion_id } | { price_cents: null } (no price)

import { createClient } from "@supabase/supabase-js";
import { resolvePrice } from "../../../_lib/pricing/engine.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const styleId = (url.searchParams.get("style_id") || "").trim();
  const customerId = (url.searchParams.get("customer_id") || "").trim();
  const date = (url.searchParams.get("date") || "").trim();
  let qty = Number(url.searchParams.get("qty") || "1");
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  if (!UUID_RE.test(styleId)) return res.status(400).json({ error: "style_id (uuid) required" });

  try {
    const r = await resolvePrice(admin, {
      customerId: UUID_RE.test(customerId) ? customerId : null,
      styleId, qty, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    });
    if (!r) return res.status(200).json({ price_cents: null });
    return res.status(200).json(r);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
