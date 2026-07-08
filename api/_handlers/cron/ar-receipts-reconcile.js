// api/_handlers/cron/ar-receipts-reconcile.js
//
// Daily (05:00 UTC, after the nightly invoice + payment-state push): post
// receipt JEs for invoices Xoro marks PAID, so Tangerine's AR tracks Xoro's
// state instead of ballooning while Xoro remains the operational system.
//
//   For each ar_invoices row (any source) still unpaid in the GL whose
//   ar_xoro_payment_state row says paid (full_payment_date present, or a
//   paid-like status):
//     DR 1051 Factor Advances - Rosenthal   (factored customer)
//        or 1030 Undeposited Funds          (everyone else)
//     CR the invoice's AR account            (customer subledger)
//   journal_type 'ar_receipt_xoro', posting_date = full_payment_date
//   (clamped into the open window), T11 audit reason stamped.
//
// Idempotent: one JE per invoice keyed by (source_module='xoro_receipts',
// source_id=<invoice id>); paid_amount_cents stamped on the invoice after
// posting. Batch-capped per run — the daily cron drains steadily; drive it
// repeatedly for a bulk catch-up.

import { createClient } from "@supabase/supabase-js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 300 };

const BATCH = 400;
const CLAMP_FLOOR = "2024-08-01"; // books locked through 2024-07-31
const PAID_STATUS_RE = /paid|closed|settled/i;

export function isPaidState(st) {
  if (!st) return false;
  if (st.full_payment_date) return true;
  return PAID_STATUS_RE.test(String(st.payment_status || "")) && !/partial|un/i.test(String(st.payment_status || ""));
}

export function receiptPostingDate(st, invoiceDate, todayIso) {
  let d = st.full_payment_date || invoiceDate || todayIso;
  if (d < CLAMP_FLOOR) d = CLAMP_FLOOR;
  if (d > todayIso) d = todayIso;
  return d;
}

export function composeReceiptPayload({ entity_id, invoice, st, drAccountId, todayIso }) {
  const dollars = (Number(invoice.total_amount_cents || 0) / 100).toFixed(2);
  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_receipt_xoro",
    posting_date: receiptPostingDate(st, invoice.invoice_date, todayIso),
    source_module: "xoro_receipts",
    source_table: "ar_invoices",
    source_id: String(invoice.id),
    description: `Xoro receipt — invoice ${invoice.invoice_number} paid per Xoro (${st.full_payment_date || st.payment_status || "paid"})`,
    audit_reason: `AR receipt reconciled from Xoro payment state (FullPaymentDate ${st.full_payment_date || "n/a"}) — invoice ${invoice.invoice_number}`,
    lines: [
      { line_number: 1, account_id: drAccountId, debit: dollars, credit: "0" },
      { line_number: 2, account_id: invoice.ar_account_id, debit: "0", credit: dollars, subledger_type: "customer", subledger_id: invoice.customer_id },
    ],
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const out = { scanned: 0, posted: 0, skipped_unpaid: 0, skipped_no_state: 0, skipped_existing_je: 0, errors: [] };
  try {
    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
    const todayIso = new Date().toISOString().slice(0, 10);

    // Clearing accounts (fail loudly if the chart loses them).
    const { data: accts } = await admin.from("gl_accounts")
      .select("id, code").eq("entity_id", entity.id).in("code", ["1030", "1051"]);
    const acct = new Map((accts || []).map((a) => [a.code, a.id]));
    if (!acct.get("1030") || !acct.get("1051")) {
      return res.status(500).json({ ...out, error: "Clearing accounts 1030/1051 not found in the chart" });
    }

    // Candidates: unpaid-in-GL invoices with an AR account + customer.
    const { data: candidates, error: cErr } = await admin
      .from("ar_invoices")
      .select("id, invoice_number, customer_id, ar_account_id, invoice_date, total_amount_cents, paid_amount_cents")
      .eq("entity_id", entity.id)
      .eq("paid_amount_cents", 0)
      .gt("total_amount_cents", 0)
      .not("ar_account_id", "is", null)
      .not("customer_id", "is", null)
      .order("invoice_date", { ascending: true })
      .limit(BATCH);
    if (cErr) throw new Error(`ar_invoices read failed: ${cErr.message}`);
    out.scanned = (candidates || []).length;
    if (!candidates?.length) return res.status(200).json(out);

    // Payment states + customer classes for the batch.
    const nums = [...new Set(candidates.map((c) => c.invoice_number).filter(Boolean))];
    const stateByNum = new Map();
    for (let i = 0; i < nums.length; i += 200) {
      const { data } = await admin.from("ar_xoro_payment_state")
        .select("invoice_number, payment_status, full_payment_date")
        .eq("entity_id", entity.id).in("invoice_number", nums.slice(i, i + 200));
      for (const s of data || []) stateByNum.set(s.invoice_number, s);
    }
    const custIds = [...new Set(candidates.map((c) => c.customer_id))];
    const custById = new Map();
    for (let i = 0; i < custIds.length; i += 200) {
      const { data } = await admin.from("customers")
        .select("id, is_factored").in("id", custIds.slice(i, i + 200));
      for (const c of data || []) custById.set(c.id, c);
    }

    for (const inv of candidates) {
      const st = stateByNum.get(inv.invoice_number);
      if (!st) { out.skipped_no_state++; continue; }
      if (!isPaidState(st)) { out.skipped_unpaid++; continue; }

      // Idempotency: one receipt JE per invoice.
      const { data: existing } = await admin.from("journal_entries")
        .select("id").eq("source_module", "xoro_receipts").eq("source_id", String(inv.id)).maybeSingle();
      if (existing) {
        out.skipped_existing_je++;
        await admin.from("ar_invoices").update({ paid_amount_cents: inv.total_amount_cents }).eq("id", inv.id);
        continue;
      }

      const drAccountId = custById.get(inv.customer_id)?.is_factored ? acct.get("1051") : acct.get("1030");
      const payload = composeReceiptPayload({ entity_id: entity.id, invoice: inv, st, drAccountId, todayIso });
      const { error: postErr } = await admin.rpc("gl_post_journal_entry", { payload });
      if (postErr) {
        out.errors.push(`${inv.invoice_number}: ${postErr.message}`);
        if (out.errors.length >= 10) break; // systemic problem — stop, surface
        continue;
      }
      await admin.from("ar_invoices").update({ paid_amount_cents: inv.total_amount_cents }).eq("id", inv.id);
      out.posted++;
    }

    if (out.errors.length) {
      await captureError({
        source: "cron", route: "/api/cron/ar-receipts-reconcile",
        message: `ar-receipts-reconcile: ${out.errors.length} posting error(s)`,
        context: { errors: out.errors.slice(0, 5) },
      });
    }
    return res.status(200).json(out);
  } catch (e) {
    await captureError({ source: "cron", route: "/api/cron/ar-receipts-reconcile", message: e?.message || String(e), stack: e?.stack });
    return res.status(500).json({ ...out, error: e?.message || String(e) });
  }
}
