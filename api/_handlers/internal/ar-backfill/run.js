// api/internal/ar-backfill/run
//
// Tangerine P4-8 — AR historical backfill runner.
//
// POST. Body: {
//   start_date?: 'YYYY-MM-DD'  (default '2024-08-01'),
//   end_date?:   'YYYY-MM-DD'  (default today),
//   dry_run?:    boolean       (default true — safety),
// }
//
// Walks ip_sales_history_wholesale month-by-month, groups source lines by
// (invoice_number, txn_date, customer_id), and inserts:
//   - one ar_invoices row per group with gl_status='posted_historical',
//     invoice_kind='customer_invoice_historical', journal_type='ar_invoice_historical'
//   - one ar_invoice_lines row per source line
//   - one journal_entries row (DR ar / CR revenue per line + COGS pair if
//     unit_cost_at_sale is non-null) via gl_post_journal_entry — the trigger
//     bypass_period_lock branch fires for *_historical journal_type
//
// FIFO is NOT touched (per arch §6.4). Historical COGS uses unit_cost_at_sale
// directly. Inventory layers and inventory_consumption are skipped.
//
// Receipt-side backfill is left for a future chunk per operator's decision —
// historical invoices land with paid_amount_cents=0 and operator marks-paid
// via the UI as needed.
//
// Idempotency: re-run is safe. ON CONFLICT on ar_invoices(entity_id,
// invoice_number) skips duplicates; checkpoint_log records progress.
// Failures within a month savepoint do NOT halt the run — the month is
// logged status='failed' and the loop continues.

import { createClient } from "@supabase/supabase-js";
import { resolveRevenueRouting, resolveArAccountCode, isPrivateLabelStyle, channelFromIpChannelName } from "../../../_lib/accounting/revenueRouting.js";

export const config = { maxDuration: 300 };

// Every account code the routed historical JEs can touch (AR classes, revenue
// buckets, COGS twins). Resolved once per run; codes missing from the chart
// fall back to the entity defaults per line.
const ROUTED_CODES = [
  "1105", "1107", "1108",
  "4005", "4006", "4007", "4008", "4009", "4010", "4011", "4012",
  "5010", "5011", "5012", "5013", "5014", "5015", "5018",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORICAL_FLOOR = "2024-08-01";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateBody(body) {
  const out = {
    start_date: HISTORICAL_FLOOR,
    end_date: new Date().toISOString().slice(0, 10),
    dry_run: true,
  };
  if (body && typeof body === "object") {
    if (body.start_date != null) {
      if (!isISODate(body.start_date)) return { error: "start_date must be YYYY-MM-DD" };
      if (body.start_date < HISTORICAL_FLOOR) {
        return { error: `start_date cannot be earlier than ${HISTORICAL_FLOOR} (per Xoro initial-use cutoff)` };
      }
      out.start_date = body.start_date;
    }
    if (body.end_date != null) {
      if (!isISODate(body.end_date)) return { error: "end_date must be YYYY-MM-DD" };
      out.end_date = body.end_date;
    }
    if (body.dry_run != null) {
      if (typeof body.dry_run !== "boolean") return { error: "dry_run must be a boolean" };
      out.dry_run = body.dry_run;
    }
  }
  if (out.start_date > out.end_date) {
    return { error: "start_date must be <= end_date" };
  }
  return { data: out };
}

/**
 * Yield { year, month, monthStart, monthEnd } for every month overlapping
 * [start_date, end_date] inclusive.
 */
export function* iterMonths(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const year = cur.getUTCFullYear();
    const month = cur.getUTCMonth() + 1;
    const next = new Date(Date.UTC(year, month, 1));
    yield {
      year,
      month,
      monthStart: cur.toISOString().slice(0, 10),
      monthEnd: next.toISOString().slice(0, 10),
    };
    cur = next;
  }
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity, error: eErr } = await admin
    .from("entities").select("id, code").eq("code", "ROF").maybeSingle();
  if (eErr || !entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  // Resolve default accounts upfront — every historical invoice uses them.
  const accountIds = await resolveDefaultAccountIds(admin, entity.id);
  if (accountIds.error) return res.status(400).json({ error: accountIds.error });

  const runId = cryptoRandomUuid();
  const summary = {
    // Bumped when runner behavior changes — external drivers poll this to
    // detect that a fix has actually deployed before starting a real run.
    runner_version: 3,
    backfill_run_id: runId,
    entity_id: entity.id,
    start_date: v.data.start_date,
    end_date: v.data.end_date,
    dry_run: v.data.dry_run,
    months_processed: 0,
    months_failed: 0,
    invoices_created: 0,
    je_created: 0,
    unmatched_customers: 0,
    skipped_cogs: 0,
    months: [],
  };

  // Exclusive upper bound for the requested window (end_date is inclusive).
  const endExclusive = new Date(new Date(v.data.end_date + "T00:00:00Z").getTime() + 86400000)
    .toISOString().slice(0, 10);

  for (const { year, month, monthStart, monthEnd } of iterMonths(v.data.start_date, v.data.end_date)) {
    // Clip each month to the requested window — otherwise a one-week request
    // reprocesses (and re-conflicts) the entire month, which is what pushed
    // weekly driver calls past the 300s gateway limit.
    const winStart = monthStart > v.data.start_date ? monthStart : v.data.start_date;
    const winEnd = monthEnd < endExclusive ? monthEnd : endExclusive;
    const monthSummary = {
      year, month,
      invoices_created: 0,
      je_created: 0,
      status: "in_progress",
      error: null,
    };
    summary.months.push(monthSummary);

    try {
      const result = await processMonth(admin, {
        runId,
        entity_id: entity.id,
        monthStart: winStart, monthEnd: winEnd,
        accountIds: accountIds.data,
        dry_run: v.data.dry_run,
      });
      monthSummary.invoices_created = result.invoices_created;
      monthSummary.je_created = result.je_created;
      monthSummary.status = v.data.dry_run ? "dry_run" : "done";
      summary.invoices_created += result.invoices_created;
      summary.je_created += result.je_created;
      summary.unmatched_customers += result.unmatched_customers;
      summary.skipped_cogs += result.skipped_cogs;
      summary.months_processed += 1;
    } catch (e) {
      monthSummary.status = "failed";
      monthSummary.error = e instanceof Error ? e.message : String(e);
      summary.months_failed += 1;
    }

    // Persist checkpoint regardless of mode (dry-run rows have status='dry_run')
    await admin.from("bf_backfill_checkpoint_log").insert({
      backfill_run_id: runId,
      entity_id: entity.id,
      year, month,
      invoices_created: monthSummary.invoices_created,
      je_created: monthSummary.je_created,
      status: monthSummary.status,
      error: monthSummary.error,
      finished_at: new Date().toISOString(),
    });
  }

  return res.status(200).json(summary);
}

// ─── Per-month worker ────────────────────────────────────────────────────────

async function processMonth(admin, ctx) {
  const { runId, entity_id, monthStart, monthEnd, accountIds, dry_run } = ctx;

  // Pull all source rows for the window. PostgREST silently caps un-ranged
  // reads at 1000 rows and busy months run 2–4k lines, so page explicitly;
  // order by id for a stable walk across pages.
  const PAGE = 1000;
  const srcRows = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: srcErr } = await admin
      .from("ip_sales_history_wholesale")
      .select("id, sku_id, customer_id, channel_id, invoice_number, txn_date, qty, unit_price, net_amount, gross_amount, unit_cost_at_sale, source_line_key")
      .gte("txn_date", monthStart)
      .lt("txn_date", monthEnd)
      .not("invoice_number", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (srcErr) throw new Error(`ip_sales_history_wholesale read failed: ${srcErr.message}`);
    srcRows.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }

  // Routing dims for the month (Revenue→GL COA spec): sku → style (gender,
  // PL suffix) → brand code; channel_id → ip_channel_master code.
  const dims = await loadRoutingDims(admin, srcRows || []);

  // Group by invoice_number.
  const groups = new Map();
  for (const r of srcRows || []) {
    const k = `${r.invoice_number}|${r.txn_date}|${r.customer_id || "null"}`;
    if (!groups.has(k)) {
      groups.set(k, {
        invoice_number: r.invoice_number,
        txn_date: r.txn_date,
        legacy_customer_id: r.customer_id,
        lines: [],
      });
    }
    groups.get(k).lines.push(r);
  }

  let invoices_created = 0;
  let je_created = 0;
  let unmatched_customers = 0;
  let skipped_cogs = 0;

  for (const grp of groups.values()) {
    // Customer resolution: try to match ip_customer_master.id → customers row
    // via customer_code or name. If unmatched, synthesize a placeholder.
    const resolved = await resolveCustomer(admin, {
      runId, entity_id,
      legacy_customer_id: grp.legacy_customer_id,
      invoice_number: grp.invoice_number,
      dry_run,
    });
    if (resolved.synthesized) unmatched_customers += 1;
    const customer_id = resolved.customer_id;
    if (!customer_id) continue;  // resolution failed cleanly; logged.

    // AR class per customer (factored 1107 / CC 1105 / house 1108).
    const arAcctId = await resolveArClassAccount(admin, dims, accountIds, customer_id);

    // Build totals
    let total_cents = 0n;
    const invoiceLines = [];
    for (const ln of grp.lines) {
      const lineCents = lineTotalCents(ln);
      if (lineCents <= 0n) continue;
      total_cents += lineCents;
      invoiceLines.push({ src: ln, line_total_cents: lineCents });
    }
    if (total_cents <= 0n) continue;

    if (dry_run) {
      invoices_created += 1;
      je_created += 1;
      continue;
    }

    // Insert ar_invoices header.
    const { data: invRow, error: invErr } = await admin
      .from("ar_invoices")
      .insert({
        entity_id,
        customer_id,
        invoice_number: grp.invoice_number,
        invoice_kind: "customer_invoice_historical",
        gl_status: "posted_historical",
        posting_date: grp.txn_date,
        invoice_date: grp.txn_date,
        total_amount_cents: Number(total_cents),
        paid_amount_cents: 0,
        ar_account_id: arAcctId,
        revenue_account_id: accountIds.revenue,
        cogs_account_id: accountIds.cogs,
        inventory_asset_account_id: accountIds.inventory,
        metadata: { backfill_run_id: runId, source: "ip_sales_history_wholesale" },
      })
      .select("id")
      .maybeSingle();

    if (invErr) {
      // 23505 = unique violation = already backfilled this invoice_number.
      if (invErr.code === "23505") continue;
      throw new Error(`ar_invoices insert failed (${grp.invoice_number}): ${invErr.message}`);
    }
    if (!invRow) continue;

    // Insert lines + build JE candidate lines.
    const jeLines = [{
      line_number: 1,
      account_id: arAcctId,
      debit: cents(total_cents),
      credit: "0",
      memo: `Historical AR ${grp.invoice_number}`,
      subledger_type: "customer",
      subledger_id: customer_id,
    }];
    let jeLineN = 2;

    for (let i = 0; i < invoiceLines.length; i++) {
      const { src, line_total_cents } = invoiceLines[i];
      const quantity = Number(src.qty || 0);
      const unitCostCents = src.unit_cost_at_sale != null
        ? Math.round(Number(src.unit_cost_at_sale) * 100)
        : null;
      const cogsCents = unitCostCents != null && quantity > 0
        ? Math.round(unitCostCents * quantity)
        : null;

      // ar_invoice_lines_compute_total_trg OVERWRITES line_total_cents with
      // quantity × unit_price_cents whenever BOTH are non-null — so a
      // discounted line (net < gross) inserted with its list unit price gets
      // silently re-totaled to GROSS while the JE posts NET (found 2026-07-10
      // by the Sep-Dec 2024 load's header tie-out; discounted lines in the
      // 2025 load carry the same latent defect). Only send unit_price_cents
      // when it exactly reproduces the net line total; otherwise store the
      // net total alone.
      const unitPriceCents = src.unit_price != null ? Math.round(Number(src.unit_price) * 100) : null;
      const priceReproducesTotal = unitPriceCents != null && quantity > 0
        && Math.round(unitPriceCents * quantity) === Number(line_total_cents);
      const { error: lnErr } = await admin
        .from("ar_invoice_lines")
        .insert({
          ar_invoice_id: invRow.id,
          line_number: i + 1,
          description: `Historical line ${grp.invoice_number}-${i + 1}`,
          inventory_item_id: src.sku_id,
          quantity,
          unit_price_cents: priceReproducesTotal ? unitPriceCents : null,
          line_total_cents: Number(line_total_cents),
          cogs_cents: cogsCents,
          cogs_resolved_at: cogsCents != null ? new Date().toISOString() : null,
        });
      if (lnErr) {
        throw new Error(`ar_invoice_lines insert failed: ${lnErr.message}`);
      }

      // Route the line per the COA spec (brand × gender × store-channel × PL).
      const d = src.sku_id ? dims.skuDims.get(src.sku_id) : null;
      const routing = resolveRevenueRouting({
        brandCode: d?.brandCode,
        genderCode: d?.genderCode,
        channel: channelFromIpChannelName(dims.channelCodeById.get(src.channel_id)),
        isPrivateLabel: d ? isPrivateLabelStyle(d.styleCode) : false,
      });
      const revAcct = accountIds.byCode.get(routing.revenueCode) || accountIds.revenue;
      const cogsAcct = routing.cogsCode ? (accountIds.byCode.get(routing.cogsCode) || accountIds.cogs) : null;

      // CR revenue line
      jeLines.push({
        line_number: jeLineN++,
        account_id: revAcct,
        debit: "0",
        credit: cents(line_total_cents),
        memo: `Revenue ${grp.invoice_number} L${i + 1}`,
        subledger_type: null,
        subledger_id: null,
      });

      // COGS pair iff we have a cost (and the routing emits COGS — samples don't)
      if (cogsCents != null && cogsCents > 0 && cogsAcct) {
        jeLines.push({
          line_number: jeLineN++,
          account_id: cogsAcct,
          debit: cents(BigInt(cogsCents)),
          credit: "0",
          memo: `COGS ${grp.invoice_number} L${i + 1}`,
          subledger_type: "item",
          subledger_id: src.sku_id,
        });
        jeLines.push({
          line_number: jeLineN++,
          account_id: accountIds.inventory,
          debit: "0",
          credit: cents(BigInt(cogsCents)),
          memo: `Inv ${grp.invoice_number} L${i + 1}`,
          subledger_type: "item",
          subledger_id: src.sku_id,
        });
      } else {
        // Log the skipped-cogs line
        skipped_cogs += 1;
        await admin.from("bf_skipped_cogs_log").insert({
          backfill_run_id: runId,
          entity_id,
          invoice_number: grp.invoice_number,
          source_line_key: src.source_line_key,
          sku_id: src.sku_id,
          reason: unitCostCents == null ? "unit_cost_at_sale_null" : "zero_qty",
        });
      }
    }

    // Post the JE via the existing RPC. The trigger bypasses period-lock for
    // journal_type='ar_invoice_historical' (per P4-1).
    const { data: jeId, error: postErr } = await admin.rpc("gl_post_journal_entry", {
      payload: {
        entity_id,
        basis: "ACCRUAL",
        journal_type: "ar_invoice_historical",
        posting_date: grp.txn_date,
        source_module: "ar",
        source_table: "ar_invoices",
        source_id: invRow.id,
        description: `Historical AR backfill ${grp.invoice_number}`,
        audit_reason: `AR historical backfill from Xoro sales history (P4-8, routed by COA spec) — invoice ${grp.invoice_number}`,
        lines: jeLines,
      },
    });
    if (postErr) {
      // Roll back the ar_invoices header so the next run re-tries cleanly.
      await admin.from("ar_invoices").delete().eq("id", invRow.id);
      throw new Error(`gl_post_journal_entry failed (${grp.invoice_number}): ${postErr.message}`);
    }

    // Stamp accrual_je_id back.
    await admin.from("ar_invoices").update({ accrual_je_id: jeId }).eq("id", invRow.id);

    invoices_created += 1;
    je_created += 1;
  }

  return { invoices_created, je_created, unmatched_customers, skipped_cogs };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Routing dims for a month's source rows: sku → {brandCode, genderCode,
// styleCode} (via ip_item_master → style_master → brand_master) + channel
// id → ip_channel_master.channel_code. Chunked .in() reads.
async function loadRoutingDims(admin, srcRows) {
  const CHUNK = 200;
  const skuDims = new Map();
  const channelCodeById = new Map();
  const custClassById = new Map(); // filled lazily by resolveArClassAccount

  {
    const { data } = await admin.from("ip_channel_master").select("id, channel_code");
    for (const ch of data || []) channelCodeById.set(ch.id, ch.channel_code);
  }

  const skuIds = [...new Set(srcRows.map((r) => r.sku_id).filter(Boolean))];
  const skuToStyle = new Map();
  const styleIds = new Set();
  for (let i = 0; i < skuIds.length; i += CHUNK) {
    const { data } = await admin.from("ip_item_master").select("id, style_id").in("id", skuIds.slice(i, i + CHUNK));
    for (const r of data || []) { if (r.style_id) { skuToStyle.set(r.id, r.style_id); styleIds.add(r.style_id); } }
  }
  const styleById = new Map();
  const brandIds = new Set();
  const styleArr = [...styleIds];
  for (let i = 0; i < styleArr.length; i += CHUNK) {
    const { data } = await admin.from("style_master").select("id, style_code, gender_code, brand_id").in("id", styleArr.slice(i, i + CHUNK));
    for (const r of data || []) { styleById.set(r.id, r); if (r.brand_id) brandIds.add(r.brand_id); }
  }
  const brandCodeById = new Map();
  if (brandIds.size) {
    const { data } = await admin.from("brand_master").select("id, code").in("id", [...brandIds]);
    for (const r of data || []) brandCodeById.set(r.id, r.code);
  }
  for (const [skuId, styleId] of skuToStyle) {
    const st = styleById.get(styleId);
    if (!st) continue;
    skuDims.set(skuId, {
      brandCode: brandCodeById.get(st.brand_id) || null,
      genderCode: st.gender_code || null,
      styleCode: st.style_code || null,
    });
  }
  return { skuDims, channelCodeById, custClassById };
}

// AR account for a customer's class (factored 1107 / CC 1105 / house 1108),
// cached per run. Falls back to the entity default AR.
async function resolveArClassAccount(admin, dims, accountIds, customerId) {
  if (dims.custClassById.has(customerId)) return dims.custClassById.get(customerId);
  const { data } = await admin.from("customers")
    .select("is_factored, payment_processor").eq("id", customerId).maybeSingle();
  const code = resolveArAccountCode(data || {});
  const acct = accountIds.byCode.get(code) || accountIds.ar;
  dims.custClassById.set(customerId, acct);
  return acct;
}

async function resolveDefaultAccountIds(admin, entityId) {
  const { data: e } = await admin.from("entities")
    .select("default_ar_account_id, default_revenue_account_id, default_cogs_account_id, default_inventory_account_id")
    .eq("id", entityId).maybeSingle();

  async function byCode(code) {
    const { data } = await admin.from("gl_accounts")
      .select("id").eq("entity_id", entityId).eq("code", code).maybeSingle();
    return data?.id || null;
  }

  // Fallback codes realigned to the 2026-07-07 COA restructure (1200/4000/
  // 5000/1300 are non-postable headers now).
  const ar  = e?.default_ar_account_id        || await byCode("1108");
  const rev = e?.default_revenue_account_id   || await byCode("4005");
  const cog = e?.default_cogs_account_id      || await byCode("5010");
  const inv = e?.default_inventory_account_id || await byCode("1201");

  if (!ar)  return { error: "AR account not configured (set default_ar_account_id or seed gl_accounts.code='1108')." };
  if (!rev) return { error: "Revenue account not configured." };
  if (!cog) return { error: "COGS account not configured." };
  if (!inv) return { error: "Inventory account not configured." };

  // Routed code → id map for the COA-spec per-line routing.
  const { data: routedRows } = await admin.from("gl_accounts")
    .select("id, code").eq("entity_id", entityId).in("code", ROUTED_CODES);
  const byCodeMap = new Map((routedRows || []).map((r) => [r.code, r.id]));

  return { data: { ar, revenue: rev, cogs: cog, inventory: inv, byCode: byCodeMap } };
}

async function resolveCustomer(admin, ctx) {
  const { runId, entity_id, legacy_customer_id, invoice_number, dry_run } = ctx;

  if (!legacy_customer_id) {
    // Drop straight to synth path.
    return await synthesizeCustomer(admin, { runId, entity_id, code: null, name: null, invoice_number, dry_run });
  }

  // Try ip_customer_master → customers join via code.
  const { data: legacy } = await admin
    .from("ip_customer_master")
    .select("id, customer_code, name")
    .eq("id", legacy_customer_id)
    .maybeSingle();
  if (!legacy) {
    return await synthesizeCustomer(admin, { runId, entity_id, code: null, name: null, invoice_number, dry_run });
  }

  // Match by customer_code.
  if (legacy.customer_code) {
    const { data: byCode } = await admin
      .from("customers")
      .select("id")
      .eq("entity_id", entity_id)
      .eq("customer_code", legacy.customer_code)
      .is("deleted_at", null)
      .maybeSingle();
    if (byCode) return { customer_id: byCode.id, synthesized: false };
  }
  // Match by name (case-insensitive exact).
  if (legacy.name) {
    const { data: byName } = await admin
      .from("customers")
      .select("id")
      .eq("entity_id", entity_id)
      .ilike("name", legacy.name.trim())
      .is("deleted_at", null)
      .maybeSingle();
    if (byName) return { customer_id: byName.id, synthesized: false };
  }

  return await synthesizeCustomer(admin, {
    runId, entity_id,
    code: legacy.customer_code || null,
    name: legacy.name || null,
    legacy_customer_id,
    invoice_number,
    dry_run,
  });
}

async function synthesizeCustomer(admin, ctx) {
  const { runId, entity_id, code, name, legacy_customer_id, invoice_number, dry_run } = ctx;
  // dry-run: log + return null (no inserts).
  if (dry_run) {
    await admin.from("bf_unmatched_customers_log").insert({
      backfill_run_id: runId,
      entity_id,
      source_customer_id: legacy_customer_id || null,
      source_customer_code: code,
      source_customer_name: name,
      invoice_number,
      resolution: "manual_review",
      notes: "dry-run — would synthesize",
    });
    return { customer_id: null, synthesized: true };
  }

  const synthCode = code ? `HIST_${code}`.slice(0, 60) : `HIST_NONAME_${randomShort()}`;
  const synthName = name || `Historical Backfill (${synthCode})`;

  const { data: existing } = await admin.from("customers")
    .select("id").eq("entity_id", entity_id).eq("code", synthCode).maybeSingle();
  if (existing) {
    return { customer_id: existing.id, synthesized: true };
  }

  // customers.customer_code is NOT NULL (Xoro ref column) — seed it with the
  // synth code so historical placeholders satisfy the constraint. No metadata
  // column on customers; provenance goes in attributes (jsonb).
  const { data: created, error: cErr } = await admin.from("customers").insert({
    entity_id,
    code: synthCode,
    customer_code: synthCode,
    name: synthName,
    customer_type: "wholesale",
    status: "active",
    attributes: { historical_backfill: true, backfill_run_id: runId, legacy_customer_id: legacy_customer_id || null },
  }).select("id").maybeSingle();
  if (cErr || !created) {
    await admin.from("bf_unmatched_customers_log").insert({
      backfill_run_id: runId,
      entity_id,
      source_customer_id: legacy_customer_id || null,
      source_customer_code: code,
      source_customer_name: name,
      invoice_number,
      resolution: "skipped",
      notes: cErr?.message || "customer insert returned no row",
    });
    return { customer_id: null, synthesized: false };
  }

  await admin.from("bf_unmatched_customers_log").insert({
    backfill_run_id: runId,
    entity_id,
    source_customer_id: legacy_customer_id || null,
    source_customer_code: code,
    source_customer_name: name,
    invoice_number,
    resolution: "synthesized",
    resolved_customer_id: created.id,
  });
  return { customer_id: created.id, synthesized: true };
}

export function lineTotalCents(src) {
  if (src.net_amount != null) return BigInt(Math.round(Number(src.net_amount) * 100));
  if (src.gross_amount != null) return BigInt(Math.round(Number(src.gross_amount) * 100));
  if (src.unit_price != null && src.qty != null) {
    return BigInt(Math.round(Number(src.unit_price) * Number(src.qty) * 100));
  }
  return 0n;
}

function cents(bi) {
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}

function cryptoRandomUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${r()}-${r().slice(0, 4)}-4${r().slice(1, 4)}-a${r().slice(1, 4)}-${r()}${r().slice(0, 4)}`;
}

function randomShort() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
