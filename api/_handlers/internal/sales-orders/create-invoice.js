// api/internal/sales-orders/:id/create-invoice
//
// P16 / M10-C — generate a DRAFT AR invoice from a sales order's open lines.
//
// Flow:
//   1. Load the SO + lines. Must be confirmed/allocated/fulfilling/shipped
//      (a draft has no SO number yet; invoiced/closed/cancelled are terminal).
//   2. Invoice each line's OPEN quantity (qty_ordered − qty_invoiced > 0).
//      M10-C invoices the full open balance, so this fully invoices the SO.
//   3. Insert ar_invoices (gl_status='draft', sales_order_id set) + lines
//      (sales_order_line_id set). The header total is maintained by the
//      existing ar_invoice_lines → ar_invoices total trigger.
//   4. Stamp SO: lines qty_invoiced = qty_ordered + status='invoiced',
//      header status='invoiced'.
//   5. Return { invoice_id, invoice_number } so the panel can deep-link.
//
// The operator then POSTs the draft via the existing /ar-invoices/:id/post
// flow (approval + credit + FIFO COGS). M10-C only originates the draft.

import { createClient } from "@supabase/supabase-js";
import { resolveRevenueRouting, isPrivateLabelStyle, channelFromChannelMasterCode } from "../../../_lib/accounting/revenueRouting.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICEABLE = new Set(["confirmed", "allocated", "fulfilling", "shipped"]);

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

async function nextInvoiceNumber(admin, entityId, year) {
  const prefix = `AR-${year}-`;
  const { count } = await admin
    .from("ar_invoices")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("invoice_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const created_by_user_id =
    (body?.created_by_user_id && UUID_RE.test(String(body.created_by_user_id)))
      ? String(body.created_by_user_id)
      : null;

  // 1. Load SO + lines.
  const { data: so, error: soErr } = await admin
    .from("sales_orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });
  if (!INVOICEABLE.has(so.status)) {
    return res.status(409).json({
      error: so.status === "draft"
        ? "Confirm the sales order before invoicing (a draft has no SO number)."
        : `Cannot invoice a ${so.status} sales order.`,
    });
  }

  const { data: soLines, error: lErr } = await admin
    .from("sales_order_lines")
    .select("*")
    .eq("sales_order_id", id)
    .order("line_number", { ascending: true });
  if (lErr) return res.status(500).json({ error: lErr.message });

  const openLines = (soLines || [])
    .map((l) => ({ ...l, open_qty: Number(l.qty_ordered) - Number(l.qty_invoiced) }))
    .filter((l) => l.open_qty > 0 && l.status !== "cancelled");
  if (openLines.length === 0) {
    return res.status(400).json({ error: "Nothing left to invoice on this sales order." });
  }

  // 2. Resolve entity defaults for the GL account fallback chain.
  const { data: entity } = await admin
    .from("entities")
    .select("id, default_ar_account_id, default_revenue_account_id, default_cogs_account_id, default_inventory_account_id")
    .eq("id", so.entity_id)
    .maybeSingle();

  // AR account: SO override → the CUSTOMER's class default (factored 1107 /
  // credit-card 1105 / house 1108 — stamped on customers 2026-07-07) → entity.
  // Resolved after invCust loads below; placeholder chain kept for clarity.
  let ar_account_id = so.ar_account_id || entity?.default_ar_account_id || null;
  const revenue_account_id = so.revenue_account_id || entity?.default_revenue_account_id || null;
  const cogs_account_id = entity?.default_cogs_account_id || null;
  const inventory_asset_account_id = entity?.default_inventory_account_id || null;

  // Per-style GL routing (#6): resolve each line's revenue + COGS account from
  // its STYLE (brand bucket), falling back to the customer default, then the
  // entity default. The style account flows onto the invoice line, so posting
  // (arInvoiceSent) books revenue + COGS per line to the brand's accounts.
  const lineItemIds = [...new Set(openLines.map((l) => l.inventory_item_id).filter(Boolean))];
  const styleAcctByItem = new Map(); // inventory_item_id -> { rev, cogs }
  const routedByItem = new Map();    // inventory_item_id -> { revId, cogsId } from the COA routing spec
  if (lineItemIds.length) {
    const { data: items } = await admin.from("ip_item_master").select("id, style_code").in("id", lineItemIds);
    const codeByItem = new Map((items || []).map((i) => [i.id, i.style_code]));
    const codes = [...new Set((items || []).map((i) => i.style_code).filter(Boolean))];
    const styleByCode = new Map();
    if (codes.length) {
      const { data: styles } = await admin.from("style_master")
        .select("style_code, revenue_account_id, cogs_account_id, gender_code, brand_id").in("style_code", codes);
      for (const s of styles || []) styleByCode.set(String(s.style_code).toLowerCase(), s);
    }
    // Revenue→GL Phase 3: route each line via the shared COA spec resolver
    // (brand × gender × channel × PL). An EXPLICIT style_master account still
    // wins (deliberate operator override); the resolver replaces the generic
    // customer/entity fallbacks so revenue lands in 4005-4012 (+ COGS twins)
    // instead of one catch-all. Sample detection for native is TBD (no signal
    // defined yet) — sample SOs currently route like normal sales.
    const brandIds = [...new Set([...styleByCode.values()].map((s) => s.brand_id).filter(Boolean))];
    const brandCodeById = new Map();
    if (brandIds.length) {
      const { data: brands } = await admin.from("brand_master").select("id, code").in("id", brandIds);
      for (const b of brands || []) brandCodeById.set(b.id, b.code);
    }
    let channelCode = null;
    if (so.channel_id) {
      const { data: ch } = await admin.from("channel_master").select("code").eq("id", so.channel_id).maybeSingle();
      channelCode = ch?.code || null;
    }
    const neededCodes = new Set();
    const routedCodesByItem = new Map();
    for (const [itemId, code] of codeByItem) {
      const s = code ? styleByCode.get(String(code).toLowerCase()) : null;
      if (s) styleAcctByItem.set(itemId, { rev: s.revenue_account_id || null, cogs: s.cogs_account_id || null });
      const brandCode = s ? brandCodeById.get(s.brand_id) || null : null;
      const routing = resolveRevenueRouting({
        brandCode,
        genderCode: s?.gender_code || null,
        channel: channelFromChannelMasterCode(channelCode, brandCode),
        isPrivateLabel: isPrivateLabelStyle(code),
      });
      routedCodesByItem.set(itemId, routing);
      neededCodes.add(routing.revenueCode);
      if (routing.cogsCode) neededCodes.add(routing.cogsCode);
    }
    if (neededCodes.size) {
      const { data: accts } = await admin.from("gl_accounts")
        .select("id, code").eq("entity_id", so.entity_id).in("code", [...neededCodes]);
      const acctIdByCode = new Map((accts || []).map((a) => [a.code, a.id]));
      for (const [itemId, routing] of routedCodesByItem) {
        routedByItem.set(itemId, {
          revId: acctIdByCode.get(routing.revenueCode) || null,
          cogsId: routing.cogsCode ? acctIdByCode.get(routing.cogsCode) || null : null,
        });
      }
    }
  }
  // Customer-level GL defaults for the fallback chain (style → routed → customer → entity).
  const { data: invCust } = await admin.from("customers")
    .select("default_revenue_account_id, default_cogs_account_id, default_ar_account_id").eq("id", so.customer_id).maybeSingle();
  const custRevenueId = invCust?.default_revenue_account_id || null;
  const custCogsId = invCust?.default_cogs_account_id || null;
  if (!so.ar_account_id && invCust?.default_ar_account_id) ar_account_id = invCust.default_ar_account_id;

  const today = new Date().toISOString().slice(0, 10);
  const invoice_number = await nextInvoiceNumber(admin, so.entity_id, today.slice(0, 4));

  // 3. Insert invoice header (draft).
  const { data: invoice, error: hErr } = await admin
    .from("ar_invoices")
    .insert({
      entity_id: so.entity_id,
      customer_id: so.customer_id,
      ship_to_location_id: so.ship_to_location_id || null,
      brand_id: so.brand_id || null,
      channel_id: so.channel_id || null,
      sales_order_id: so.id,
      invoice_number,
      invoice_kind: "customer_invoice",
      gl_status: "draft",
      invoice_date: today,
      posting_date: today,
      due_date: today,
      payment_terms_id: so.payment_terms_id || null,
      ar_account_id,
      revenue_account_id,
      cogs_account_id,
      inventory_asset_account_id,
      description: `From sales order ${so.so_number || so.id.slice(0, 8)}`,
      created_by_user_id,
    })
    .select()
    .single();
  if (hErr) {
    if (hErr.code === "23505") return res.status(409).json({ error: "Invoice number collision — retry." });
    return res.status(500).json({ error: hErr.message });
  }

  // 3b. Insert invoice lines from the SO's open quantities.
  const lineRows = openLines.map((l, idx) => {
    const sa = l.inventory_item_id ? styleAcctByItem.get(l.inventory_item_id) : null;
    const rt = l.inventory_item_id ? routedByItem.get(l.inventory_item_id) : null;
    return {
      ar_invoice_id: invoice.id,
      sales_order_line_id: l.id,
      line_number: idx + 1,
      description: l.description || null,
      // Precedence: explicit style override → COA routing spec (brand×gender×
      // channel×PL via revenueRouting.js) → SO-line/customer → entity.
      revenue_account_id: (sa && sa.rev) || (rt && rt.revId) || l.revenue_account_id || custRevenueId || revenue_account_id,
      cogs_account_id: (sa && sa.cogs) || (rt && rt.cogsId) || custCogsId || cogs_account_id,
      inventory_item_id: l.inventory_item_id || null,
      quantity: l.open_qty,
      unit_price_cents: l.unit_price_cents,
      line_total_cents: Math.round(l.open_qty * Number(l.unit_price_cents)),
      tax_amount_cents: 0,
    };
  });
  const { error: ilErr } = await admin.from("ar_invoice_lines").insert(lineRows);
  if (ilErr) {
    await admin.from("ar_invoices").delete().eq("id", invoice.id); // avoid orphan total=0 header
    return res.status(500).json({ error: `Header saved but lines failed: ${ilErr.message}` });
  }

  // 4. Stamp the SO + its lines as fully invoiced.
  for (const l of openLines) {
    await admin.from("sales_order_lines")
      .update({ qty_invoiced: Number(l.qty_ordered), status: "invoiced", updated_at: new Date().toISOString() })
      .eq("id", l.id);
  }
  await admin.from("sales_orders")
    .update({ status: "invoiced", updated_at: new Date().toISOString() })
    .eq("id", so.id);

  // 5. Re-read for the maintained total.
  const { data: fresh } = await admin
    .from("ar_invoices")
    .select("id, invoice_number, total_amount_cents, gl_status")
    .eq("id", invoice.id)
    .maybeSingle();

  return res.status(201).json({
    invoice_id: invoice.id,
    invoice_number,
    total_amount_cents: fresh?.total_amount_cents ?? null,
    gl_status: "draft",
    message: `Draft AR invoice ${invoice_number} created from ${so.so_number || "the sales order"}. Post it from AR Invoices to book the GL.`,
  });
}
