// api/internal/inventory-adjustments/:id/post
//
// POST — promote a draft inventory_adjustments row through the posting
//        service:
//          1. Resolve the entity's default inventory asset account
//          2. Approval gate (kind='inventory_adjustment') via approvalsAPI
//          3. If approval required → stay draft, return {requires_approval}
//          4. Else → invoke postEvent('inventory_adjustment', ...)
//              - Positive qty_delta: creates inventory_layers row + posts JE
//              - Negative qty_delta: drains consumePlan → consume() →
//                rewrites JE amounts to cogs_cents → posts JE
//          5. Stamp posted_je_id + posted_at
//          6. Fire notification 'inventory_write_off_posted' for write_off
//             adjustment_type → recipient_roles ['admin','accountant']
//
// The actor_user_id is OPTIONAL on body. If supplied + present in
// entity_users, the approval gate uses it as the request owner. If absent,
// the gate still fires but the request has no owner — cancel/approve still
// work for admins, the owner-self-cancel path doesn't.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../_lib/accounting/posting/index.js";
import { resolveReceivingPartition } from "../../../_lib/brandContext.js";
import { requestIfRequired as approvalsRequestIfRequired } from "../../../_lib/approvals/index.js";
import { enqueue as notificationsEnqueue } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 30 };

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

/**
 * Look up the entity's inventory asset account to capitalize the adjustment to.
 *
 * The canonical inventory account is code '1300'. It may be either:
 *   (a) a single POSTABLE account, or
 *   (b) a NON-postable brand-rollup parent (brand_rollup=true) whose postable
 *       per-brand children are coded '1300-{BRAND}' (M50 convention). In that
 *       case we MUST post to the postable child for the adjustment's brand —
 *       posting to the non-postable parent would be rejected by the service.
 *
 * Heuristic (in order):
 *   1. code = '1300' AND is_postable=true                 → that account
 *   2. code = '1300' AND brand_rollup=true, brandId given → postable child
 *      (parent_account_id = 1300, brand_id = brandId)
 *   3. name ILIKE 'inventory%' AND is_postable=true, EXCLUDING brand-rollup
 *      children of 1300 (so we don't grab an arbitrary brand child) → first hit
 *
 * If none hit, returns null. The caller surfaces a 400 telling the operator to
 * set up the inventory account via the COA admin panel.
 */
export async function resolveInventoryAccount(admin, entityId, brandId = null) {
  // Resolve the canonical 1300 account (postable single OR rollup parent).
  const base = await admin
    .from("gl_accounts")
    .select("id, code, name, is_postable, status, brand_rollup")
    .eq("entity_id", entityId)
    .eq("code", "1300")
    .maybeSingle();

  if (base.data) {
    // (1) single postable 1300 → post directly.
    if (base.data.is_postable) return base.data;
    // (2) rollup parent → post to the brand child.
    if (base.data.brand_rollup && brandId) {
      const child = await admin
        .from("gl_accounts")
        .select("id, code, name, is_postable, status")
        .eq("entity_id", entityId)
        .eq("parent_account_id", base.data.id)
        .eq("brand_id", brandId)
        .eq("is_postable", true)
        .eq("status", "active")
        .maybeSingle();
      if (child.data) return child.data;
    }
  }

  // (3) Fallback: name ILIKE 'inventory%', postable, but NOT a brand child of
  // the 1300 rollup (those have a parent_account_id) — pick a real inventory
  // account such as 1310/1320 deterministically by code.
  const byName = await admin
    .from("gl_accounts")
    .select("id, code, name, is_postable, status")
    .eq("entity_id", entityId)
    .eq("is_postable", true)
    .is("parent_account_id", null)
    .ilike("name", "inventory%")
    .order("code", { ascending: true })
    .limit(1)
    .maybeSingle();
  return byName.data || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const actorUserId = body && typeof body.actor_user_id === "string" && UUID_RE.test(body.actor_user_id)
    ? body.actor_user_id
    : null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // 1. Fetch the adjustment row
  const { data: adj, error: fetchErr } = await admin
    .from("inventory_adjustments").select("*").eq("id", id).maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!adj) return res.status(404).json({ error: "Inventory adjustment not found" });
  if (adj.posted_je_id != null) {
    return res.status(409).json({ error: "Already posted", posted_je_id: adj.posted_je_id, posted_at: adj.posted_at });
  }

  // 2. Resolve the entity's inventory asset account
  const inventoryAccount = await resolveInventoryAccount(admin, adj.entity_id, adj.brand_id || null);
  if (!inventoryAccount) {
    return res.status(400).json({
      error: "No inventory asset account found for entity. Create a postable gl_accounts row with code='1300' or name ILIKE 'inventory%' first.",
    });
  }

  // 3. Approval gate. amount_cents estimate = |qty_delta × unit_cost_cents|
  //    for positives; for negatives we approximate using the absolute qty
  //    and zero (unknown until FIFO consume). Operators who want to gate
  //    negative-side adjustments by dollar value should expose an approval
  //    rule that matches on adjustment_type or qty_delta magnitude instead.
  let amountCentsEstimate = 0;
  if (adj.qty_delta > 0 && adj.unit_cost_cents != null) {
    amountCentsEstimate = Math.abs(Math.round(adj.qty_delta * Number(adj.unit_cost_cents)));
  }

  try {
    const approval = await approvalsRequestIfRequired(admin, {
      kind: "inventory_adjustment",
      entity_id: adj.entity_id,
      context_table: "inventory_adjustments",
      context_id: adj.id,
      amount_cents: amountCentsEstimate,
      currency: "USD",
      payload: {
        adjustment_type: adj.adjustment_type,
        qty_delta: adj.qty_delta,
        item_id: adj.item_id,
        reason: adj.reason,
      },
      created_by_user_id: actorUserId,
    });
    if (approval.required) {
      return res.status(202).json({
        requires_approval: true,
        request_id: approval.request_id,
        current_step: approval.current_step,
      });
    }
  } catch (err) {
    // Don't fail the post on approvalsAPI errors — surface as a warning + post
    // anyway. The CEO is the only operator at launch; the gate is opt-in and
    // a transient infra issue shouldn't block.
    // eslint-disable-next-line no-console
    console.error("[inventory-adjustments/post] approvalsRequestIfRequired error:", err);
  }

  // P15: a positive (found/correction-up) adjustment creates a FIFO layer — land
  // it in the brand pool chosen on the adjustment (brand + WS/EC). No-op for
  // negative adjustments (those consume) or when the brand has no pool.
  let receivingPartitionId = null;
  if (adj.qty_delta > 0 && adj.brand_id) {
    receivingPartitionId = await resolveReceivingPartition(
      admin, adj.brand_id, adj.receiving_channel === "EC" ? "EC" : "WS",
    );
  }

  // 4. Invoke postEvent
  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "inventory_adjustment",
      entity_id: adj.entity_id,
      created_by_user_id: actorUserId,
      reason: adj.reason || `Inventory adjustment ${adj.adjustment_type} ${adj.id}`,
      data: {
        adjustment_id: adj.id,
        item_id: adj.item_id,
        adjustment_type: adj.adjustment_type,
        qty_delta: adj.qty_delta,
        unit_cost_cents: adj.unit_cost_cents,
        inventory_account_id: inventoryAccount.id,
        gl_account_id: adj.gl_account_id,
        receiving_partition_id: receivingPartitionId,
        posting_date: new Date().toISOString().slice(0, 10), // today (operator override TBD)
        reason: adj.reason,
      },
    });
  } catch (err) {
    return res.status(400).json({
      error: err?.message || String(err),
      code: err?.code || "post_failed",
      details: err?.details || null,
    });
  }

  // 5. Stamp posted_je_id + posted_at. We prefer the accrual JE id; both are
  //    siblings and the JE detail panel can navigate either way.
  const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
  const postedAt = new Date().toISOString();
  const { data: posted, error: upErr } = await admin
    .from("inventory_adjustments")
    .update({ posted_je_id: jeId, posted_at: postedAt })
    .eq("id", id)
    .is("posted_je_id", null) // race guard
    .select()
    .single();
  if (upErr) {
    // JE posted but we couldn't stamp. Surface so operator can reconcile.
    return res.status(500).json({
      error: `JE posted (id=${jeId}) but failed to stamp adjustment row: ${upErr.message}`,
      accrual_je_id: postResult.accrual_je_id,
      cash_je_id: postResult.cash_je_id,
    });
  }

  // 6. Notification: write_off type fires inventory_write_off_posted to
  //    admin + accountant.
  if (adj.adjustment_type === "write_off") {
    try {
      await notificationsEnqueue(admin, {
        entity_id: adj.entity_id,
        kind: "inventory_write_off_posted",
        severity: "warn",
        subject: `Inventory write-off posted: ${adj.id.slice(0, 8)}`,
        body: `An inventory write-off was posted for item ${adj.item_id}. Qty ${adj.qty_delta}. Reason: ${adj.reason}`,
        context_table: "inventory_adjustments",
        context_id: adj.id,
        recipient_roles: ["admin", "accountant"],
        payload: {
          adjustment_id: adj.id,
          item_id: adj.item_id,
          qty_delta: adj.qty_delta,
          reason: adj.reason,
          accrual_je_id: postResult.accrual_je_id,
        },
        created_by_user_id: actorUserId,
      });
    } catch (err) {
      // Non-fatal — log + continue
      // eslint-disable-next-line no-console
      console.error("[inventory-adjustments/post] notificationsEnqueue error:", err);
    }
  }

  return res.status(200).json({
    ...posted,
    accrual_je_id: postResult.accrual_je_id,
    cash_je_id: postResult.cash_je_id,
    consume_results: postResult.consume_results || null,
    inventory_layer_ids: postResult.inventory_layer_ids || null,
    inventory_layer_errors: postResult.inventory_layer_errors || null,
  });
}
