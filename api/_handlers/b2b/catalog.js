// api/b2b/catalog  (GET /api/b2b/catalog)
//
// P18-C — the B2B customer portal catalog + per-customer wholesale pricing.
//
// The /b2b browser app calls this with the buyer's Supabase access token
// (`Authorization: Bearer <jwt>`). We resolve the (server-trusted) customer_id
// via resolveB2BSession, then return the ACTIVE style catalog with each style's
// RESOLVED wholesale price for THIS customer.
//
// Filters: ?brand_id=<uuid> &gender=<code> &q=<text> (style_code / style_name).
//
// Pricing resolution (most-specific first), implemented server-side:
//   1. b2b_price_list row with customer_id = session customer_id
//   2. b2b_price_list row with customer_tier = customers.customer_tier (and customer_id NULL)
//   3. default row (customer_id NULL AND customer_tier NULL)
// Only is_active rows that are in-effect on today's date are considered; ties
// within a tier are broken by lowest price. Styles with no resolvable price are
// returned with price_cents: null ("Call for price").
//
// SECURITY: customer_id + customer_tier are read from b2b_accounts/customers via
// the verified session — NEVER from the client. Prices a buyer sees are scoped
// to their own customer; another customer's customer-specific prices are never
// applied or returned.

import { createClient } from "@supabase/supabase-js";
import { resolveB2BSession } from "../../_lib/b2b/session.js";
import { pickBestPrice } from "../../_lib/b2b/pricing.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function adminClient() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = adminClient();
  const sess = await resolveB2BSession(req, admin);
  if (!sess.ok) return res.status(sess.status).json({ error: sess.error });
  const { customer_id } = sess;

  // The customer's tier governs which tier-priced rows apply to this buyer.
  let tier = null;
  try {
    const { data: cust } = await admin
      .from("customers")
      .select("customer_tier")
      .eq("id", customer_id)
      .maybeSingle();
    tier = cust?.customer_tier || null;
  } catch { /* non-fatal: tier rows simply won't apply */ }

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const brandId = (url.searchParams.get("brand_id") || "").trim();
  const gender = (url.searchParams.get("gender") || "").trim();
  const q = (url.searchParams.get("q") || "").trim();

  // ── 1. Active catalog (deleted_at IS NULL AND lifecycle_status='active') ─────
  let styleQ = admin
    .from("style_master")
    .select("id, style_code, style_name, description, brand_id, gender_code, group_name, category_name, sub_category_name")
    .is("deleted_at", null)
    .eq("lifecycle_status", "active")
    .order("style_code", { ascending: true })
    .limit(1000);
  if (brandId && UUID_RE.test(brandId)) styleQ = styleQ.eq("brand_id", brandId);
  if (gender) styleQ = styleQ.eq("gender_code", gender);
  if (q) {
    const esc = q.replace(/[%,()]/g, " ");
    styleQ = styleQ.or(`style_code.ilike.%${esc}%,style_name.ilike.%${esc}%,description.ilike.%${esc}%`);
  }
  const { data: styles, error: sErr } = await styleQ;
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!styles || styles.length === 0) return res.status(200).json([]);

  const styleIds = styles.map((s) => s.id);

  // ── 2. Candidate price rows: ONLY rows that could apply to this customer ─────
  // (customer-specific for THIS customer) OR (customer_id IS NULL → tier/default).
  // We never load another customer's customer-specific rows.
  const { data: priceRows, error: pErr } = await admin
    .from("b2b_price_list")
    .select("style_id, customer_id, customer_tier, price_cents, currency, min_qty, effective_from, effective_to, is_active")
    .eq("is_active", true)
    .in("style_id", styleIds)
    .or(`customer_id.eq.${customer_id},customer_id.is.null`);
  if (pErr) return res.status(500).json({ error: pErr.message });

  const byStyle = new Map();
  for (const r of priceRows || []) {
    if (!byStyle.has(r.style_id)) byStyle.set(r.style_id, []);
    byStyle.get(r.style_id).push(r);
  }

  // ── 3. Brand + gender label lookups for display ──────────────────────────────
  const brandIds = [...new Set(styles.map((s) => s.brand_id).filter(Boolean))];
  const genderCodes = [...new Set(styles.map((s) => s.gender_code).filter(Boolean))];
  const brandMap = new Map();
  const genderMap = new Map();
  try {
    if (brandIds.length) {
      const { data: brands } = await admin.from("brand_master").select("id, name").in("id", brandIds);
      for (const b of brands || []) brandMap.set(b.id, b.name);
    }
    if (genderCodes.length) {
      const { data: genders } = await admin.from("gender_master").select("code, label").in("code", genderCodes);
      for (const g of genders || []) genderMap.set(g.code, g.label);
    }
  } catch { /* non-fatal: fall back to raw codes */ }

  const today = new Date().toISOString().slice(0, 10);

  const out = styles.map((s) => {
    const best = pickBestPrice(byStyle.get(s.id) || [], today, tier);
    return {
      style_id:          s.id,
      style_code:        s.style_code,
      style_name:        s.style_name || null,
      description:       s.description || null,
      brand_id:          s.brand_id || null,
      brand_name:        s.brand_id ? (brandMap.get(s.brand_id) || null) : null,
      gender_code:       s.gender_code || null,
      gender_label:      s.gender_code ? (genderMap.get(s.gender_code) || s.gender_code) : null,
      group_name:        s.group_name || null,
      category_name:     s.category_name || null,
      sub_category_name: s.sub_category_name || null,
      price_cents:       best ? best.price_cents : null,
      currency:          best ? best.currency : null,
      min_qty:           best ? Number(best.min_qty) || 0 : null,
    };
  });

  return res.status(200).json(out);
}
