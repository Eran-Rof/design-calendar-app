// GET /api/internal/cutover-recon
//
// Cutover Reconciliation report — one screen proving Tangerine matches the Xoro
// mirror across six domains so gaps can be watched down to zero before the
// Xoro -> Tangerine cutover. Read-only. Each domain runs one bounded, set-based
// jsonb tie-out function (migration 20267700000000_cutover_recon_functions):
//
//   inventory        cutover_recon_inventory()       layers vs REST by-size
//   sales_orders     cutover_recon_sales_orders()    sales_orders vs tanda_sos
//   purchase_orders  cutover_recon_purchase_orders() purchase_orders vs tanda_pos
//   ar               cutover_recon_ar()              ar_invoices vs ar_xoro_payment_state
//   ap               cutover_recon_ap()              invoices(bills) vs xoro_gl AP feed
//   gl               cutover_recon_gl()              v_xoro_tangerine_tb_recon
//
// The SQL does the join + full-set counts + a capped (<=200) variance sample;
// finalizeSection (api/_lib/cutoverRecon.js, unit-tested) classifies each sample
// row and decides PASS/FAIL from the full-set break count. Internal auth is
// applied centrally to every /api/internal/** route (api/_lib/auth.js).

import { createClient } from "@supabase/supabase-js";
import { finalizeSection } from "../../_lib/cutoverRecon.js";

export const config = { maxDuration: 60 };

// Per-domain wiring: which SQL function, label, and how finalizeSection should
// classify/threshold. threshold 0 everywhere = any break is a FAIL (burn to zero).
const DOMAINS = [
  { domain: "inventory",       rpc: "cutover_recon_inventory",       label: "Inventory",       tolerance: 0,   compareStatus: false, threshold: 0 },
  { domain: "sales_orders",    rpc: "cutover_recon_sales_orders",    label: "Sales Orders",    tolerance: 0,   compareStatus: false, threshold: 0 },
  { domain: "purchase_orders", rpc: "cutover_recon_purchase_orders", label: "Purchase Orders", tolerance: 0,   compareStatus: false, threshold: 0 },
  { domain: "ar",              rpc: "cutover_recon_ar",              label: "Accounts Receivable", tolerance: 0, compareStatus: false, threshold: 0 },
  { domain: "ap",              rpc: "cutover_recon_ap",              label: "Accounts Payable", tolerance: 100, compareStatus: false, threshold: 0 },
  { domain: "gl",              rpc: "cutover_recon_gl",              label: "General Ledger",  tolerance: 0,   compareStatus: false, threshold: 0 },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const sections = await Promise.all(
      DOMAINS.map(async (cfg) => {
        const { data, error } = await admin.rpc(cfg.rpc);
        if (error) {
          return {
            domain: cfg.domain,
            label: cfg.label,
            status: "unavailable",
            headline_metrics: {},
            variances: [],
            variance_total: 0,
            truncated: false,
            note: `Tie-out query failed: ${error.message}`,
          };
        }
        return finalizeSection(data, cfg);
      })
    );

    const failed = sections.filter((s) => s.status === "fail").length;
    const unavailable = sections.filter((s) => s.status === "unavailable").length;
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      overall_status: failed > 0 ? "fail" : unavailable > 0 ? "unavailable" : "pass",
      domains_total: sections.length,
      domains_passing: sections.filter((s) => s.status === "pass").length,
      domains_failing: failed,
      sections,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
