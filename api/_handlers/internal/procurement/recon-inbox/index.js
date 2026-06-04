// api/internal/procurement/recon-inbox
//
// P13 / C5 — procurement reconciliation inbox + open-commitments report.
// Read-only aggregation for the default (ROF) entity:
//   { open_commitments: [{vendor_id, vendor_name, open_count, remaining_cents}],
//     open_commitments_total_cents,
//     stale_customs:   [customs_entries > 60d with no broker invoice],
//     three_way_issues:[vendor_invoice_drafts in variance/exception],
//     qc_fails:        [failed QC inspections],
//     summary: {...counts} }
//
// Surfaces the procurement states that block a clean period close (see the
// close pre-flight augmentation in gl-periods/preflight.js). No writes.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // ── Open commitments by vendor ──────────────────────────────────────────────
  const { data: commits, error: cErr } = await admin.from("po_commitments")
    .select("vendor_id, committed_amount_cents, consumed_amount_cents, status, vendor:vendors!po_commitments_vendor_id_fkey(id,name)")
    .eq("entity_id", entityId).in("status", ["open", "partial"]);
  if (cErr) return res.status(500).json({ error: cErr.message });
  const byVendor = new Map();
  let openTotal = 0;
  for (const c of commits || []) {
    const remaining = Math.max(Number(c.committed_amount_cents) - Number(c.consumed_amount_cents), 0);
    openTotal += remaining;
    const k = c.vendor_id || "—";
    if (!byVendor.has(k)) byVendor.set(k, { vendor_id: c.vendor_id, vendor_name: c.vendor?.name || "—", open_count: 0, remaining_cents: 0 });
    const v = byVendor.get(k); v.open_count += 1; v.remaining_cents += remaining;
  }
  const open_commitments = [...byVendor.values()].sort((a, b) => b.remaining_cents - a.remaining_cents);

  // ── Stale customs entries (> 60d, no broker invoice) ────────────────────────
  let stale_customs = [];
  const { data: customs } = await admin.from("customs_entries")
    .select("id, entry_number, entry_date, total_duty_cents").eq("entity_id", entityId).lt("entry_date", daysAgo(60));
  if (customs && customs.length) {
    const ids = customs.map((c) => c.id);
    const { data: bi } = await admin.from("broker_invoices").select("customs_entry_id").in("customs_entry_id", ids);
    const haveBroker = new Set((bi || []).map((b) => b.customs_entry_id));
    stale_customs = customs.filter((c) => !haveBroker.has(c.id));
  }

  // ── Unresolved 3-way match (variance / exception) ───────────────────────────
  const { data: tw } = await admin.from("vendor_invoice_drafts")
    .select("id, vendor_invoice_number, invoice_date, total_cents, variance_cents, three_way_match_status, vendor:vendors!vendor_invoice_drafts_vendor_id_fkey(name)")
    .eq("entity_id", entityId).in("three_way_match_status", ["variance", "exception"]);
  const three_way_issues = tw || [];

  // ── QC failures ─────────────────────────────────────────────────────────────
  const { data: qc } = await admin.from("tanda_po_qc_inspections")
    .select("id, receipt_id, inspection_date, status").eq("entity_id", entityId).eq("status", "failed");
  const qc_fails = qc || [];

  return res.status(200).json({
    open_commitments,
    open_commitments_total_cents: openTotal,
    stale_customs,
    three_way_issues,
    qc_fails,
    summary: {
      open_commitment_vendors: open_commitments.length,
      stale_customs: stale_customs.length,
      three_way_issues: three_way_issues.length,
      qc_fails: qc_fails.length,
    },
  });
}
