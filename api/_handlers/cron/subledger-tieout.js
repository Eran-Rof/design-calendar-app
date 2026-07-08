// api/_handlers/cron/subledger-tieout.js
//
// Daily (06:00 UTC): prove the books. Compares each control account's
// cumulative GL balance (posted ACCRUAL JEs) against its subledger total —
// AR classes 1105/1107/1108 vs open ar_invoices grouped by ar_account_id,
// AP 2000 vs unpaid posted vendor bills — via api/_lib/accounting/tieouts.js.
// From the 2026-07-08 accounting audit: "best-in-class books are
// continuously proven", not proven once at close.
//
// Any |diff| > $0.01 → ONE bell+email notification (roles admin +
// accounting, same pattern as xoro-feed-health-alert; the email drain
// worker delivers) AND a captureError row so the daily app-errors digest
// catches it too. Silent when everything ties.
//
// EXPECTED DIFFS during the transition — read before panicking:
//   • AR: the per-invoice AR history backfill (~23k invoices →
//     posted_historical) is MID-FLIGHT. Until it completes, mirrored
//     invoices are only in the GL via the routed daily summaries, so AR
//     classes will alert daily. That is intentional — the alert going
//     quiet is the "backfill done" signal.
//   • AP 2000: vendor-bill payments are NOT posted yet (bills only accrue,
//     #1662), so GL 2000 and the bills ledger drift apart the moment Xoro
//     marks bills paid. Rather than crying wolf, the tie-out is marked
//     status='pending_payments' with a `waived` note (NOT alerted) while
//     sum(paid_amount_cents)=0 across posted bills; once the first payment
//     lands in the invoices ledger the waiver lifts automatically and 2000
//     alerts like everything else.
//
// Note: app_errors.source is CHECK-constrained to ('api','client','cron'),
// so the capture rides source='cron' with context.kind='tieout' — the
// digest fingerprints on route+message, which both carry "tieout".

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { captureError } from "../../_lib/errorCapture.js";
import { runControlTieouts, formatUsd, TOLERANCE_CENTS } from "../../_lib/accounting/tieouts.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const out = { checked: 0, breaks: 0, waived: [], rows: [], alerted: false };
  try {
    const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
    if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const { rows, meta } = await runControlTieouts(admin, entity.id);
    out.checked = rows.length;
    out.rows = rows;
    out.meta = meta;
    out.waived = rows
      .filter((r) => r.waived)
      .map((r) => ({ account_code: r.account_code, note: r.waived, diff_cents: r.diff_cents }));

    const breaks = rows.filter((r) => r.status === "break");
    out.breaks = breaks.length;
    if (breaks.length === 0) return res.status(200).json(out);

    const name = (code) => meta.account_names?.[code] || code;
    const lines = breaks.map((r) =>
      `• ${r.account_code} ${name(r.account_code)} — GL ${formatUsd(r.gl_cents)} vs subledger ${formatUsd(r.subledger_cents)} → off by ${formatUsd(r.diff_cents)}`);
    const extras = [];
    if (meta.ar_unmapped_cents) {
      extras.push(`${formatUsd(meta.ar_unmapped_cents)} of open AR sits on invoices with NO ar_account_id — it can't tie to any control account.`);
    }
    if (meta.missing_accounts?.length) {
      extras.push(`Control account code(s) missing from the chart: ${meta.missing_accounts.join(", ")}.`);
    }
    const body =
      `${breaks.length} control account(s) do not tie to their subledger (tolerance ${formatUsd(TOLERANCE_CENTS)}, cumulative ACCRUAL balances):\n\n` +
      lines.join("\n") +
      (out.waived.length
        ? `\n\nWaived (not alerted): ${out.waived.map((w) => `${w.account_code} [${w.note}, off ${formatUsd(w.diff_cents)}]`).join(", ")}.`
        : "") +
      (extras.length ? `\n\n${extras.join("\n")}` : "") +
      `\n\nNOTE: while the AR history backfill is mid-flight, AR class diffs are EXPECTED and shrink as invoices land; this alert going quiet is the backfill-complete signal. ` +
      `Drill: Tangerine → Accounting → GL Detail on the account, vs AR Invoices / AP Bills grids filtered to open balances.`;

    try {
      const ev = await enqueueNotification(admin, {
        entity_id: entity.id,
        kind: "subledger_tieout_break",
        severity: "error",
        subject: `Subledger tie-out: ${breaks.length} control account(s) off — ${breaks.map((b) => b.account_code).join(", ")}`,
        body,
        context_table: "journal_entry_lines",
        context_id: null,
        payload: { breaks, waived: out.waived, meta },
        recipient_roles: ["admin", "accounting"],
      });
      out.alerted = true;
      out.notification_event_id = ev?.event_id || null;
    } catch (e) {
      out.error = `notification enqueue failed: ${String(e?.message || e)}`;
    }

    // Also land in app_errors so the daily digest picks it up even if the
    // notification path hiccups. source must be 'cron' (DB check constraint);
    // 'tieout' is carried in the route/message/context for fingerprinting.
    await captureError({
      source: "cron",
      route: "/api/cron/subledger-tieout",
      message: `tieout: ${breaks.length} control account(s) off — ${breaks.map((b) => `${b.account_code} ${formatUsd(b.diff_cents)}`).join(", ")}`,
      context: { kind: "tieout", breaks, waived: out.waived },
    });

    return res.status(200).json(out);
  } catch (e) {
    await captureError({ source: "cron", route: "/api/cron/subledger-tieout", message: e?.message || String(e), stack: e?.stack, context: { kind: "tieout" } });
    return res.status(500).json({ ...out, error: e?.message || String(e) });
  }
}
