// api/internal/payments
//
// GET  — list payments for an entity.
//   ?entity_id=&status=&vendor_id=&invoice_id=&method=&limit=&offset=
// POST — create a payment.
//   body: { entity_id, vendor_id, invoice_id?, amount, currency?, method?, reference?, metadata? }

import { createClient } from "@supabase/supabase-js";
import { validatePaymentInput } from "../../../_lib/payments.js";
import { computePaymentFx, latestRate, DEFAULT_FEE_PCT } from "../../../_lib/fx.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const entityId = url.searchParams.get("entity_id") || req.headers["x-entity-id"];
    if (!entityId) return res.status(400).json({ error: "entity_id required" });
    const status    = url.searchParams.get("status");
    const vendorId  = url.searchParams.get("vendor_id");
    const invoiceId = url.searchParams.get("invoice_id");
    const method    = url.searchParams.get("method");
    const limit  = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    let q = admin.from("payments")
      .select("*, vendor:vendors(id, name), invoice:invoices(id, invoice_number, total)", { count: "exact" })
      .eq("entity_id", entityId)
      .order("initiated_at", { ascending: false });
    if (status)    q = q.eq("status", status);
    if (vendorId)  q = q.eq("vendor_id", vendorId);
    if (invoiceId) q = q.eq("invoice_id", invoiceId);
    if (method)    q = q.eq("method", method);

    const { data, error, count } = await q.range(offset, offset + limit - 1);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ rows: data || [], total: count || 0, limit, offset });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const errs = validatePaymentInput(body);
    if (errs.length) return res.status(400).json({ error: errs.join("; ") });

    // Load vendor preference to see if FX is needed
    const entityCurrency = body.currency || "USD";
    const { data: pref } = await admin.from("vendor_payment_preferences").select("preferred_currency, fx_handling").eq("vendor_id", body.vendor_id).maybeSingle();
    const vendorCurrency = pref?.preferred_currency || entityCurrency;
    const fxHandling = pref?.fx_handling || "pay_in_usd_vendor_absorbs";

    let fxPlan = null;
    if (vendorCurrency !== entityCurrency) {
      const rateRow = await latestRate(admin, entityCurrency, vendorCurrency);
      if (rateRow?.rate) {
        fxPlan = computePaymentFx({
          invoiceAmount: Number(body.amount),
          entityCurrency, vendorCurrency,
          rate: Number(rateRow.rate),
          feePct: Number(process.env.FX_FEE_PCT) || DEFAULT_FEE_PCT,
          fxHandling,
        });
      }
    }

    const paymentAmount = fxPlan?.to_amount ?? Number(body.amount);
    const paymentCurrency = fxPlan?.vendor_currency ?? entityCurrency;

    const { data, error } = await admin.from("payments").insert({
      entity_id: body.entity_id,
      invoice_id: body.invoice_id || null,
      vendor_id: body.vendor_id,
      amount: paymentAmount,
      currency: paymentCurrency,
      method: body.method || "ach",
      status: "initiated",
      reference: body.reference || null,
      metadata: { ...(body.metadata || {}), ...(fxPlan ? { fx_plan: fxPlan, entity_amount: Number(body.amount), entity_currency: entityCurrency } : {}) },
    }).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // Create international_payments row when currencies crossed
    if (fxPlan?.needs_international_row) {
      await admin.from("international_payments").insert({
        payment_id: data.id,
        from_currency: entityCurrency,
        to_currency: fxPlan.vendor_currency,
        from_amount: fxPlan.from_amount,
        to_amount: fxPlan.to_amount,
        fx_rate: fxPlan.fx_rate,
        fx_fee_amount: fxPlan.fx_fee_amount,
        fx_provider: process.env.FX_PROVIDER_NAME || "manual",
        status: "pending",
      });
    }

    return res.status(201).json({ ...data, fx: fxPlan });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
