// api/internal/inventory-cycle-counts/:id/finalize
//
// POST — closes a cycle count by generating one inventory_adjustments row per
//        line with non-zero variance.
//
//        For each line where counted_qty IS NOT NULL AND variance_qty != 0:
//          - adjustment_type = variance > 0 ? 'found' : 'shrinkage'
//          - qty_delta = variance_qty (signed)
//          - unit_cost_cents: positive → operator-supplied OR fall back to
//            current avg cost from ip_item_avg_cost.avg_cost_dollars × 100
//            (rounded to integer cents). Negative → NULL (FIFO consumes).
//          - gl_account_id: from request body `gl_account_id` if supplied;
//            otherwise the first expense account with name ILIKE 'shrinkage%'
//            for this entity; otherwise the first expense account.
//          - reason: "Cycle count {short_id} variance"
//
//        Adjustments land as DRAFTS (posted_je_id NULL). The operator reviews
//        + posts them individually via the Adjustments panel (P3-5). This is
//        a deliberate safety choice — auto-posting from a cycle count would
//        bypass the GL approval gate.
//
//        Sets cycle_count.status='completed' and stamps each line's
//        adjustment_id back to its new draft.
//
//        Fires `inventory_variance_exceeds_threshold` notification (to
//        recipient_roles=['admin']) if any single line's |variance| > N% of
//        system_qty (default 10%, override via request `threshold_pct`).
//
//        Zero-variance lines are skipped entirely.
//        Lines with counted_qty IS NULL are skipped (variance unknown).
//
//        Body (all optional):
//          {
//            threshold_pct?: number   (default 10, percentage; e.g. 5 = 5%)
//            gl_account_id?: uuid     (override the shrinkage account fallback)
//            positive_unit_costs?: { [line_id]: cents }
//                                     // per-line cost override for positives;
//                                     // if absent, falls back to avg cost.
//          }
//
//        Returns: {
//          adjustments_created: N,
//          lines_with_variance: N,
//          lines_skipped_zero: N,
//          lines_skipped_not_counted: N,
//          threshold_breaches: [{line_id, variance_pct}, …]
//        }
//
// If the inventory_adjustments table does not exist (P3-5 not merged yet) the
// endpoint returns 503 with an explanatory error rather than crashing — the
// operator can then merge P3-5 and retry.
//
// Tangerine P3 Chunk 6.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 60 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Pure validator — exported for tests.
export function validateFinalizeBody(body) {
  const b = body || {};
  const out = {};

  if (b.threshold_pct != null && b.threshold_pct !== "") {
    const n = Number(b.threshold_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: "threshold_pct must be a number between 0 and 100" };
    }
    out.threshold_pct = n;
  } else {
    out.threshold_pct = 10; // default
  }

  if (b.gl_account_id != null && b.gl_account_id !== "") {
    if (!UUID_RE.test(String(b.gl_account_id))) {
      return { error: "gl_account_id must be a uuid" };
    }
    out.gl_account_id = String(b.gl_account_id);
  }

  if (b.positive_unit_costs != null) {
    if (typeof b.positive_unit_costs !== "object" || Array.isArray(b.positive_unit_costs)) {
      return { error: "positive_unit_costs must be an object" };
    }
    const map = {};
    for (const [lineId, cents] of Object.entries(b.positive_unit_costs)) {
      if (!UUID_RE.test(lineId)) {
        return { error: `positive_unit_costs key '${lineId}' is not a uuid` };
      }
      const c = Number(cents);
      if (!Number.isFinite(c) || c < 0 || !Number.isInteger(c)) {
        return { error: `positive_unit_costs.${lineId} must be a non-negative integer (cents)` };
      }
      map[lineId] = c;
    }
    out.positive_unit_costs = map;
  } else {
    out.positive_unit_costs = {};
  }

  return { data: out };
}

// Build the adjustment row insert payload for one line. Pure for tests.
//   line: { id, item_id, system_qty, counted_qty, variance_qty }
//   ctx:  { entity_id, gl_account_id, cycle_count_id, cycle_count_short,
//           unit_cost_cents_for_positive }  -- already resolved by caller
// Returns: { row, type } where type ∈ {'found','shrinkage'}.
// Throws Error if variance is zero or counted_qty null.
export function buildAdjustmentRow(line, ctx) {
  if (line.counted_qty == null) throw new Error("counted_qty must be set");
  const variance = Number(line.variance_qty);
  if (!Number.isFinite(variance) || variance === 0) throw new Error("variance must be non-zero");

  const type = variance > 0 ? "found" : "shrinkage";
  const row = {
    entity_id: ctx.entity_id,
    item_id: line.item_id,
    adjustment_type: type,
    qty_delta: variance,
    unit_cost_cents: variance > 0 ? ctx.unit_cost_cents_for_positive : null,
    reason: `Cycle count ${ctx.cycle_count_short} variance`,
    gl_account_id: ctx.gl_account_id,
  };
  return { row, type };
}

// Resolve unit cost cents for a positive variance. Pure for tests.
//   overrides: { [line_id]: cents }   (from request body)
//   avgCostDollarsByItem: Map<item_id, avg_cost_dollars>
//   line: { id, item_id }
// Returns integer cents or null (caller treats null as fatal for that line).
export function resolveUnitCostCents(line, overrides, avgCostDollarsByItem) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, line.id)) {
    return overrides[line.id];
  }
  const dollars = avgCostDollarsByItem.get(line.item_id);
  if (dollars == null) return null;
  const n = Number(dollars);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// Threshold check. Pure for tests.
//   line: { system_qty, variance_qty }
//   pct: number (e.g. 10 = 10%)
// Returns true if |variance| / max(1, system_qty) > pct/100.
// Use max(1, system_qty) so a 5-unit found on a 0-system isn't infinite.
export function exceedsThreshold(line, pct) {
  const sys = Number(line.system_qty);
  const v = Number(line.variance_qty);
  if (!Number.isFinite(v) || !Number.isFinite(sys)) return false;
  if (v === 0) return false;
  const ratio = Math.abs(v) / Math.max(1, sys);
  return ratio > (pct / 100);
}

async function tableExists(admin, tableName) {
  // PostgREST way: probe with a tiny select; existence check via head=true count.
  const { error } = await admin.from(tableName).select("id", { head: true, count: "exact" }).limit(1);
  if (error) {
    // 42P01 undefined_table — also some adapters surface a message
    if (error.code === "42P01" || /relation .* does not exist/.test(error.message || "")) {
      return false;
    }
    // Other errors — assume table exists; let downstream surface the issue
    return true;
  }
  return true;
}

async function resolveGlAccount(admin, entityId, override) {
  if (override) {
    const { data, error } = await admin
      .from("gl_accounts")
      .select("id, account_type")
      .eq("id", override)
      .eq("entity_id", entityId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`gl_account_id ${override} not found for this entity`);
    return data.id;
  }

  // Prefer expense account with name ILIKE 'shrinkage%'
  const { data: shr, error: sErr } = await admin
    .from("gl_accounts")
    .select("id")
    .eq("entity_id", entityId)
    .eq("account_type", "expense")
    .ilike("name", "shrinkage%")
    .limit(1);
  if (sErr) throw new Error(sErr.message);
  if (shr && shr.length > 0) return shr[0].id;

  // Fall back to ANY expense account
  const { data: anyExp, error: aErr } = await admin
    .from("gl_accounts")
    .select("id")
    .eq("entity_id", entityId)
    .eq("account_type", "expense")
    .limit(1);
  if (aErr) throw new Error(aErr.message);
  if (anyExp && anyExp.length > 0) return anyExp[0].id;

  throw new Error("No expense gl_account available to use as shrinkage counter-account. Create one in COA admin.");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cycleCountId = req.query?.id;
  if (!cycleCountId || !UUID_RE.test(cycleCountId)) {
    return res.status(400).json({ error: "Invalid cycle count id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // P3-5 (inventory_adjustments) dependency
  const adjExists = await tableExists(admin, "inventory_adjustments");
  if (!adjExists) {
    return res.status(503).json({
      error: "inventory_adjustments table missing. Merge P3-5 (Inventory Adjustments) before finalizing cycle counts.",
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateFinalizeBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Header
  const { data: header, error: hErr } = await admin
    .from("inventory_cycle_counts")
    .select("*")
    .eq("id", cycleCountId)
    .maybeSingle();
  if (hErr) return res.status(500).json({ error: hErr.message });
  if (!header) return res.status(404).json({ error: "Cycle count not found" });
  if (header.status !== "in_progress") {
    return res.status(409).json({
      error: `Cannot finalize: status is '${header.status}'. Only in_progress counts can be finalized.`,
    });
  }

  // Lines (paginate to avoid 1000-row cap on big counts)
  const PAGE = 1000;
  const lines = [];
  let fromIdx = 0;
  for (let page = 0; page < 200; page++) {
    const { data, error } = await admin
      .from("inventory_cycle_count_lines")
      .select("id, item_id, system_qty, counted_qty, variance_qty")
      .eq("cycle_count_id", cycleCountId)
      .range(fromIdx, fromIdx + PAGE - 1);
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) break;
    lines.push(...data);
    if (data.length < PAGE) break;
    fromIdx += PAGE;
  }

  let skippedNotCounted = 0;
  let skippedZero = 0;
  const varianceLines = [];
  for (const ln of lines) {
    if (ln.counted_qty == null) { skippedNotCounted++; continue; }
    const v2 = Number(ln.variance_qty);
    if (!Number.isFinite(v2) || v2 === 0) { skippedZero++; continue; }
    varianceLines.push(ln);
  }

  if (varianceLines.length === 0) {
    // No variance — just close the count.
    const { error: cErr } = await admin
      .from("inventory_cycle_counts")
      .update({ status: "completed" })
      .eq("id", cycleCountId);
    if (cErr) return res.status(500).json({ error: cErr.message });
    return res.status(200).json({
      adjustments_created: 0,
      lines_with_variance: 0,
      lines_skipped_zero: skippedZero,
      lines_skipped_not_counted: skippedNotCounted,
      threshold_breaches: [],
    });
  }

  // Resolve GL account
  let glAccountId;
  try {
    glAccountId = await resolveGlAccount(admin, header.entity_id, v.data.gl_account_id);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Look up avg cost per item for positive variance lines
  const positiveItemIds = Array.from(new Set(
    varianceLines.filter((l) => Number(l.variance_qty) > 0).map((l) => l.item_id)
  ));
  const avgCostByItem = new Map();
  if (positiveItemIds.length > 0) {
    // Paginate as well (avg cost table may have >1000 rows but our filter is narrow).
    const { data, error } = await admin
      .from("ip_item_avg_cost")
      .select("item_id, avg_cost_dollars")
      .in("item_id", positiveItemIds);
    if (error) {
      // ip_item_avg_cost may not exist in some deploys — degrade to no avg.
      if (!/relation .* does not exist/.test(error.message || "")) {
        return res.status(500).json({ error: error.message });
      }
    }
    for (const r of data || []) {
      avgCostByItem.set(r.item_id, r.avg_cost_dollars);
    }
  }

  const shortId = cycleCountId.slice(0, 8);

  // Build rows + check positive-variance cost availability
  const insertRows = [];
  const rowToLine = []; // parallel array: insertRows[i] ↔ varianceLines index
  const missingCostLineIds = [];

  for (let i = 0; i < varianceLines.length; i++) {
    const ln = varianceLines[i];
    let unitCostCents = null;
    if (Number(ln.variance_qty) > 0) {
      unitCostCents = resolveUnitCostCents(ln, v.data.positive_unit_costs, avgCostByItem);
      if (unitCostCents == null) {
        missingCostLineIds.push(ln.id);
        continue;
      }
    }
    const { row } = buildAdjustmentRow(ln, {
      entity_id: header.entity_id,
      gl_account_id: glAccountId,
      cycle_count_id: cycleCountId,
      cycle_count_short: shortId,
      unit_cost_cents_for_positive: unitCostCents,
    });
    insertRows.push(row);
    rowToLine.push(ln);
  }

  if (missingCostLineIds.length > 0) {
    return res.status(400).json({
      error: "Positive-variance lines require a unit_cost_cents. None found in ip_item_avg_cost and no override supplied.",
      missing_cost_line_ids: missingCostLineIds,
      hint: "Pass positive_unit_costs={[line_id]: cents, ...} in the request body, or seed ip_item_avg_cost for these items.",
    });
  }

  // Insert all adjustment rows
  const { data: inserted, error: insErr } = await admin
    .from("inventory_adjustments")
    .insert(insertRows)
    .select("id");
  if (insErr) return res.status(500).json({ error: `Failed to insert adjustments: ${insErr.message}` });

  // Link each line.adjustment_id to its new adjustment.id
  // Postgres doesn't have a multi-row update; loop or use a CASE expression.
  // For correctness + simplicity, loop (cycle counts won't typically be 10k+).
  for (let i = 0; i < inserted.length; i++) {
    const lineId = rowToLine[i].id;
    const adjId = inserted[i].id;
    const { error: upErr } = await admin
      .from("inventory_cycle_count_lines")
      .update({ adjustment_id: adjId })
      .eq("id", lineId);
    if (upErr) {
      // Log but don't fail — the link is recoverable; the adjustments are the
      // load-bearing artifact.
      console.error(`finalize: failed to set adjustment_id on line ${lineId}: ${upErr.message}`);
    }
  }

  // Mark cycle count completed
  const { error: doneErr } = await admin
    .from("inventory_cycle_counts")
    .update({ status: "completed" })
    .eq("id", cycleCountId);
  if (doneErr) return res.status(500).json({ error: `Adjustments created but failed to mark cycle count completed: ${doneErr.message}` });

  // Threshold breaches → notification
  const breaches = [];
  for (const ln of varianceLines) {
    if (exceedsThreshold(ln, v.data.threshold_pct)) {
      const sys = Number(ln.system_qty);
      const vqty = Number(ln.variance_qty);
      const pct = (Math.abs(vqty) / Math.max(1, sys)) * 100;
      breaches.push({ line_id: ln.id, item_id: ln.item_id, variance_pct: Math.round(pct * 100) / 100 });
    }
  }

  if (breaches.length > 0) {
    try {
      await enqueueNotification(admin, {
        entity_id: header.entity_id,
        kind: "inventory_variance_exceeds_threshold",
        severity: "warn",
        subject: `Cycle count ${shortId}: ${breaches.length} variance(s) exceed ${v.data.threshold_pct}%`,
        body: `Cycle count finalized with ${breaches.length} line(s) whose variance exceeded the ${v.data.threshold_pct}% threshold. Review the generated adjustment drafts before posting.`,
        context_table: "inventory_cycle_counts",
        context_id: cycleCountId,
        payload: { threshold_pct: v.data.threshold_pct, breaches },
        recipient_roles: ["admin"],
      });
    } catch (e) {
      // Non-fatal — finalize already succeeded.
      console.error(`finalize: notification enqueue failed: ${e.message}`);
    }
  }

  return res.status(200).json({
    adjustments_created: inserted.length,
    lines_with_variance: varianceLines.length,
    lines_skipped_zero: skippedZero,
    lines_skipped_not_counted: skippedNotCounted,
    threshold_breaches: breaches,
  });
}
