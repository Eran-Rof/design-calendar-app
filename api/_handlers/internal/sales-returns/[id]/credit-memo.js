// api/internal/sales-returns/:id/credit-memo  (h614)
//
// P19 / M23 — issue + post a customer credit memo for an RMA.
//
// Builds an `ar_invoices` credit memo (invoice_kind='customer_credit_memo')
// from the RMA's dispositioned lines and posts it through the existing
// `ar_credit_memo` rule. Restock lines (disposition='restock' + item) re-add
// FIFO + reverse COGS; scrap lines credit revenue/AR only. Revenue reversal
// routes to 4100 Sales Returns & Allowances. Idempotent (skips if already
// credited). The RMA flips to status='credited'.
//
//   POST /api/internal/sales-returns/:id/credit-memo   body { created_by_user_id? }

import { createClient } from "@supabase/supabase-js";
import { postEvent } from "../../../../_lib/accounting/posting/index.js";
import { buildCreditMemoLines, resolveReturnCosts } from "../../../../_lib/sales-returns/creditMemo.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function acctByCode(admin, entityId, code) {
  const { data } = await admin.from("gl_accounts").select("id").eq("entity_id", entityId).eq("code", code).maybeSingle();
  return data ? data.id : null;
}
async function nextCmNumber(admin, entityId) {
  const year = new Date().getUTCFullYear();
  const prefix = `CM-${year}-`;
  const { data } = await admin.from("ar_invoices").select("invoice_number")
    .eq("entity_id", entityId).eq("invoice_kind", "customer_credit_memo")
    .like("invoice_number", `${prefix}%`).order("invoice_number", { ascending: false }).limit(1);
  let n = 1;
  if (data && data[0]) { const p = parseInt(String(data[0].invoice_number).slice(prefix.length), 10); if (Number.isFinite(p)) n = p + 1; }
  return `${prefix}${String(n).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }
  const id = req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const created_by_user_id = (body && UUID_RE.test(String(body.created_by_user_id || ""))) ? String(body.created_by_user_id) : null;

  const { data: rma } = await admin.from("sales_returns").select("*, sales_return_lines(*)").eq("id", id).maybeSingle();
  if (!rma) return res.status(404).json({ error: "RMA not found" });
  if (rma.credit_memo_id || rma.status === "credited") return res.status(409).json({ error: "RMA already credited" });
  if (!["approved", "received"].includes(rma.status)) {
    return res.status(409).json({ error: `RMA must be approved/received before crediting (is '${rma.status}')` });
  }
  const rmaLines = rma.sales_return_lines || [];
  if (rmaLines.some((l) => l.disposition === "pending")) {
    return res.status(409).json({ error: "Set a disposition (restock or scrap) on every line before crediting." });
  }

  // Accounts: AR 1200, Returns 4100 (revenue reversal), COGS 5000, Inventory 1300.
  const entityId = rma.entity_id;
  const arId = await acctByCode(admin, entityId, "1200");
  const returnsId = await acctByCode(admin, entityId, "4100");
  const cogsId = await acctByCode(admin, entityId, "5000");
  const invId = await acctByCode(admin, entityId, "1300");
  if (!arId) return res.status(500).json({ error: "AR account (1200) not configured" });
  if (!returnsId) return res.status(500).json({ error: "Sales Returns account (4100) not configured" });

  const restockItemIds = rmaLines.filter((l) => l.disposition === "restock" && l.inventory_item_id).map((l) => l.inventory_item_id);
  const hasRestock = restockItemIds.length > 0;
  if (hasRestock && (!cogsId || !invId)) {
    return res.status(500).json({ error: "Restock lines present but COGS (5000) / Inventory (1300) account not configured" });
  }

  // Per-style returns routing (#6 follow-up): resolve each returned line's
  // Sales Returns account from its STYLE (style.returns_account_id) → customer
  // default → entity 4100. So returns post to the brand's returns account.
  const rmaItemIds = [...new Set(rmaLines.map((l) => l.inventory_item_id).filter(Boolean))];
  const returnsByItem = new Map();
  if (rmaItemIds.length) {
    const { data: items } = await admin.from("ip_item_master").select("id, style_code").in("id", rmaItemIds);
    const codeByItem = new Map((items || []).map((i) => [i.id, i.style_code]));
    const codes = [...new Set((items || []).map((i) => i.style_code).filter(Boolean))];
    const retByCode = new Map();
    if (codes.length) {
      const { data: styles } = await admin.from("style_master").select("style_code, returns_account_id").in("style_code", codes);
      for (const s of styles || []) retByCode.set(String(s.style_code).toLowerCase(), s.returns_account_id || null);
    }
    const { data: cust } = await admin.from("customers").select("default_returns_account_id").eq("id", rma.customer_id).maybeSingle();
    const custReturns = cust?.default_returns_account_id || null;
    for (const [itemId, code] of codeByItem) {
      const styleRet = code ? retByCode.get(String(code).toLowerCase()) : null;
      const resolved = styleRet || custReturns || returnsId;
      if (resolved) returnsByItem.set(itemId, resolved);
    }
  }

  let cmLines;
  try {
    const costByItem = hasRestock ? await resolveReturnCosts(admin, restockItemIds) : new Map();
    cmLines = buildCreditMemoLines({ rmaLines, returnsAccountId: returnsId, costByItem, returnsByItem });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }

  const today = new Date().toISOString().slice(0, 10);
  const cmNumber = await nextCmNumber(admin, entityId);

  // 1. Create the credit-memo header + lines (draft) so the JE has a source row.
  const { data: cm, error: cmErr } = await admin.from("ar_invoices").insert({
    entity_id: entityId, customer_id: rma.customer_id, invoice_number: cmNumber,
    invoice_kind: "customer_credit_memo", gl_status: "draft",
    invoice_date: today, posting_date: today,
    ar_account_id: arId, revenue_account_id: returnsId, cogs_account_id: cogsId, inventory_asset_account_id: invId,
    sales_order_id: rma.original_sales_order_id || null,
    reverses_invoice_id: rma.original_ar_invoice_id || null,
    description: `Customer return ${rma.rma_number || ""}`.trim(),
    source: "sales_return",
  }).select("id").single();
  if (cmErr) return res.status(500).json({ error: `Credit memo header failed: ${cmErr.message}` });

  const lineRows = cmLines.map((l) => ({
    ar_invoice_id: cm.id, line_number: l.line_index, description: l.description,
    revenue_account_id: l.revenue_account_id || returnsId, inventory_item_id: l.inventory_item_id || null,
    quantity: l.quantity != null ? l.quantity : null,
    unit_price_cents: l.unit_price_cents, line_total_cents: Number(l.line_total_cents),
    source: "sales_return",
  }));
  const { data: insertedLines, error: lErr } = await admin.from("ar_invoice_lines").insert(lineRows).select("id, line_number");
  if (lErr) { await admin.from("ar_invoices").delete().eq("id", cm.id); return res.status(500).json({ error: `Credit memo lines failed: ${lErr.message}` }); }

  // Map back the persisted line ids onto the event lines (for cogs write-back).
  const lineIdByNum = new Map((insertedLines || []).map((r) => [r.line_number, r.id]));
  const eventLines = cmLines.map((l) => ({ ...l, id: lineIdByNum.get(l.line_index) || l.id }));

  // 2. Post via the ar_credit_memo rule.
  let result;
  try {
    result = await postEvent(admin, {
      kind: "ar_credit_memo", entity_id: entityId, created_by_user_id,
      reason: `Post credit memo ${cmNumber}`,
      data: {
        credit_memo_id: cm.id, customer_id: rma.customer_id, credit_memo_number: cmNumber,
        posting_date: today, original_invoice_id: rma.original_ar_invoice_id || undefined,
        ar_account_id: arId, revenue_account_id: returnsId, cogs_account_id: cogsId, inventory_account_id: invId,
        lines: eventLines,
      },
    });
  } catch (e) {
    // Roll back the draft credit memo so a failed post doesn't strand it.
    await admin.from("ar_invoice_lines").delete().eq("ar_invoice_id", cm.id);
    await admin.from("ar_invoices").delete().eq("id", cm.id);
    return res.status(500).json({ error: `Posting failed: ${e instanceof Error ? e.message : String(e)}` });
  }

  // 3. Stamp the credit memo + RMA.
  await admin.from("ar_invoices").update({ gl_status: "posted", accrual_je_id: result.accrual_je_id || null }).eq("id", cm.id);
  await admin.from("sales_returns").update({
    credit_memo_id: cm.id, status: "credited", credited_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", id);

  return res.status(201).json({
    ok: true, credit_memo_id: cm.id, credit_memo_number: cmNumber,
    accrual_je_id: result.accrual_je_id || null,
    restocked_layers: (result.inventory_layer_ids || []).length,
    message: `Credit memo ${cmNumber} posted${hasRestock ? ` · ${restockItemIds.length} line(s) restocked` : ""}.`,
  });
}
