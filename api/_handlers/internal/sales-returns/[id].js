// api/internal/sales-returns/:id  (h613)
//
// P19 / M23 — RMA detail / lifecycle / line dispositions.
//
//   GET    /api/internal/sales-returns/:id            → RMA + lines + customer
//   PATCH  /api/internal/sales-returns/:id            → transition / edit
//        body { action?: 'approve'|'receive'|'cancel'|'reopen',
//               restocking_fee_cents?, notes?, reason?,
//               line_dispositions?: [ { id, disposition, restock_location_id? } ] }
//   DELETE /api/internal/sales-returns/:id            → delete (only while requested/cancelled)
//
// approve assigns RMA-YYYY-NNNNN. Credit memo issuance is a separate endpoint
// (./credit-memo). Dispositions can be set any time before crediting.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

async function nextRmaNumber(admin, entityId) {
  const year = new Date().getUTCFullYear();
  const prefix = `RMA-${year}-`;
  const { data } = await admin
    .from("sales_returns")
    .select("rma_number")
    .eq("entity_id", entityId)
    .like("rma_number", `${prefix}%`)
    .order("rma_number", { ascending: false })
    .limit(1);
  let next = 1;
  if (data && data[0] && data[0].rma_number) {
    const n = parseInt(String(data[0].rma_number).slice(prefix.length), 10);
    if (Number.isFinite(n)) next = n + 1;
  }
  return `${prefix}${String(next).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: rma, error: rErr } = await admin
    .from("sales_returns")
    .select("*, customers(name, customer_code), sales_return_lines(*)")
    .eq("id", id)
    .maybeSingle();
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (!rma) return res.status(404).json({ error: "RMA not found" });

  if (req.method === "GET") return res.status(200).json({ rma });

  if (req.method === "DELETE") {
    if (!["requested", "cancelled"].includes(rma.status)) {
      return res.status(409).json({ error: `Cannot delete an RMA in status '${rma.status}'` });
    }
    const { error } = await admin.from("sales_returns").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    // Line dispositions (allowed any time before credited/closed).
    if (Array.isArray(body.line_dispositions) && body.line_dispositions.length) {
      if (["credited", "closed", "cancelled"].includes(rma.status)) {
        return res.status(409).json({ error: `Cannot change dispositions on a '${rma.status}' RMA` });
      }
      for (const d of body.line_dispositions) {
        if (!d.id || !["pending", "restock", "scrap"].includes(d.disposition)) continue;
        await admin.from("sales_return_lines").update({
          disposition: d.disposition,
          restock_location_id: d.disposition === "restock" ? (d.restock_location_id || null) : null,
          updated_at: new Date().toISOString(),
        }).eq("id", d.id).eq("sales_return_id", id);
      }
    }

    const patch = { updated_at: new Date().toISOString() };
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.reason !== undefined) patch.reason = body.reason;
    if (body.restocking_fee_cents !== undefined) patch.restocking_fee_cents = Math.max(0, Math.round(Number(body.restocking_fee_cents) || 0));

    const action = body.action;
    if (action === "approve") {
      if (rma.status !== "requested") return res.status(409).json({ error: `Can only approve a 'requested' RMA (is '${rma.status}')` });
      patch.status = "approved";
      patch.approved_at = new Date().toISOString();
      if (!rma.rma_number) patch.rma_number = await nextRmaNumber(admin, rma.entity_id);
    } else if (action === "receive") {
      if (!["approved", "requested"].includes(rma.status)) return res.status(409).json({ error: `Can only receive an approved RMA (is '${rma.status}')` });
      patch.status = "received";
      patch.received_at = new Date().toISOString();
      if (!rma.rma_number) patch.rma_number = await nextRmaNumber(admin, rma.entity_id);
    } else if (action === "cancel") {
      if (["credited", "closed"].includes(rma.status)) return res.status(409).json({ error: `Cannot cancel a '${rma.status}' RMA` });
      patch.status = "cancelled";
    } else if (action === "reopen") {
      if (rma.status !== "cancelled") return res.status(409).json({ error: "Can only reopen a cancelled RMA" });
      patch.status = "requested";
    }

    const { error } = await admin.from("sales_returns").update(patch).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, status: patch.status || rma.status, rma_number: patch.rma_number || rma.rma_number });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
