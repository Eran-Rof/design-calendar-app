// GET /api/internal/journal-entries/:id/source — resolve a JE's source
// document into a navigable target (QuickBooks-grade drill: JE → the
// invoice/bill/receipt/adjustment that created it).
//
// journal_entries.source_table/source_id are by-convention strings (no FK),
// so this is THE one place that switches on them. Returns:
//   { label,            // human description ("AR invoice AR-2026-00012")
//     module,           // Tangerine ?m= key to open, or null (no per-doc panel)
//     q,                // one-shot search param the target list consumes
//     docs,             // [] | [{ kind, number, module, q, leg }] — the source
//                       //   document(s). One → also mirrored into module/q.
//                       //   Many → the caller shows a picker.
//     count, truncated } // total docs found, and whether `docs` was capped
// Unknown/panel-less tables return module:null with a best-effort label —
// the UI shows the label un-linked instead of a dead link.
//
// GL-mirror JEs (journal_type='xoro_gl_mirror', source_table='xoro_gl_mirror')
// carry the Xoro txn as their source, NOT the invoice/bill — the link runs the
// OTHER way: ar_invoices/invoices.accrual_je_id | cash_je_id = this JE's id. So
// when the forward switch finds no document we run a REVERSE lookup by JE id to
// reach the actual invoice(s)/bill(s). A payment/receipt mirror JE can settle
// hundreds of invoices at once (fan-out), hence the docs[] list + picker.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cap the reverse-lookup list so a giant payment JE (settling ~1,000 invoices)
// stays a snappy response + a usable picker. Anything beyond this is flagged
// `truncated` so the UI can say "showing first N of M".
const REVERSE_DOC_CAP = 400;

// Reverse lookup: documents whose accrual_je_id OR cash_je_id points AT this JE.
// Returns { docs:[{ kind, number, module, q, leg, id, docType, party }], count,
// truncated }. `id` + `docType` let the caller open the actual invoice/bill
// document in place (QuickBooks-style), and `party` is the customer/vendor name.
async function reverseDocs(admin, jeId) {
  const out = [];
  const specs = [
    { table: "ar_invoices", numberCol: "invoice_number", module: "ar_invoices", kind: "AR invoice", docType: "ar", partyTable: "customers", partyCol: "customer_id" },
    { table: "invoices", numberCol: "invoice_number", module: "ap_invoices", kind: "AP bill", docType: "ap", partyTable: "vendors", partyCol: "vendor_id" },
  ];
  for (const s of specs) {
    for (const leg of ["accrual", "cash"]) {
      const col = `${leg}_je_id`;
      const { data, error } = await admin
        .from(s.table)
        .select(`${s.numberCol}, id, ${s.partyCol}`)
        .eq(col, jeId)
        .limit(REVERSE_DOC_CAP + 1);
      if (error || !data) continue;
      for (const row of data) {
        const number = row[s.numberCol] ? String(row[s.numberCol]) : null;
        out.push({
          kind: s.kind, number, module: number ? s.module : null, q: number, leg,
          id: row.id || null, docType: s.docType, partyTable: s.partyTable, partyId: row[s.partyCol] || null,
        });
      }
    }
  }
  // A doc linked on BOTH legs to the same JE would appear twice — dedupe by
  // (module, number), preferring the accrual leg's label.
  const seen = new Set();
  const deduped = [];
  for (const d of out) {
    const key = `${d.module}|${d.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(d);
  }
  deduped.sort((a, b) => String(a.number || "").localeCompare(String(b.number || "")));
  const count = deduped.length;
  const truncated = count > REVERSE_DOC_CAP;
  const kept = truncated ? deduped.slice(0, REVERSE_DOC_CAP) : deduped;
  await attachPartyNames(admin, kept);
  return { docs: kept.map(stripInternal), count, truncated };
}

// Batch-resolve customer/vendor display names onto the kept docs (one query per
// party table), so the document viewer shows "Shopify psychotuna" not a UUID.
async function attachPartyNames(admin, docs) {
  for (const partyTable of ["customers", "vendors"]) {
    const ids = [...new Set(docs.filter((d) => d.partyTable === partyTable && d.partyId).map((d) => d.partyId))];
    if (ids.length === 0) continue;
    const { data } = await admin.from(partyTable).select("id, name").in("id", ids);
    const byId = {};
    for (const r of (data || [])) byId[r.id] = r.name;
    for (const d of docs) if (d.partyTable === partyTable && d.partyId) d.party = byId[d.partyId] || null;
  }
}

// Drop the internal join keys before returning to the client.
function stripInternal(d) {
  const { partyTable: _pt, partyId: _pi, ...rest } = d;
  return rest;
}

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

  // Special case: the daily Xoro mirror summary — a run, not a document.
  if (je.source_table === "xoro_mirror_runs") {
    const { data: run } = await admin.from("xoro_mirror_runs")
      .select("domain, mirror_date").eq("id", je.source_id).maybeSingle();
    return res.status(200).json({
      label: run ? `Xoro mirror daily summary — ${run.domain} ${run.mirror_date}` : "Xoro mirror daily summary",
      module: null, q: null, docs: [], count: 0, truncated: false,
    });
  }

  // 1) Forward resolve — a source_table we know maps to a document (freshly
  //    posted AR/AP/receipt/build JEs carry their own document ref).
  const r = je.source_table ? RESOLVERS[je.source_table] : null;
  if (r && je.source_id) {
    // For AR/AP the document is openable in place — carry its id + docType +
    // party name so the caller can render the actual invoice/bill.
    const isDoc = je.source_table === "ar_invoices" || je.source_table === "invoices";
    const docType = je.source_table === "ar_invoices" ? "ar" : je.source_table === "invoices" ? "ap" : null;
    const partyTable = je.source_table === "ar_invoices" ? "customers" : je.source_table === "invoices" ? "vendors" : null;
    const partyCol = je.source_table === "ar_invoices" ? "customer_id" : je.source_table === "invoices" ? "vendor_id" : null;
    let number = null;
    let docId = null;
    let party = null;
    if (UUID_RE.test(String(je.source_id))) {
      docId = String(je.source_id);
      const sel = isDoc ? `${r.numberCol}, ${partyCol}` : r.numberCol;
      const { data: doc } = await admin.from(r.table).select(sel).eq("id", je.source_id).maybeSingle();
      number = doc ? String(doc[r.numberCol] ?? "") : null;
      if (doc && partyTable && doc[partyCol]) {
        const { data: p } = await admin.from(partyTable).select("name").eq("id", doc[partyCol]).maybeSingle();
        party = p?.name || null;
      }
    } else {
      number = String(je.source_id);
    }
    if (number) {
      const one = { kind: r.kind, number, module: r.module, q: number, leg: null, id: docId, docType, party };
      return res.status(200).json({
        label: `${r.kind} ${number}`, module: r.module, q: number,
        docs: [one], count: 1, truncated: false,
      });
    }
  }

  // 2) Reverse lookup — GL-mirror (and any JE whose forward source is not a
  //    document): find the invoice(s)/bill(s) that point AT this JE.
  const { docs, count, truncated } = await reverseDocs(admin, id);
  if (count === 1) {
    const d = docs[0];
    return res.status(200).json({
      label: `${d.kind}${d.number ? ` ${d.number}` : ""}`,
      module: d.module, q: d.q, docs, count, truncated,
    });
  }
  if (count > 1) {
    const arN = docs.filter((d) => d.module === "ar_invoices").length;
    const apN = docs.filter((d) => d.module === "ap_invoices").length;
    const parts = [];
    if (arN) parts.push(`${arN} AR invoice${arN === 1 ? "" : "s"}`);
    if (apN) parts.push(`${apN} AP bill${apN === 1 ? "" : "s"}`);
    return res.status(200).json({
      label: `${count} source document${count === 1 ? "" : "s"}${parts.length ? ` — ${parts.join(", ")}` : ""}`,
      module: null, q: null, docs, count, truncated,
    });
  }

  // 3) No document either way — a payroll / adjustment / manufacturing mirror
  //    JE. Never dead-end: the caller keeps showing the JE detail (Xoro txn +
  //    memo) alongside this label.
  const label = je.source_module
    ? `GL journal entry — posted by ${je.source_module} (no source document)`
    : "GL journal entry (no source document)";
  return res.status(200).json({ label, module: null, q: null, docs: [], count: 0, truncated: false });
}
