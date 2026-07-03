// api/internal/build-orders/[id]/cmt-invoice
//
// POST — enter the contractor's CMT vendor bill for a 'capitalize'-mode build and
//        3-way match it against the conversion PO + the finished-goods receipt.
//
// The CMT was already capitalized into WIP at receipt (mfg_cmt_accrued:
//   DR 1305 WIP / CR 2160 Accrued CMT). This bill CLEARS 2160 and books any
// difference vs. the accrued value to PO Variance (6320):
//   DR 2160 Accrued CMT   = accrued (received) value
//   DR/CR 6320 PO Variance = bill total − accrued value
//   CR AP                 = bill total (subledger vendor)
//
// Body: { total_cents (required — the vendor's actual bill),
//         vendor_id?, invoice_number?, invoice_date?, ap_account_id?, actor_user_id? }
//
// Guards: build must be 'capitalize' mode with a CMT accrual (cmt_accrued_cents
// > 0), and it is idempotent — a build whose CMT bill is already matched
// (cmt_invoice_je_id set) returns that match instead of billing twice.

import { postEvent } from "../../../_lib/accounting/posting/index.js";
import {
  UUID_RE, corsHeaders, client, resolveDefaultEntityId, resolveApAccount, accountByCode, todayISO,
} from "./_shared.js";

export const config = { maxDuration: 30 };

function centsToDecimal(c) {
  const n = BigInt(Math.trunc(Number(c))); const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? "-" : ""}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, "0")}`;
}

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

  const totalCents = typeof body.total_cents === "number" ? body.total_cents : parseInt(body.total_cents, 10);
  if (!Number.isInteger(totalCents) || totalCents < 0) return res.status(400).json({ error: "total_cents must be a non-negative integer (the vendor's bill total)" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntityId(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const { data: build } = await admin.from("mfg_build_orders").select("*").eq("id", id).maybeSingle();
  if (!build) return res.status(404).json({ error: "Build order not found" });

  // Idempotent: never bill twice.
  if (build.cmt_invoice_je_id) {
    return res.status(200).json({
      build_order_id: id, invoice_id: build.cmt_invoice_id, cmt_invoice_je_id: build.cmt_invoice_je_id,
      already_matched: true, message: "CMT vendor bill already matched for this build.",
    });
  }

  if (build.conversion_po_mode !== "capitalize") {
    return res.status(409).json({ error: "CMT 3-way match applies to 'capitalize'-mode conversion POs only. Procurement-mode CMT is billed via the normal AP flow." });
  }
  const receivedCents = Number(build.cmt_accrued_cents || 0);
  if (receivedCents <= 0) {
    return res.status(409).json({ error: "No CMT has been accrued for this build yet — receive the conversion PO's finished goods first." });
  }

  // Vendor: body → conversion PO vendor → BOM default conversion vendor.
  let vendorId = body.vendor_id && UUID_RE.test(String(body.vendor_id)) ? String(body.vendor_id) : null;
  if (!vendorId && build.conversion_po_id) {
    const { data: po } = await admin.from("purchase_orders").select("vendor_id").eq("id", build.conversion_po_id).maybeSingle();
    vendorId = po?.vendor_id || null;
  }
  if (!vendorId && build.bom_id) {
    const { data: bom } = await admin.from("mfg_bom").select("default_conversion_vendor_id").eq("id", build.bom_id).maybeSingle();
    vendorId = bom?.default_conversion_vendor_id || null;
  }
  if (!vendorId) return res.status(400).json({ error: "No conversion vendor — pass vendor_id." });

  // GL accounts: 2160 Accrued CMT (clears), 6320 PO Variance (variance), AP.
  const accruedCmt = await accountByCode(admin, entity.id, "2160");
  if (!accruedCmt) return res.status(400).json({ error: "Accrued CMT account (2160) not found — apply the 20260951000000 migration." });
  const variance = totalCents !== receivedCents ? await accountByCode(admin, entity.id, "6320") : null;
  if (totalCents !== receivedCents && !variance) return res.status(400).json({ error: "PO Variance account (6320) not found — required when the bill differs from the accrued CMT." });

  let apAccount = null;
  if (body.ap_account_id && UUID_RE.test(String(body.ap_account_id))) {
    const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("id", body.ap_account_id).maybeSingle();
    if (data && data.is_postable && data.status === "active") apAccount = data;
  }
  if (!apAccount) apAccount = await resolveApAccount(admin, entity);
  if (!apAccount) return res.status(400).json({ error: "AP account (2000) not found." });

  const postingDate = body.invoice_date ? String(body.invoice_date).slice(0, 10) : todayISO();
  const invoiceNumber = body.invoice_number ? String(body.invoice_number).trim() : `CMT-${build.build_number || String(id).slice(0, 8)}`;

  // 1. Vendor bill header (mirrors ap-invoices / part-purchases create).
  const { data: header, error: hErr } = await admin.from("invoices").insert({
    entity_id: entity.id, vendor_id: vendorId, invoice_number: invoiceNumber,
    invoice_kind: "vendor_bill", gl_status: "draft", posting_date: postingDate, due_date: postingDate,
    description: `Conversion CMT — build ${build.build_number || id}`, ap_account_id: apAccount.id, source: "manual",
  }).select().single();
  if (hErr) {
    if (hErr.code === "23505") return res.status(409).json({ error: "An invoice with that number already exists for this vendor." });
    return res.status(500).json({ error: hErr.message });
  }

  // 2. Post the 3-way match — DR 2160 / ±6320 / CR AP (both bases).
  let postResult;
  try {
    postResult = await postEvent(admin, {
      kind: "mfg_cmt_invoice_match",
      entity_id: entity.id,
      created_by_user_id: actorUserId,
      reason: `CMT vendor bill ${invoiceNumber} for build ${build.build_number || id}`,
      data: {
        invoice_id: header.id, vendor_id: vendorId, invoice_number: invoiceNumber, invoice_date: postingDate,
        ap_account_id: apAccount.id, accrued_cmt_account_id: accruedCmt.id,
        variance_account_id: variance ? variance.id : null,
        received_amount: centsToDecimal(receivedCents), total_amount: centsToDecimal(totalCents),
        build_number: build.build_number,
      },
    });
  } catch (err) {
    // Roll back the unposted shell so a failed post doesn't strand a bill.
    await admin.from("invoices").delete().eq("id", header.id);
    return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
  }

  const jeId = postResult.accrual_je_id || postResult.cash_je_id || null;
  await admin.from("invoices").update({ accrual_je_id: jeId, gl_status: "posted" }).eq("id", header.id);
  await admin.from("mfg_build_orders")
    .update({ cmt_invoice_id: header.id, cmt_invoice_je_id: jeId, updated_at: new Date().toISOString() }).eq("id", id);

  const varianceCents = totalCents - receivedCents;
  return res.status(201).json({
    build_order_id: id, invoice_id: header.id, invoice_number: invoiceNumber, gl_status: "posted",
    cmt_invoice_je_id: jeId, accrued_cents: receivedCents, total_cents: totalCents, variance_cents: varianceCents,
    message: `CMT bill ${invoiceNumber} matched — cleared $${(receivedCents / 100).toFixed(2)} Accrued CMT${varianceCents !== 0 ? `, ${varianceCents > 0 ? "+" : ""}$${(varianceCents / 100).toFixed(2)} to PO Variance` : ""}.`,
  });
}
