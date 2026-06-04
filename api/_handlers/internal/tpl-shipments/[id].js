// api/internal/tpl-shipments/:id  (h619)
//
// P21 / M13 — 3PL shipment detail / lifecycle / tracking.
//
//   GET    /api/internal/tpl-shipments/:id           → shipment + provider + lines
//   PATCH  /api/internal/tpl-shipments/:id            → transition / edit
//        body { action?: 'send'|'receive'|'close'|'cancel'|'reopen',
//               carrier?, tracking_number?, reference?, ship_date?, expected_date?, notes? }
//   DELETE /api/internal/tpl-shipments/:id            → delete (draft/cancelled only)
//
// send assigns TPL-YYYY-NNNNN (status in_transit). Lifecycle:
//   draft → in_transit → received → closed   (cancel before received)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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
async function nextNumber(admin, entityId) {
  const year = new Date().getUTCFullYear();
  const prefix = `TPL-${year}-`;
  const { data } = await admin.from("tpl_shipments").select("shipment_number")
    .eq("entity_id", entityId).like("shipment_number", `${prefix}%`)
    .order("shipment_number", { ascending: false }).limit(1);
  let n = 1;
  if (data && data[0] && data[0].shipment_number) { const p = parseInt(String(data[0].shipment_number).slice(prefix.length), 10); if (Number.isFinite(p)) n = p + 1; }
  return `${prefix}${String(n).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: sh, error } = await admin
    .from("tpl_shipments")
    .select("*, tpl_providers(name, code), tpl_shipment_lines(*)")
    .eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!sh) return res.status(404).json({ error: "Shipment not found" });

  if (req.method === "GET") return res.status(200).json({ shipment: sh });

  if (req.method === "DELETE") {
    if (!["draft", "cancelled"].includes(sh.status)) return res.status(409).json({ error: `Cannot delete a '${sh.status}' shipment` });
    const { error: dErr } = await admin.from("tpl_shipments").delete().eq("id", id);
    if (dErr) return res.status(500).json({ error: dErr.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const patch = { updated_at: new Date().toISOString() };
    for (const f of ["carrier", "tracking_number", "reference", "ship_date", "expected_date", "notes"]) {
      if (body[f] !== undefined) patch[f] = body[f] || null;
    }

    const action = body.action;
    if (action === "send") {
      if (sh.status !== "draft") return res.status(409).json({ error: `Can only send a 'draft' shipment (is '${sh.status}')` });
      patch.status = "in_transit"; patch.confirmed_at = new Date().toISOString();
      if (!sh.ship_date) patch.ship_date = new Date().toISOString().slice(0, 10);
      if (!sh.shipment_number) patch.shipment_number = await nextNumber(admin, sh.entity_id);
    } else if (action === "receive") {
      if (!["in_transit", "draft"].includes(sh.status)) return res.status(409).json({ error: `Can only receive an in-transit shipment (is '${sh.status}')` });
      patch.status = "received"; patch.received_at = new Date().toISOString();
      if (!sh.shipment_number) patch.shipment_number = await nextNumber(admin, sh.entity_id);
    } else if (action === "close") {
      if (sh.status !== "received") return res.status(409).json({ error: `Can only close a received shipment (is '${sh.status}')` });
      patch.status = "closed";
    } else if (action === "cancel") {
      if (["received", "closed"].includes(sh.status)) return res.status(409).json({ error: `Cannot cancel a '${sh.status}' shipment` });
      patch.status = "cancelled";
    } else if (action === "reopen") {
      if (sh.status !== "cancelled") return res.status(409).json({ error: "Can only reopen a cancelled shipment" });
      patch.status = "draft";
    }

    const { error: uErr } = await admin.from("tpl_shipments").update(patch).eq("id", id);
    if (uErr) return res.status(500).json({ error: uErr.message });
    return res.status(200).json({ ok: true, status: patch.status || sh.status, shipment_number: patch.shipment_number || sh.shipment_number });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
