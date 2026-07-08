// GET /api/internal/journal-entries/:id/source — resolve a JE's source
// document into a navigable target (QuickBooks-grade drill: JE → the
// invoice/bill/receipt/adjustment that created it).
//
// journal_entries.source_table/source_id are by-convention strings (no FK),
// so this is THE one place that switches on them. Returns:
//   { label,            // human description ("AR invoice AR-2026-00012")
//     module,           // Tangerine ?m= key to open, or null (no per-doc panel)
//     q }               // one-shot search param the target list consumes
// Unknown/panel-less tables return module:null with a best-effort label —
// the UI shows the label un-linked instead of a dead link.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// source_table → { module, table, numberCol, kind }
const RESOLVERS = {
  ar_invoices: { module: "ar_invoices", table: "ar_invoices", numberCol: "invoice_number", kind: "AR invoice" },
  invoices: { module: "ap_invoices", table: "invoices", numberCol: "invoice_number", kind: "AP bill" },
  payments: { module: "ap_payments", table: "invoice_payments", numberCol: "reference", kind: "AP payment" },
  invoice_payments: { module: "ap_payments", table: "invoice_payments", numberCol: "reference", kind: "AP payment" },
  ar_receipts: { module: "ar_receipts", table: "ar_receipts", numberCol: "reference", kind: "AR receipt" },
  inventory_adjustments: { module: "inventory_adjustments", table: "inventory_adjustments", numberCol: "id", kind: "Inventory adjustment" },
  commission_accruals: { module: "commission_accruals", table: "commission_accruals", numberCol: "id", kind: "Commission accrual" },
  commission_payouts: { module: "commission_payouts", table: "commission_payouts", numberCol: "id", kind: "Commission payout" },
  mfg_build_issue: { module: "mfg_build_orders", table: "mfg_build_orders", numberCol: "build_number", kind: "Build order (issue)" },
  mfg_build_complete: { module: "mfg_build_orders", table: "mfg_build_orders", numberCol: "build_number", kind: "Build order (complete)" },
  mfg_build_service: { module: "mfg_build_orders", table: "mfg_build_orders", numberCol: "build_number", kind: "Build order (service)" },
};

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const { data: je, error } = await admin
    .from("journal_entries")
    .select("source_module, source_table, source_id")
    .eq("id", id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!je) return res.status(404).json({ error: "JE not found" });
  if (!je.source_table || !je.source_id) {
    return res.status(200).json({ label: je.source_module ? `Posted by ${je.source_module} (no document ref)` : "Manual entry — no source document", module: null, q: null });
  }

  // Special case: the daily Xoro mirror summary — a run, not a document.
  if (je.source_table === "xoro_mirror_runs") {
    const { data: run } = await admin.from("xoro_mirror_runs")
      .select("domain, mirror_date").eq("id", je.source_id).maybeSingle();
    return res.status(200).json({
      label: run ? `Xoro mirror daily summary — ${run.domain} ${run.mirror_date}` : "Xoro mirror daily summary",
      module: null, q: null,
    });
  }

  const r = RESOLVERS[je.source_table];
  if (!r) {
    return res.status(200).json({ label: `${je.source_table} ${String(je.source_id).slice(0, 8)}…`, module: null, q: null });
  }
  let number = null;
  if (UUID_RE.test(String(je.source_id))) {
    const { data: doc } = await admin.from(r.table).select(r.numberCol).eq("id", je.source_id).maybeSingle();
    number = doc ? String(doc[r.numberCol] ?? "") : null;
  } else {
    number = String(je.source_id);
  }
  return res.status(200).json({
    label: `${r.kind}${number ? ` ${number}` : ""}`,
    module: number ? r.module : null,
    q: number || null,
  });
}
