// api/internal/ap-backfill/run
//
// Per-bill AP GL posting sweep (re-rate 2026-07-08 remediation — zero AP JEs
// had ever posted; the daily summary was rejected by the control-account
// guard). POST body: { dry_run?: boolean (default true), limit?: number }.
//
// Walks invoices rows with source IN ('xoro_ap') AND gl_status='unposted',
// composes one JE per bill via composeApBillJe (DR 1201 goods / DR 8007
// non-item+tax / CR 2000 vendor-subledgered) and posts through
// gl_post_journal_entry. On success sets gl_status='posted' + accrual_je_id.
//
// Idempotent three ways: only unposted bills are selected; the posting RPC's
// (source_table, source_id, basis) unique index rejects a duplicate JE; and a
// bill that fails is logged into the response and left unposted for the next
// sweep. Safe to re-run any time — the nightly sync-bills ingest calls this
// same sweep after upserting new bills.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";
import { splitBillLineCents, composeApBillJe } from "../../../_lib/accounting/apBillPosting.js";

export const config = { maxDuration: 300 };

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export async function runApPostingSweep(admin, { dry_run = true, limit = 500 } = {}) {
  const { data: entity, error: eErr } = await admin
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) throw new Error("Default entity (ROF) not found");

  const { data: acctRows, error: aErr } = await admin
    .from("gl_accounts").select("id, code")
    .eq("entity_id", entity.id).in("code", ["1201", "8007", "2000"]);
  if (aErr) throw new Error(`gl_accounts read failed: ${aErr.message}`);
  const byCode = new Map((acctRows || []).map((r) => [r.code, r.id]));
  const accounts = {
    inventory: byCode.get("1201"),
    fallbackExpense: byCode.get("8007"),
    ap: byCode.get("2000"),
  };
  if (!accounts.inventory || !accounts.fallbackExpense || !accounts.ap) {
    throw new Error("Missing required GL accounts (1201 / 8007 / 2000)");
  }

  const { data: bills, error: bErr } = await admin
    .from("invoices")
    .select("id, invoice_number, vendor_id, invoice_date, posting_date, total_amount_cents")
    .eq("source", "xoro_ap")
    .eq("gl_status", "unposted")
    .order("invoice_date", { ascending: true })
    .limit(Math.min(Number(limit) || 500, 1000));
  if (bErr) throw new Error(`invoices read failed: ${bErr.message}`);

  const result = { scanned: (bills || []).length, posted: 0, skipped: [], errors: [], dry_run };

  for (const bill of bills || []) {
    // Page lines defensively (a bill can exceed the PostgREST 1000-row cap).
    const lines = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error: lErr } = await admin
        .from("invoice_line_items")
        .select("inventory_item_id, quantity, unit_cost_cents")
        .eq("invoice_id", bill.id)
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (lErr) { result.errors.push({ bill: bill.invoice_number, error: lErr.message }); break; }
      lines.push(...(page || []));
      if (!page || page.length < 1000) break;
    }

    const { goods_cents, other_cents } = splitBillLineCents(lines);
    const payload = composeApBillJe({
      entity_id: entity.id, bill, goods_cents, other_cents, accounts,
    });
    if (!payload) {
      result.skipped.push({ bill: bill.invoice_number, reason: bill.vendor_id ? "zero_total" : "no_vendor" });
      continue;
    }
    if (dry_run) { result.posted += 1; continue; }

    const { data: jeId, error: postErr } = await admin.rpc("gl_post_journal_entry", { payload });
    if (postErr) {
      // 23505-equivalent from the (source_table, source_id, basis) unique
      // index = JE already exists (e.g. a prior sweep died between post and
      // status update) — heal the bill row instead of erroring forever.
      if (/duplicate key|uq_je_source/i.test(postErr.message || "")) {
        const { data: existing } = await admin.from("journal_entries")
          .select("id").eq("source_table", "invoices").eq("source_id", bill.id)
          .eq("basis", "ACCRUAL").maybeSingle();
        if (existing) {
          await admin.from("invoices")
            .update({ gl_status: "posted", accrual_je_id: existing.id, posting_date: payload.posting_date })
            .eq("id", bill.id);
          result.posted += 1;
          continue;
        }
      }
      result.errors.push({ bill: bill.invoice_number, error: postErr.message });
      continue;
    }
    const { error: updErr } = await admin.from("invoices")
      .update({ gl_status: "posted", accrual_je_id: jeId, posting_date: payload.posting_date })
      .eq("id", bill.id);
    if (updErr) {
      result.errors.push({ bill: bill.invoice_number, error: `posted JE ${jeId} but status update failed: ${updErr.message}` });
      continue;
    }
    result.posted += 1;
  }
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // clamped by the dispatcher
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const dry_run = body?.dry_run == null ? true : body.dry_run === true;
  const limit = body?.limit;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const result = await runApPostingSweep(admin, { dry_run, limit });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
