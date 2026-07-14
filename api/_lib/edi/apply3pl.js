// api/_lib/edi/apply3pl.js
//
// Inbound 3PL message application, called by the transport cron after a file is
// polled, de-duplicated and parsed. Apply policy (deliberately conservative for
// an UNATTENDED cron):
//
//   997 Functional Ack   → AUTO-RECONCILE. Safe: only edi_messages metadata
//                          changes (mark the matching outbound 940 accepted /
//                          rejected). No business data mutates.
//   944 Receipt Advice   → STAGE. The existing operator endpoint
//   945 Shipping Advice     (.../edi/tpl/:id/receipt-advice | inbound |
//   846 Inventory           inventory-advice) performs the business mutation
//                          under operator review. The cron only parses + records
//                          the message as 'staged' and, where free, links it to
//                          the tpl_shipment for context. Nothing is silently
//                          shipped, received, or re-stocked. NOTHING touches GL.
//
// Each function returns { ok, staged, status, summary?, error? }.

import { parse944, parse945, parse846 } from "./builder.js";
import { segmentsByTag, el } from "./parser.js";

/**
 * 997 — reconcile the acknowledgment against our outbound 940(s).
 * AK1*<functionalId>*<groupControlNumber>; AK9*<A|R|E|P|M>*...
 * We match the group control number to edi_messages.group_control_number (or,
 * as a fallback, interchange_id) on outbound rows and stamp ack_status.
 */
export async function reconcileAck(admin, { segments }) {
  const ak1 = segmentsByTag(segments, "AK1")[0];
  const ak9 = segmentsByTag(segments, "AK9")[0];
  if (!ak1 || !ak9) return { ok: false, staged: false, status: "error", error: "997 missing AK1/AK9" };
  const groupControl = el(ak1, 2);
  const code = (el(ak9, 1) || "").toUpperCase();
  const accepted = code === "A";
  const ackStatus = accepted ? "accepted" : "rejected";

  if (!groupControl) return { ok: false, staged: false, status: "error", error: "997 AK1 has no group control number" };

  // Prefer group_control_number, fall back to interchange_id (our wrapEnvelope
  // uses the same number for ISA/GS control).
  let matched = [];
  const byGroup = await admin
    .from("edi_messages")
    .select("id")
    .eq("direction", "outbound")
    .eq("group_control_number", groupControl);
  if (byGroup.data?.length) matched = byGroup.data;
  else {
    const byInterchange = await admin
      .from("edi_messages")
      .select("id")
      .eq("direction", "outbound")
      .eq("interchange_id", groupControl);
    matched = byInterchange.data || [];
  }

  if (matched.length === 0) {
    return { ok: true, staged: false, status: "processed", summary: `997 ${ackStatus} for group ${groupControl} — no matching outbound message found (logged).` };
  }
  const ids = matched.map((m) => m.id);
  await admin.from("edi_messages").update({
    ack_status: ackStatus,
    acked_at: new Date().toISOString(),
    status: accepted ? "acknowledged" : "failed",
    last_error: accepted ? null : `Partner rejected via 997 (AK9=${code})`,
    updated_at: new Date().toISOString(),
  }).in("id", ids);

  return { ok: true, staged: false, status: "processed", summary: `997 ${ackStatus}: reconciled ${ids.length} outbound message(s) for group ${groupControl}.` };
}

/**
 * 945 — parse + stage. Links to the tpl_shipment (by W06 shipment number) for
 * context WITHOUT advancing it — operators apply via the receipt/inbound panel.
 */
export async function stageShippingAdvice(admin, { segments, provider }) {
  const parsed = parse945(segments);
  let shipment_id = null;
  if (parsed.shipment_number) {
    const { data: sh } = await admin
      .from("tpl_shipments")
      .select("id")
      .eq("tpl_provider_id", provider.id)
      .eq("shipment_number", parsed.shipment_number)
      .maybeSingle();
    shipment_id = sh?.id || null;
  }
  return {
    ok: true, staged: true, status: "staged",
    parsed, tpl_shipment_id: shipment_id,
    summary: `945 staged for shipment ${parsed.shipment_number || "?"}${shipment_id ? "" : " (no matching 3PL shipment)"} — review to mark shipped.`,
  };
}

/** 944 — parse + stage the receipt advice for operator review. */
export async function stageReceiptAdvice(admin, { segments }) {
  const parsed = parse944(segments);
  return {
    ok: true, staged: true, status: "staged",
    parsed,
    summary: `944 staged for PO ${parsed.po_number || "?"} (${(parsed.lines || []).length} line(s)) — review & post in Receiving.`,
  };
}

/** 846 — parse + stage the inventory snapshot for operator review. */
export async function stageInventoryAdvice(admin, { segments }) {
  const parsed = parse846(segments);
  return {
    ok: true, staged: true, status: "staged",
    parsed,
    summary: `846 staged: ${(parsed.lines || []).length} inventory line(s) — review before reconciling.`,
  };
}

/**
 * Dispatch an inbound transaction to its apply/stage handler.
 * @returns {Promise<{ok, staged, status, parsed?, tpl_shipment_id?, summary?, error?}>}
 */
export async function applyInbound(admin, { transactionSet, segments, provider }) {
  switch (String(transactionSet)) {
    case "997": return reconcileAck(admin, { segments });
    case "945": return stageShippingAdvice(admin, { segments, provider });
    case "944": return stageReceiptAdvice(admin, { segments });
    case "846": return stageInventoryAdvice(admin, { segments });
    default:
      return { ok: false, staged: false, status: "error", error: `Unsupported inbound 3PL transaction set: ${transactionSet}` };
  }
}
