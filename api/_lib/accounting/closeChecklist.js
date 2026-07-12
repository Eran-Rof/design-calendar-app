// api/_lib/accounting/closeChecklist.js
//
// Month-End Close — shared checklist catalog + period helpers used by the
// /api/internal/month-end-close/* handlers.
//
// The AUTOMATED checks are computed server-side by the close_run_auto_checks
// SQL RPC (migration 20260972000000) — all money math happens in SQL so the
// PostgREST 1000-row cap never truncates a tie-out. Their semantics mirror
// api/_lib/accounting/tieouts.js (#1665): cumulative posted-ACCRUAL GL vs live
// subledger, tolerance one cent, AP 2000 waived 'pending_payments' while
// sum(paid_amount_cents)=0 across posted bills. This module only carries the
// catalog (keys, labels, ordering) and the upsert/seed plumbing.

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const AUTO_ITEMS = [
  { key: "gl_balanced",        label: "GL balanced — period debits equal credits",              sort: 10 },
  { key: "ar_subledger_tie",   label: "AR subledger ties to GL (1105 / 1107 / 1108)",           sort: 20 },
  { key: "ap_subledger_tie",   label: "AP subledger ties to GL (2000)",                          sort: 30 },
  { key: "bank_recon",         label: "Bank / CC accounts reconciled for the period",            sort: 40 },
  { key: "no_draft_jes",       label: "No draft / unposted journal entries in the period",       sort: 50 },
  { key: "uncategorized_8007", label: "No Uncategorized Expense (8007) activity",                sort: 60 },
  { key: "factor_recon",       label: "Factor AR snapshot ties to GL 1107 (Rosenthal)",          sort: 70 },
  { key: "revenue_posted",     label: "Revenue posted for the period",                           sort: 80 },
];

export const MANUAL_ITEMS = [
  { key: "bank_statements_reviewed",    label: "Bank statements reviewed",                 sort: 110 },
  { key: "factor_statement_reconciled", label: "Factor statement received & reconciled",   sort: 120 },
  { key: "chargebacks_reviewed",        label: "Chargebacks reviewed",                     sort: 130 },
  { key: "payroll_booked",              label: "Payroll booked",                           sort: 140 },
  { key: "depreciation_booked",         label: "Depreciation booked",                      sort: 150 },
  { key: "controller_signoff",          label: "Close sign-off (controller)",              sort: 160 },
];

const AUTO_BY_KEY = new Map(AUTO_ITEMS.map((i) => [i.key, i]));
export const MANUAL_KEYS = new Set(MANUAL_ITEMS.map((i) => i.key));

/** Resolve the default (ROF) entity id — same pattern as gl-periods/index.js. */
export async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/** "YYYY-MM" → the gl_periods row whose starts_on is the 1st of that month. */
export async function resolvePeriodForMonth(admin, entityId, month) {
  const startsOn = `${month}-01`;
  const { data, error } = await admin
    .from("gl_periods")
    .select("id, entity_id, fiscal_year, period_number, starts_on, ends_on, status")
    .eq("entity_id", entityId)
    .eq("starts_on", startsOn)
    .maybeSingle();
  if (error) throw new Error(`gl_periods read failed: ${error.message}`);
  return data || null;
}

/** Get (or create) the close_periods row for a gl_period. */
export async function ensureClosePeriod(admin, entityId, period) {
  const { data: existing, error: rErr } = await admin
    .from("close_periods")
    .select("*")
    .eq("entity_id", entityId)
    .eq("period_id", period.id)
    .maybeSingle();
  if (rErr) throw new Error(`close_periods read failed: ${rErr.message}`);
  if (existing) return existing;

  const { data: created, error: cErr } = await admin
    .from("close_periods")
    .insert({
      entity_id: entityId,
      period_id: period.id,
      period_month: period.starts_on,
      status: "open",
      source: "month_end_close",
    })
    .select("*")
    .single();
  if (cErr) {
    // Lost a concurrent-create race → re-read.
    const { data: again, error: aErr } = await admin
      .from("close_periods")
      .select("*")
      .eq("entity_id", entityId)
      .eq("period_id", period.id)
      .maybeSingle();
    if (aErr || !again) throw new Error(`close_periods create failed: ${cErr.message}`);
    return again;
  }
  return created;
}

/** Seed the manual checklist rows (idempotent — ignores existing keys). */
export async function seedManualItems(admin, entityId, closePeriodId) {
  const rows = MANUAL_ITEMS.map((i) => ({
    entity_id: entityId,
    close_period_id: closePeriodId,
    item_key: i.key,
    label: i.label,
    kind: "manual",
    status: "pending",
    sort_order: i.sort,
    source: "month_end_close",
  }));
  const { error } = await admin
    .from("close_checklist_items")
    .upsert(rows, { onConflict: "close_period_id,item_key", ignoreDuplicates: true });
  if (error) throw new Error(`manual item seed failed: ${error.message}`);
}

/**
 * Persist close_run_auto_checks() output: upsert one kind=auto row per check
 * with status + detail (numbers behind the verdict). Auto rows are never
 * signed off — re-running checks always overwrites status/detail.
 */
export async function upsertAutoItems(admin, entityId, closePeriodId, rpcResult) {
  const checks = Array.isArray(rpcResult?.checks) ? rpcResult.checks : [];
  const rows = checks.map((c) => {
    const cat = AUTO_BY_KEY.get(c.item_key);
    return {
      entity_id: entityId,
      close_period_id: closePeriodId,
      item_key: c.item_key,
      label: cat?.label || c.item_key,
      kind: "auto",
      status: c.status === "pass" ? "pass" : "fail",
      detail: { ...(c.detail || {}), ran_at: rpcResult?.ran_at || new Date().toISOString() },
      sort_order: cat?.sort ?? 90,
      source: "month_end_close",
    };
  });
  if (rows.length === 0) return 0;
  const { error } = await admin
    .from("close_checklist_items")
    .upsert(rows, { onConflict: "close_period_id,item_key" });
  if (error) throw new Error(`auto item upsert failed: ${error.message}`);
  return rows.length;
}

/** Read the full checklist for a close period, ordered by sort_order. */
export async function fetchChecklistItems(admin, closePeriodId) {
  const { data, error } = await admin
    .from("close_checklist_items")
    .select("id, item_key, label, kind, status, detail, signed_off_by, signed_off_at, note, sort_order, updated_at")
    .eq("close_period_id", closePeriodId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`checklist read failed: ${error.message}`);
  return data || [];
}

/**
 * Map signed_off_by auth uuids → a human label (email) so the panel never
 * shows raw UUIDs. Best-effort: unknown ids fall back to "operator".
 */
export async function resolveSignerLabels(admin, items) {
  const ids = [...new Set(items.map((i) => i.signed_off_by).filter(Boolean))];
  const labels = {};
  for (const id of ids) {
    try {
      const { data } = await admin.auth.admin.getUserById(id);
      labels[id] = data?.user?.email || "operator";
    } catch {
      labels[id] = "operator";
    }
  }
  return items.map((i) => ({
    ...i,
    signed_off_by_label: i.signed_off_by ? labels[i.signed_off_by] || "operator" : null,
  }));
}

/** True when every auto item passes and every manual item is signed off. */
export function checklistComplete(items) {
  const autos = items.filter((i) => i.kind === "auto");
  const manuals = items.filter((i) => i.kind === "manual");
  return (
    autos.length >= AUTO_ITEMS.length &&
    autos.every((i) => i.status === "pass") &&
    manuals.length >= MANUAL_ITEMS.length &&
    manuals.every((i) => i.status === "signed_off")
  );
}
