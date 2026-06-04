// api/internal/drop-ship/:id  (h616)
//
// P20 / M49 — Drop-ship detail / lifecycle / tracking.
//
//   GET    /api/internal/drop-ship/:id          → order + lines + customer + vendor
//   PATCH  /api/internal/drop-ship/:id           → transition / edit
//        body { action?: 'confirm'|'ship'|'deliver'|'close'|'cancel'|'reopen',
//               carrier?, tracking_number?, ship_to?, expected_ship_date?, notes? }
//   DELETE /api/internal/drop-ship/:id           → delete (only requested/cancelled)
//
// confirm assigns DS-YYYY-NNNNN. Lifecycle:
//   requested → confirmed → shipped → delivered → closed   (cancel before close)

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

async function nextDsNumber(admin, entityId) {
  const year = new Date().getUTCFullYear();
  const prefix = `DS-${year}-`;
  const { data } = await admin.from("drop_ship_orders").select("ds_number")
    .eq("entity_id", entityId).like("ds_number", `${prefix}%`)
    .order("ds_number", { ascending: false }).limit(1);
  let n = 1;
  if (data && data[0] && data[0].ds_number) { const p = parseInt(String(data[0].ds_number).slice(prefix.length), 10); if (Number.isFinite(p)) n = p + 1; }
  return `${prefix}${String(n).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: ds, error } = await admin
    .from("drop_ship_orders")
    .select("*, customers(name, customer_code), vendors(name, code), drop_ship_lines(*)")
    .eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!ds) return res.status(404).json({ error: "Drop-ship order not found" });

  if (req.method === "GET") return res.status(200).json({ order: ds });

  if (req.method === "DELETE") {
    if (!["requested", "cancelled"].includes(ds.status)) return res.status(409).json({ error: `Cannot delete a '${ds.status}' drop-ship order` });
    const { error: dErr } = await admin.from("drop_ship_orders").delete().eq("id", id);
    if (dErr) return res.status(500).json({ error: dErr.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const patch = { updated_at: new Date().toISOString() };
    if (body.carrier !== undefined) patch.carrier = body.carrier || null;
    if (body.tracking_number !== undefined) patch.tracking_number = body.tracking_number || null;
    if (body.ship_to !== undefined && body.ship_to && typeof body.ship_to === "object") patch.ship_to = body.ship_to;
    if (body.expected_ship_date !== undefined) patch.expected_ship_date = body.expected_ship_date || null;
    if (body.notes !== undefined) patch.notes = body.notes;

    const action = body.action;
    if (action === "confirm") {
      if (ds.status !== "requested") return res.status(409).json({ error: `Can only confirm a 'requested' order (is '${ds.status}')` });
      patch.status = "confirmed"; patch.confirmed_at = new Date().toISOString();
      if (!ds.ds_number) patch.ds_number = await nextDsNumber(admin, ds.entity_id);
    } else if (action === "ship") {
      if (!["confirmed", "requested"].includes(ds.status)) return res.status(409).json({ error: `Can only ship a confirmed order (is '${ds.status}')` });
      patch.status = "shipped"; patch.shipped_at = new Date().toISOString();
      if (!ds.ds_number) patch.ds_number = await nextDsNumber(admin, ds.entity_id);
    } else if (action === "deliver") {
      if (ds.status !== "shipped") return res.status(409).json({ error: `Can only deliver a shipped order (is '${ds.status}')` });
      patch.status = "delivered"; patch.delivered_at = new Date().toISOString();
    } else if (action === "close") {
      if (!["shipped", "delivered"].includes(ds.status)) return res.status(409).json({ error: `Can only close a shipped/delivered order (is '${ds.status}')` });
      patch.status = "closed";
    } else if (action === "cancel") {
      if (["closed"].includes(ds.status)) return res.status(409).json({ error: "Cannot cancel a closed order" });
      patch.status = "cancelled";
    } else if (action === "reopen") {
      if (ds.status !== "cancelled") return res.status(409).json({ error: "Can only reopen a cancelled order" });
      patch.status = "requested";
    }

    const { error: uErr } = await admin.from("drop_ship_orders").update(patch).eq("id", id);
    if (uErr) return res.status(500).json({ error: uErr.message });
    return res.status(200).json({ ok: true, status: patch.status || ds.status, ds_number: patch.ds_number || ds.ds_number });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
