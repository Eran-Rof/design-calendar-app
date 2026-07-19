// api/internal/chargebacks/:id/origin
//
// Chargeback Management (#1744) — ORIGIN TRACE. For one chargeback, return its
// full origin chain so any figure that includes it can be audited down to the
// GL: the chargeback → its matched AR invoice (the source document) → the
// journal entries that posted that invoice to the ledger.
//
// The link path is: factor_chargebacks.matched_ar_invoice_id → ar_invoices →
// ar_invoices.accrual_je_id / cash_je_id → journal_entries (+ lines). The JE
// lines themselves are fetched on demand by the shared JEDetailModal via
// GET /api/internal/journal-entries/:id, so this endpoint returns the JE
// HEADERS (with a debit total for reconciliation) and lets the UI open each.
//
// Honest dead-ends: an unmatched chargeback has no source document; a matched
// invoice with no posted GL JE stops the trace at the invoice. `note` explains
// which case applies.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CB_SELECT =
  "id, item_num, customer_name, client_customer, amount_cents, item_type, cb_date, report_month, reason, reason_code, disposition, match_method, matched_ar_invoice_id, reason_ref:chargeback_reason_codes!reason_code_id(code, label, category), matched:ar_invoices!matched_ar_invoice_id(id, invoice_number, invoice_date, total_amount_cents, customer_id, accrual_je_id, cash_je_id)";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Round a numeric(18,2) dollar amount to integer cents (money.js discipline).
function toCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const id = (req.query?.id || "").toString().trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "id must be a uuid" });

  try {
    const { data: cb, error } = await admin
      .from("factor_chargebacks")
      .select(CB_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!cb) return res.status(404).json({ error: "Chargeback not found" });

    const inv = cb.matched || null;

    let customerName = null;
    if (inv && inv.customer_id) {
      const { data: c } = await admin.from("customers").select("name").eq("id", inv.customer_id).maybeSingle();
      customerName = c?.name || null;
    }

    // Collect the invoice's JE pointers (accrual + cash, deduped).
    const legById = new Map();
    if (inv) {
      if (inv.accrual_je_id) legById.set(inv.accrual_je_id, "accrual");
      if (inv.cash_je_id && !legById.has(inv.cash_je_id)) legById.set(inv.cash_je_id, "cash");
    }
    const jeIds = [...legById.keys()];

    let jes = [];
    if (jeIds.length) {
      const { data: heads, error: hErr } = await admin
        .from("journal_entries")
        .select("id, je_number, basis, journal_type, posting_date, status, description")
        .in("id", jeIds);
      if (hErr) return res.status(500).json({ error: hErr.message });

      const { data: lines, error: lErr } = await admin
        .from("journal_entry_lines")
        .select("journal_entry_id, debit")
        .in("journal_entry_id", jeIds);
      if (lErr) return res.status(500).json({ error: lErr.message });
      const debitByJe = new Map();
      for (const l of lines || []) {
        debitByJe.set(l.journal_entry_id, (debitByJe.get(l.journal_entry_id) || 0) + toCents(l.debit));
      }

      jes = (heads || [])
        .map((h) => ({
          id: h.id,
          je_number: h.je_number,
          basis: h.basis,
          journal_type: h.journal_type,
          posting_date: h.posting_date,
          status: h.status,
          description: h.description,
          leg: legById.get(h.id) || null,
          total_debit_cents: debitByJe.get(h.id) || 0,
        }))
        .sort((a, b) => (a.leg === "accrual" ? -1 : b.leg === "accrual" ? 1 : 0));
    }

    let note;
    if (!inv) {
      note = "This chargeback is not matched to an AR invoice, so it has no source document and cannot be traced to a journal entry. Match it to an invoice from the detail view to enable the origin trace.";
    } else if (jes.length === 0) {
      note = `Matched to AR invoice ${inv.invoice_number}, but that invoice has no posted GL journal entry (ar_invoices.accrual_je_id / cash_je_id are both empty), so the trace stops at the invoice.`;
    } else {
      note = `Traced: chargeback ${cb.item_num} → AR invoice ${inv.invoice_number} → ${jes.length} journal entr${jes.length === 1 ? "y" : "ies"}.`;
    }

    return res.status(200).json({
      chargeback: {
        id: cb.id,
        item_num: cb.item_num,
        customer_name: cb.customer_name,
        client_customer: cb.client_customer,
        amount_cents: cb.amount_cents,
        item_type: cb.item_type,
        cb_date: cb.cb_date,
        report_month: cb.report_month,
        reason: cb.reason,
        reason_code: cb.reason_code,
        reason_ref: cb.reason_ref || null,
        disposition: cb.disposition,
        match_method: cb.match_method,
      },
      invoice: inv
        ? {
            id: inv.id,
            invoice_number: inv.invoice_number,
            invoice_date: inv.invoice_date,
            total_amount_cents: inv.total_amount_cents,
            customer_id: inv.customer_id,
            customer_name: customerName,
          }
        : null,
      jes,
      note,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
