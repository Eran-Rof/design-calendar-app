// api/vendor/tax/withholding
//
// GET — withholding tax summary for the authenticated vendor. Shows, per
// invoice, the withholding amount and the net payment the vendor will
// receive. Returns empty rows if no withholding applies.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req);
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });

  // Pull vendor's invoices + any withholding tax_calculations tied to them
  const { data: invoices } = await admin.from("invoices")
    .select("id, invoice_number, invoice_date, total, currency, status, due_date")
    .eq("vendor_id", authRes.auth.vendor_id)
    .order("invoice_date", { ascending: false });
  const invoiceIds = (invoices || []).map((i) => i.id);
  if (invoiceIds.length === 0) return res.status(200).json({ rows: [], totals: { withholding: 0, gross: 0, net: 0 } });

  const { data: calcs } = await admin.from("tax_calculations")
    .select("invoice_id, jurisdiction, tax_rate_pct, tax_amount, calculated_at")
    .in("invoice_id", invoiceIds).eq("tax_type", "withholding");

  const wByInvoice = {};
  for (const c of calcs || []) {
    (wByInvoice[c.invoice_id] ||= []).push(c);
  }

  const rows = [];
  let totalGross = 0, totalWithhold = 0;
  for (const inv of invoices || []) {
    const ws = wByInvoice[inv.id];
    if (!ws || ws.length === 0) continue;
    const withhold = ws.reduce((s, c) => s + Number(c.tax_amount || 0), 0);
    const gross = Number(inv.total || 0);
    totalGross += gross; totalWithhold += withhold;
    rows.push({
      invoice_id: inv.id, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date,
      currency: inv.currency, status: inv.status, due_date: inv.due_date,
      gross_amount: gross,
      withholding_amount: round2(withhold),
      net_payment_amount: round2(gross - withhold),
      calculations: ws.map((c) => ({ jurisdiction: c.jurisdiction, rate_pct: c.tax_rate_pct, amount: c.tax_amount })),
    });
  }

  return res.status(200).json({
    rows,
    totals: {
      gross: round2(totalGross),
      withholding: round2(totalWithhold),
      net: round2(totalGross - totalWithhold),
    },
  });
}

function round2(n) { return Math.round(n * 100) / 100; }
