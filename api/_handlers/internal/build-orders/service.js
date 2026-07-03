// api/internal/build-orders/[id]/service
//
// POST — capitalize an outsourced conversion/labor SERVICE charge into the
//        build's WIP (mfg_service_capitalized). Body:
//          { component_id (a service component on this build),
//            charge_cents (required), vendor_id?, ap_account_id?, actor_user_id? }
//        Posts DR WIP / CR AP, marks the component capitalized, and adds the
//        charge to the build's accumulated WIP cost. Allowed while released or
//        issued (before complete).

import { postEvent } from "../../../_lib/accounting/posting/index.js";
import { UUID_RE, corsHeaders, client, resolveDefaultEntityId, resolveApAccount, todayISO } from "./_shared.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  corsHeaders(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  body = body || {};
  const actorUserId = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;

  if (!body.component_id || !UUID_RE.test(String(body.component_id))) return res.status(400).json({ error: "component_id (uuid) is required" });
  const chargeCents = typeof body.charge_cents === "number" ? body.charge_cents : parseInt(body.charge_cents, 10);
  if (!Number.isInteger(chargeCents) || chargeCents <= 0) return res.status(400).json({ error: "charge_cents must be a positive integer" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });
  if (!["released", "issued"].includes(build.status)) return res.status(409).json({ error: `Cannot capitalize a service while build is '${build.status}'.` });
  // Double-count guard: a 'capitalize'-mode build accrues its CMT into WIP from
  // the conversion PO at finished-goods receipt (mfg_cmt_accrued). Capitalizing a
  // service manually here too would book the conversion charge into WIP twice.
  if (build.conversion_po_mode === "capitalize") {
    return res.status(409).json({ error: "This build capitalizes CMT via its conversion PO at receipt — manual service capitalization is disabled for 'capitalize' mode." });
  }

  const { data: comp } = await admin.from("mfg_build_components").select("*").eq("id", body.component_id).eq("build_order_id", id).maybeSingle();
  if (!comp) return res.status(404).json({ error: "Service component not found on this build" });
  if (comp.component_kind !== "service") return res.status(400).json({ error: "component_id must reference a service component" });
  if (comp.service_capitalized) return res.status(409).json({ error: "This service charge is already capitalized" });

  // Vendor: body → component default → required.
  const vendorId = (body.vendor_id && UUID_RE.test(String(body.vendor_id)) ? String(body.vendor_id) : null) || comp.service_vendor_id;
  if (!vendorId) return res.status(400).json({ error: "vendor_id is required (no default vendor on the service component)" });

  // AP account: body → entity default → 2000.
  let apAccount = null;
  if (body.ap_account_id && UUID_RE.test(String(body.ap_account_id))) {
    const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("id", body.ap_account_id).maybeSingle();
    if (data && data.is_postable && data.status === "active") apAccount = data;
  }
  if (!apAccount) apAccount = await resolveApAccount(admin, entity);
  if (!apAccount) return res.status(400).json({ error: "AP account (2000) not found." });

  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "mfg_service_capitalized",
      entity_id: entity.id,
      created_by_user_id: actorUserId,
      reason: `Capitalize service on build ${build.build_number || id}`,
      data: {
        build_order_id: id,
        component_id: comp.id,
        posting_date: todayISO(),
        wip_account_id: build.wip_account_id,
        ap_account_id: apAccount.id,
        vendor_id: vendorId,
        charge_cents: chargeCents,
        build_number: build.build_number,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
  }

  await admin.from("mfg_build_components").update({
    actual_cost_cents: chargeCents, service_charge_cents: chargeCents, service_vendor_id: vendorId, service_capitalized: true,
  }).eq("id", comp.id);

  const newAccum = Number(build.accumulated_cost_cents || 0) + chargeCents;
  const { data: updated } = await admin.from("mfg_build_orders")
    .update({ accumulated_cost_cents: newAccum, updated_at: new Date().toISOString() }).eq("id", id).select().single();

  return res.status(200).json({ ...updated, capitalized_cents: chargeCents, accrual_je_id: postResult.accrual_je_id, cash_je_id: postResult.cash_je_id });
}
