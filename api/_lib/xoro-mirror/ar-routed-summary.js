// api/_lib/xoro-mirror/ar-routed-summary.js — Phase 2 of revenue→GL.
//
// Replaces the AR mirror's single-lump daily JE (DR one AR account / CR one
// revenue account) with a ROUTED daily JE:
//   • DR side: one line per (AR account × customer) — factored 1107 /
//     credit-card 1105 / house 1108 via resolveArAccountCode — each carrying
//     subledger_type='customer'. Required: those accounts are CONTROL accounts
//     (2026-07-07 restructure) and the JE guard rejects control lines without
//     a subledger.
//   • CR side: one line per revenue bucket from resolveRevenueRouting —
//     4005 catch-all / 4006 Kids / 4008-4009 PT / 4011 ROF ecom / 4012 PL /
//     4007 consignment — routed per LINE by (style brand, gender, PL suffix,
//     channel). Channel comes from the day's ip_sales_history rows for the
//     same invoice numbers (Xoro STORE = channel; codes ROF / ROF ECOM / PT /
//     PT ECOM).
//
// Bridge COGS stays PERIODIC (the AP purchases JE + inventory-Δ JE) — routed
// per-sale COGS begins with native AR posting at cutover; posting it here too
// would double-count.
//
// Grain/soundness: DR total and CR total both derive from the SAME mirrored
// ar_invoices set (source='xoro_mirror', invoice_date = mirror day), so the JE
// always balances and never claims an invoice a native/manual row owns. Any
// per-invoice remainder (header total ≠ Σ lines, or a line with no SKU) routes
// to the channel-level bucket so nothing is dropped.

import { resolveRevenueRouting, resolveArAccountCode, isPrivateLabelStyle, channelFromIpChannelName } from "../accounting/revenueRouting.js";

const PAGE = 1000;
const IN_CHUNK = 200;

// ── Pure core (unit-tested without any IO) ──────────────────────────────────
//
// invoices:        [{ id, invoice_number, customer_id, total_amount_cents }]
// linesByInvoice:  Map(invoice_id → [{ inventory_item_id, line_total_cents }])
// channelByInvoice:Map(invoice_number → channel_code)   e.g. 'ROF ECOM'
// skuDims:         Map(sku_id → { brandCode, genderCode, styleCode })
// customers:       Map(customer_id → { is_factored, payment_processor })
//
// Returns { total_cents, dr: [{account_code, customer_id, cents}],
//           cr: [{account_code, cents}] } with Σdr === Σcr === total_cents.
export function bucketMirrorDay({ invoices, linesByInvoice, channelByInvoice, skuDims, customers }) {
  const dr = new Map(); // `${code}|${customer_id}` → cents
  const cr = new Map(); // code → cents
  let total = 0;

  for (const inv of invoices || []) {
    const invTotal = Number(inv.total_amount_cents || 0);
    if (!invTotal) continue;
    total += invTotal;

    // DR: AR account by customer class, subledger = the customer.
    const cust = customers.get(inv.customer_id) || {};
    const arCode = resolveArAccountCode(cust);
    const drKey = `${arCode}|${inv.customer_id}`;
    dr.set(drKey, (dr.get(drKey) || 0) + invTotal);

    // CR: route each line; remainder (rounding, missing lines, SKU-less
    // lines) goes to the channel-level bucket so the JE still balances.
    const channel = channelFromIpChannelName(channelByInvoice.get(inv.invoice_number));
    let routed = 0;
    for (const ln of linesByInvoice.get(inv.id) || []) {
      const cents = Number(ln.line_total_cents || 0);
      if (!cents) continue;
      const dims = ln.inventory_item_id ? skuDims.get(ln.inventory_item_id) : null;
      const { revenueCode } = resolveRevenueRouting({
        brandCode: dims?.brandCode,
        genderCode: dims?.genderCode,
        channel,
        isPrivateLabel: dims ? isPrivateLabelStyle(dims.styleCode) : false,
      });
      cr.set(revenueCode, (cr.get(revenueCode) || 0) + cents);
      routed += cents;
    }
    const remainder = invTotal - routed;
    if (remainder !== 0) {
      const { revenueCode } = resolveRevenueRouting({ channel });
      cr.set(revenueCode, (cr.get(revenueCode) || 0) + remainder);
    }
  }

  return {
    total_cents: total,
    dr: [...dr.entries()]
      .map(([k, cents]) => ({ account_code: k.split("|")[0], customer_id: k.split("|")[1], cents }))
      .sort((a, b) => a.account_code.localeCompare(b.account_code) || String(a.customer_id).localeCompare(String(b.customer_id))),
    cr: [...cr.entries()]
      .map(([account_code, cents]) => ({ account_code, cents }))
      .filter((x) => x.cents !== 0)
      .sort((a, b) => a.account_code.localeCompare(b.account_code)),
  };
}

// ── Payload composer ────────────────────────────────────────────────────────
// acctIdByCode: Map(code → gl_accounts.id). Throws if a needed code is missing
// or the JE would not balance — the caller records the domain as failed.
export function composeArRoutedPayload({ entity_id, mirror_date, run_id, agg, acctIdByCode, actor_user_id }) {
  const toDollars = (c) => (c / 100).toFixed(2);
  const drSum = agg.dr.reduce((s, x) => s + x.cents, 0);
  const crSum = agg.cr.reduce((s, x) => s + x.cents, 0);
  if (drSum !== crSum || drSum !== agg.total_cents) {
    throw new Error(`AR routed summary unbalanced: dr=${drSum} cr=${crSum} total=${agg.total_cents}`);
  }
  const lines = [];
  let n = 1;
  for (const d of agg.dr) {
    const id = acctIdByCode.get(d.account_code);
    if (!id) throw new Error(`AR routed summary: gl account code '${d.account_code}' missing`);
    lines.push({ line_number: n++, account_id: id, debit: toDollars(d.cents), credit: "0", subledger_type: "customer", subledger_id: d.customer_id });
  }
  for (const c of agg.cr) {
    const id = acctIdByCode.get(c.account_code);
    if (!id) throw new Error(`AR routed summary: gl account code '${c.account_code}' missing`);
    lines.push({ line_number: n++, account_id: id, debit: "0", credit: toDollars(c.cents) });
  }
  return {
    entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_xoro_mirror_daily",
    posting_date: mirror_date,
    source_module: "xoro_mirror",
    source_table: "xoro_mirror_runs",
    source_id: String(run_id),
    description: `Xoro AR mirror summary for ${mirror_date} (routed: ${agg.cr.map((c) => c.account_code).join(",")})`,
    created_by_user_id: actor_user_id || null,
    lines,
  };
}

// ── IO loader ───────────────────────────────────────────────────────────────
// Gathers everything bucketMirrorDay needs for one (entity, mirror_date).
export async function loadArRoutedInputs(supabase, { entity_id, mirror_date }) {
  const invoices = [];
  for (let off = 0; ; off += PAGE) {
    const { data, error } = await supabase
      .from("ar_invoices")
      .select("id, invoice_number, customer_id, total_amount_cents")
      .eq("entity_id", entity_id).eq("source", "xoro_mirror").eq("invoice_date", mirror_date)
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`ar_invoices read failed: ${error.message}`);
    invoices.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const linesByInvoice = new Map();
  const skuIds = new Set();
  const invIds = invoices.map((i) => i.id);
  for (let i = 0; i < invIds.length; i += IN_CHUNK) {
    const chunk = invIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("ar_invoice_lines")
      .select("ar_invoice_id, inventory_item_id, line_total_cents")
      .in("ar_invoice_id", chunk);
    if (error) throw new Error(`ar_invoice_lines read failed: ${error.message}`);
    for (const ln of data || []) {
      if (!linesByInvoice.has(ln.ar_invoice_id)) linesByInvoice.set(ln.ar_invoice_id, []);
      linesByInvoice.get(ln.ar_invoice_id).push(ln);
      if (ln.inventory_item_id) skuIds.add(ln.inventory_item_id);
    }
  }

  // Channel per invoice number from the day's sales-history rows (Xoro store).
  const channelByInvoice = new Map();
  const channelNameById = new Map();
  {
    const { data } = await supabase.from("ip_channel_master").select("id, channel_code");
    for (const ch of data || []) channelNameById.set(ch.id, ch.channel_code);
  }
  const invNums = [...new Set(invoices.map((i) => i.invoice_number).filter(Boolean))];
  for (let i = 0; i < invNums.length; i += IN_CHUNK) {
    const chunk = invNums.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("ip_sales_history_wholesale")
      .select("invoice_number, channel_id")
      .eq("txn_date", mirror_date)
      .in("invoice_number", chunk);
    if (error) throw new Error(`sales history channel read failed: ${error.message}`);
    for (const r of data || []) {
      if (!channelByInvoice.has(r.invoice_number)) {
        channelByInvoice.set(r.invoice_number, channelNameById.get(r.channel_id) || null);
      }
    }
  }

  // SKU dims: sku → style (code for PL detection, gender) → brand code.
  const skuDims = new Map();
  const styleIds = new Set();
  const skuArr = [...skuIds];
  const skuToStyle = new Map();
  for (let i = 0; i < skuArr.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from("ip_item_master").select("id, style_id").in("id", skuArr.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`ip_item_master read failed: ${error.message}`);
    for (const r of data || []) { if (r.style_id) { skuToStyle.set(r.id, r.style_id); styleIds.add(r.style_id); } }
  }
  const styleArr = [...styleIds];
  const styleById = new Map();
  const brandIds = new Set();
  for (let i = 0; i < styleArr.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from("style_master").select("id, style_code, gender_code, brand_id").in("id", styleArr.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`style_master read failed: ${error.message}`);
    for (const r of data || []) { styleById.set(r.id, r); if (r.brand_id) brandIds.add(r.brand_id); }
  }
  const brandCodeById = new Map();
  if (brandIds.size) {
    const { data, error } = await supabase.from("brand_master").select("id, code").in("id", [...brandIds]);
    if (error) throw new Error(`brand_master read failed: ${error.message}`);
    for (const r of data || []) brandCodeById.set(r.id, r.code);
  }
  for (const [skuId, styleId] of skuToStyle) {
    const st = styleById.get(styleId);
    if (!st) continue;
    skuDims.set(skuId, {
      brandCode: brandCodeById.get(st.brand_id) || null,
      genderCode: st.gender_code || null,
      styleCode: st.style_code || null,
    });
  }

  // Customer class for AR routing.
  const customers = new Map();
  const custIds = [...new Set(invoices.map((i) => i.customer_id).filter(Boolean))];
  for (let i = 0; i < custIds.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from("customers").select("id, is_factored, payment_processor").in("id", custIds.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`customers read failed: ${error.message}`);
    for (const r of data || []) customers.set(r.id, r);
  }

  return { invoices, linesByInvoice, channelByInvoice, skuDims, customers };
}

// Every account code the routed AR JE can touch — summary-je resolves these.
export const AR_ROUTED_CODES = [
  "1105", "1107", "1108",
  "4005", "4006", "4007", "4008", "4009", "4010", "4011", "4012", "4014", "4015", "4016",
];
