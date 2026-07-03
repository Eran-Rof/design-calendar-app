// api/internal/part-purchases
//
// GET  — recent part-purchase bills (invoices that carry a part line), newest
//        first. Each row: invoice #, vendor, part, qty, unit cost, total, date,
//        posted flag.
// POST — buy a part from a vendor: creates a vendor bill (invoices + a part
//        invoice_line_items line) and posts it, stocking the part into part
//        inventory at the purchase cost. Body:
//          { part_id (required), vendor_id (required), qty (required),
//            unit_cost_cents (required), invoice_number?, invoice_date?,
//            location_id?, ap_account_id?, actor_user_id? }
//        Posts DR 1360 Inventory-Parts (subledger=part) / CR AP (subledger=vendor)
//        + creates the part FIFO layer (source_kind='ap_invoice').
//
// Parts are kept separate from style inventory; this never touches the style
// FIFO engine. Mirrors the proven ap-invoices create+post flow.

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../_lib/accounting/posting/index.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveEntity(admin) {
  const { data } = await admin.from("entities").select("id, default_ap_account_id").eq("code", "ROF").maybeSingle();
  return data || null;
}
async function accountByCode(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return data && data.is_postable && data.status === "active" ? data : null;
}
function centsToDecimal(c) {
  const n = BigInt(Math.trunc(Number(c))); const neg = n < 0n; const a = neg ? -n : n;
  return `${neg ? "-" : ""}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, "0")}`;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const limit = 200;
    const { data: lines } = await admin
      .from("invoice_line_items").select("invoice_id, part_id, quantity, unit_cost_cents").not("part_id", "is", null).limit(limit);
    if (!lines || lines.length === 0) return res.status(200).json([]);
    const invIds = [...new Set(lines.map((l) => l.invoice_id))];
    const partIds = [...new Set(lines.map((l) => l.part_id))];
    const [{ data: invs }, { data: parts }] = await Promise.all([
      admin.from("invoices").select("id, invoice_number, vendor_id, posting_date, gl_status, total_amount_cents").in("id", invIds),
      admin.from("part_master").select("id, code, name").in("id", partIds),
    ]);
    const invBy = new Map((invs || []).map((i) => [i.id, i]));
    const partBy = new Map((parts || []).map((p) => [p.id, p]));
    const vendIds = [...new Set((invs || []).map((i) => i.vendor_id).filter(Boolean))];
    const { data: vends } = vendIds.length ? await admin.from("vendors").select("id, legal_name, code").in("id", vendIds) : { data: [] };
    const vendBy = new Map((vends || []).map((v) => [v.id, v]));
    const rows = lines.map((l) => {
      const inv = invBy.get(l.invoice_id); const p = partBy.get(l.part_id);
      return {
        invoice_id: l.invoice_id, invoice_number: inv?.invoice_number ?? null,
        vendor_name: inv?.vendor_id ? (vendBy.get(inv.vendor_id)?.legal_name || null) : null,
        part_code: p?.code ?? null, part_name: p?.name ?? null,
        qty: Number(l.quantity || 0), unit_cost_cents: Number(l.unit_cost_cents || 0),
        total_cents: Math.round(Number(l.quantity || 0) * Number(l.unit_cost_cents || 0)),
        posting_date: inv?.posting_date ?? null, gl_status: inv?.gl_status ?? null,
      };
    }).sort((a, b) => String(b.posting_date || "").localeCompare(String(a.posting_date || "")));
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};
    const v = validate(body);
    if (v.error) return res.status(400).json({ error: v.error });

    const partsAccount = await accountByCode(admin, entity.id, "1360");
    if (!partsAccount) return res.status(400).json({ error: "Inventory-Parts account (1360) not found. Apply the M2 GL migration." });

    let apAccountId = null;
    if (v.data.ap_account_id) {
      const { data } = await admin.from("gl_accounts").select("id, is_postable, status").eq("id", v.data.ap_account_id).maybeSingle();
      if (data && data.is_postable && data.status === "active") apAccountId = data.id;
    }
    if (!apAccountId) apAccountId = entity.default_ap_account_id || (await accountByCode(admin, entity.id, "2000"))?.id || (await accountByCode(admin, entity.id, "2010"))?.id || null;
    if (!apAccountId) return res.status(400).json({ error: "No AP control account (2000/2010) configured." });

    const postingDate = v.data.invoice_date || new Date().toISOString().slice(0, 10);
    const invoiceNumber = v.data.invoice_number || `PB-${Date.now().toString(36).toUpperCase()}`;

    // 1. Vendor bill header (mirrors ap-invoices create: gl_status 'draft').
    const { data: header, error: hErr } = await admin.from("invoices").insert({
      entity_id: entity.id, vendor_id: v.data.vendor_id, invoice_number: invoiceNumber,
      invoice_kind: "vendor_bill", gl_status: "draft", posting_date: postingDate, due_date: postingDate,
      description: `Part purchase`, ap_account_id: apAccountId, source: "manual",
    }).select().single();
    if (hErr) {
      if (hErr.code === "23505") return res.status(409).json({ error: "An invoice with that number already exists for this vendor." });
      return res.status(500).json({ error: hErr.message });
    }

    // 2. Part line (trigger recomputes total_amount_cents).
    const { error: lErr } = await admin.from("invoice_line_items").insert({
      invoice_id: header.id, line_number: 1, description: "Part purchase",
      expense_account_id: partsAccount.id, part_id: v.data.part_id,
      quantity: v.data.qty, unit_cost_cents: v.data.unit_cost_cents, tax_amount_cents: 0,
    });
    if (lErr) { await admin.from("invoices").delete().eq("id", header.id); return res.status(500).json({ error: `Line insert failed: ${lErr.message}` }); }

    // 3. Post the bill — DR 1360 (part) / CR AP (vendor) + part FIFO layer.
    let postResult;
    try {
      postResult = await postEvent(admin, {
        kind: "ap_invoice_received",
        entity_id: entity.id,
        created_by_user_id: v.data.actor_user_id,
        reason: `Part purchase bill ${invoiceNumber}`,
        data: {
          invoice_id: header.id, vendor_id: v.data.vendor_id, invoice_number: invoiceNumber,
          invoice_date: postingDate, ap_account_id: apAccountId,
          receiving_location_id: v.data.location_id,
          lines: [{
            amount: centsToDecimal(v.data.qty * v.data.unit_cost_cents),
            part_id: v.data.part_id, part_inventory_account_id: partsAccount.id,
            qty: v.data.qty, unit_cost_cents: v.data.unit_cost_cents,
            location_id: v.data.location_id, memo: "Part purchase",
          }],
        },
      });
    } catch (err) {
      // Roll back the unposted shell so a failed post doesn't strand a bill.
      await admin.from("invoice_line_items").delete().eq("invoice_id", header.id);
      await admin.from("invoices").delete().eq("id", header.id);
      return res.status(400).json({ error: err?.message || String(err), code: err?.code || "post_failed", details: err?.details || null });
    }

    const jeId = postResult.accrual_je_id || null;
    await admin.from("invoices").update({ accrual_je_id: jeId, gl_status: "posted" }).eq("id", header.id);

    return res.status(201).json({
      invoice_id: header.id, invoice_number: invoiceNumber, gl_status: "posted",
      accrual_je_id: jeId,
      part_inventory_layer_ids: postResult.part_inventory_layer_ids || null,
      part_inventory_layer_errors: postResult.part_inventory_layer_errors || null,
      message: `Part purchase posted — ${v.data.qty} unit(s) stocked at $${(v.data.unit_cost_cents / 100).toFixed(2)}/unit (bill ${invoiceNumber}).`,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function validate(body) {
  if (!body.part_id || !UUID_RE.test(String(body.part_id))) return { error: "part_id (uuid) is required" };
  if (!body.vendor_id || !UUID_RE.test(String(body.vendor_id))) return { error: "vendor_id (uuid) is required" };
  const qty = Number(body.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "qty must be > 0" };
  const unit = typeof body.unit_cost_cents === "number" ? body.unit_cost_cents : parseInt(body.unit_cost_cents, 10);
  if (!Number.isInteger(unit) || unit < 0) return { error: "unit_cost_cents must be a non-negative integer" };
  let location_id = null;
  if (body.location_id != null && body.location_id !== "") {
    if (!UUID_RE.test(String(body.location_id))) return { error: "location_id must be a uuid" };
    location_id = String(body.location_id);
  }
  let ap_account_id = null;
  if (body.ap_account_id != null && body.ap_account_id !== "") {
    if (!UUID_RE.test(String(body.ap_account_id))) return { error: "ap_account_id must be a uuid" };
    ap_account_id = String(body.ap_account_id);
  }
  const actor_user_id = body.actor_user_id && UUID_RE.test(String(body.actor_user_id)) ? String(body.actor_user_id) : null;
  return {
    data: {
      part_id: String(body.part_id), vendor_id: String(body.vendor_id), qty, unit_cost_cents: unit,
      invoice_number: body.invoice_number ? String(body.invoice_number).trim() : null,
      invoice_date: body.invoice_date ? String(body.invoice_date).slice(0, 10) : null,
      location_id, ap_account_id, actor_user_id,
    },
  };
}
