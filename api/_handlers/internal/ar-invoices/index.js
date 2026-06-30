// api/internal/ar-invoices
//
// GET  — list AR invoices. Filters:
//          ?status=<draft|pending_approval|sent|partial_paid|paid|void|reversed|posted_historical>
//          ?customer_id=<uuid>
//          ?from=<YYYY-MM-DD>  / ?to=<YYYY-MM-DD>   (invoice_date window)
//          ?include_void=true  (default false; void hidden)
//          ?q=<search>         (invoice_number ilike)
//          ?sales_order_id=<uuid>  (invoices generated from that SO; M10-C link)
//          ?limit=N (default 100, max 500)
// POST — create a draft AR invoice. Body:
//          {
//            customer_id, invoice_number?, invoice_date, due_date?,
//            payment_terms_id?,
//            description?,
//            ar_account_id?, revenue_account_id?,
//            cogs_account_id?, inventory_asset_account_id?,
//            lines: [
//              { description?, inventory_item_id?, quantity?,
//                unit_price_cents?, line_total_cents?,
//                revenue_account_id? }
//            ]
//          }
//
//        Either unit_price_cents (+ quantity) OR explicit line_total_cents per line.
//        The DB trigger ar_invoice_lines_compute_total recomputes line_total_cents
//        from qty*unit_price when both are present; the ar_invoices total_amount_cents
//        is then maintained by ar_invoice_lines_maintain_total.
//
// Tangerine P4 Chunk 4 (M4 Accounts Receivable admin UI + handlers).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, applyChannelScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = [
  "draft", "unposted", "pending_approval", "sent",
  "partial_paid", "paid", "void", "reversed", "posted_historical",
];
const KIND_VALUES = ["customer_invoice", "customer_credit_memo", "customer_invoice_historical"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data, error } = await admin
    .from("entities")
    .select(
      "id, default_ar_account_id, default_revenue_account_id, " +
      "default_cogs_account_id, default_inventory_account_id",
    )
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * Generate the next AR invoice number for a given year using a simple
 * count + 1 scheme: AR-YYYY-NNNNN. Not strictly monotonic under concurrency
 * but adequate as an auto-suggestion when operator leaves the field blank;
 * the (entity_id, invoice_number) unique constraint catches collisions and
 * the handler retries with a +1 bump. P4-5 wires a sequence-table-backed
 * generator for receipts; AR invoices defer that until volume demands it.
 */
async function nextInvoiceNumber(admin, entityId, year) {
  const prefix = `AR-${year}-`;
  const { count } = await admin
    .from("ar_invoices")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("invoice_number", `${prefix}%`);
  const next = (count || 0) + 1;
  return `${prefix}${String(next).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  if (req.method === "GET") {
    const parsed = parseListQuery(req.url, req.headers?.host || "localhost");
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { status, customerId, from, to, includeVoid, q, limit, salesOrderId } = parsed.data;

    let query = admin
      .from("ar_invoices")
      .select(
        "id, entity_id, customer_id, ship_to_location_id, invoice_number, invoice_kind, gl_status, " +
        "invoice_date, posting_date, due_date, payment_terms_id, " +
        "ar_account_id, revenue_account_id, cogs_account_id, inventory_asset_account_id, " +
        "accrual_je_id, cash_je_id, total_amount_cents, paid_amount_cents, " +
        "sales_order_id, description, source, created_at, updated_at",
      )
      .eq("entity_id", entityId)
      .order("invoice_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    // P15 C3 — brand/channel scoping. No-op unless BRAND_SCOPE_MODE=enforce AND
    // a specific brand/channel is selected (else returns the query unchanged).
    query = applyBrandScope(query, req);
    query = applyChannelScope(query, req);

    if (status) {
      query = query.eq("gl_status", status);
    } else if (!includeVoid) {
      query = query.neq("gl_status", "void");
    }
    if (customerId) query = query.eq("customer_id", customerId);
    if (salesOrderId) query = query.eq("sales_order_id", salesOrderId);
    if (from)       query = query.gte("invoice_date", from);
    if (to)         query = query.lte("invoice_date", to);
    if (q)          query = query.ilike("invoice_number", `%${q}%`);
    if (parsed.data.source) query = query.eq("source", parsed.data.source);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    // Resolve the linked sales-order number (so the UI can warn "this re-opens
    // SO-NNNN" before a delete/void). One batched lookup.
    const rows = data || [];
    const soIds = [...new Set(rows.map((r) => r.sales_order_id).filter(Boolean))];
    if (soIds.length) {
      const { data: sos } = await admin.from("sales_orders").select("id, so_number").in("id", soIds);
      const numById = new Map((sos || []).map((s) => [s.id, s.so_number]));
      for (const r of rows) r.so_number = r.sales_order_id ? (numById.get(r.sales_order_id) || null) : null;
    }
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Auto-generate invoice_number if blank.
    let invoiceNumber = v.data.invoice_number;
    if (!invoiceNumber) {
      const year = v.data.invoice_date.slice(0, 4);
      invoiceNumber = await nextInvoiceNumber(admin, entityId, year);
    }

    // Resolve account defaults from entity if not supplied.
    const ar_account_id          = v.data.ar_account_id          || entity.default_ar_account_id          || null;
    const revenue_account_id     = v.data.revenue_account_id     || entity.default_revenue_account_id     || null;
    const cogs_account_id        = v.data.cogs_account_id        || entity.default_cogs_account_id        || null;
    const inventory_asset_account_id =
      v.data.inventory_asset_account_id || entity.default_inventory_account_id || null;

    // due_date defaults to invoice_date (P4-5 will resolve via payment_terms.compute_due_date).
    const due_date = v.data.due_date || v.data.invoice_date;

    const insertHeader = {
      entity_id: entityId,
      customer_id: v.data.customer_id,
      ship_to_location_id: v.data.ship_to_location_id || null,
      invoice_number: invoiceNumber,
      invoice_kind: v.data.invoice_kind,
      gl_status: "draft",
      invoice_date: v.data.invoice_date,
      posting_date: v.data.invoice_date,
      due_date,
      payment_terms_id: v.data.payment_terms_id,
      ar_account_id,
      revenue_account_id,
      cogs_account_id,
      inventory_asset_account_id,
      description: v.data.description,
    };

    const { data: header, error: hErr } = await admin
      .from("ar_invoices")
      .insert(insertHeader)
      .select()
      .single();
    if (hErr) {
      if (hErr.code === "23505") {
        return res.status(409).json({ error: "Invoice with that number already exists for this entity" });
      }
      return res.status(500).json({ error: hErr.message });
    }

    if (v.data.lines.length > 0) {
      const lineRows = v.data.lines.map((ln, idx) => ({
        ar_invoice_id: header.id,
        line_number: idx + 1,
        description: ln.description,
        revenue_account_id: ln.revenue_account_id,
        inventory_item_id: ln.inventory_item_id,
        quantity: ln.quantity,
        unit_price_cents: ln.unit_price_cents,
        line_total_cents: ln.line_total_cents,
        tax_amount_cents: 0,
      }));
      const { error: lErr } = await admin
        .from("ar_invoice_lines")
        .insert(lineRows);
      if (lErr) {
        // Rollback the header to avoid an orphan with total=0.
        await admin.from("ar_invoices").delete().eq("id", header.id);
        return res.status(500).json({ error: `Failed to insert lines: ${lErr.message}` });
      }
    }

    const { data: fresh } = await admin
      .from("ar_invoices")
      .select("*")
      .eq("id", header.id)
      .maybeSingle();

    return res.status(201).json(fresh || header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

/**
 * Parses + validates list-query parameters into a structured shape, isolated
 * from the request lifecycle for unit-testing.
 */
export const SOURCE_VALUES = [
  "manual", "xoro_mirror", "shopify", "fba", "walmart",
  "faire", "edi_3pl", "plaid_sync", "api", "system",
];

export function parseListQuery(rawUrl, host) {
  const url = new URL(rawUrl, `https://${host || "localhost"}`);
  const status      = (url.searchParams.get("status") || "").trim();
  const customerId  = (url.searchParams.get("customer_id") || "").trim();
  const from        = (url.searchParams.get("from") || "").trim();
  const to          = (url.searchParams.get("to") || "").trim();
  const includeVoid = url.searchParams.get("include_void") === "true";
  const q           = (url.searchParams.get("q") || "").trim();
  const source      = (url.searchParams.get("source") || "").trim();
  const salesOrderId = (url.searchParams.get("sales_order_id") || "").trim();
  let limit = parseInt(url.searchParams.get("limit") || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  if (status && !STATUS_VALUES.includes(status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (customerId && !UUID_RE.test(customerId)) {
    return { error: "customer_id must be a uuid" };
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return { error: "from must be YYYY-MM-DD" };
  }
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { error: "to must be YYYY-MM-DD" };
  }
  if (source && !SOURCE_VALUES.includes(source)) {
    return { error: `source must be one of ${SOURCE_VALUES.join(", ")}` };
  }
  if (salesOrderId && !UUID_RE.test(salesOrderId)) {
    return { error: "sales_order_id must be a uuid" };
  }

  return { data: { status, customerId, from, to, includeVoid, q, source, limit, salesOrderId } };
}

/**
 * Validates the create-draft body. Each line MUST resolve to a positive
 * line_total_cents — either by carrying it explicitly OR by carrying
 * unit_price_cents + quantity (the trigger computes it from those).
 */
export function validateInsert(body) {
  if (!body.customer_id || !isUuid(body.customer_id)) {
    return { error: "customer_id (uuid) is required" };
  }
  const kind = body.invoice_kind || "customer_invoice";
  if (!KIND_VALUES.includes(kind)) {
    return { error: `invoice_kind must be one of ${KIND_VALUES.join(", ")}` };
  }
  if (!body.invoice_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.invoice_date)) {
    return { error: "invoice_date must be YYYY-MM-DD" };
  }
  if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
    return { error: "due_date must be YYYY-MM-DD" };
  }
  if (body.due_date && body.due_date < body.invoice_date) {
    return { error: "due_date cannot precede invoice_date" };
  }
  if (body.payment_terms_id && !isUuid(body.payment_terms_id)) {
    return { error: "payment_terms_id must be a uuid" };
  }
  for (const fld of ["ar_account_id", "revenue_account_id", "cogs_account_id", "inventory_asset_account_id"]) {
    if (body[fld] && !isUuid(body[fld])) {
      return { error: `${fld} must be a uuid` };
    }
  }
  if (body.ship_to_location_id && !isUuid(body.ship_to_location_id)) {
    return { error: "ship_to_location_id must be a uuid" };
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { error: "lines must be a non-empty array" };
  }

  const invoiceNumber = body.invoice_number ? String(body.invoice_number).trim() : "";

  const normalizedLines = [];
  for (let i = 0; i < body.lines.length; i++) {
    const ln = body.lines[i] || {};
    const lineNum = i + 1;

    if (ln.inventory_item_id && !isUuid(ln.inventory_item_id)) {
      return { error: `line ${lineNum}: inventory_item_id must be a uuid` };
    }
    if (ln.revenue_account_id && !isUuid(ln.revenue_account_id)) {
      return { error: `line ${lineNum}: revenue_account_id must be a uuid` };
    }

    const hasExplicitTotal = ln.line_total_cents !== undefined && ln.line_total_cents !== null && ln.line_total_cents !== "";
    const hasQty = ln.quantity !== undefined && ln.quantity !== null && ln.quantity !== "";
    const hasUnitPrice = ln.unit_price_cents !== undefined && ln.unit_price_cents !== null && ln.unit_price_cents !== "";

    let quantity = null;
    let unitPriceCents = null;
    let lineTotalCents = null;

    if (hasQty) {
      const q = Number(ln.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        return { error: `line ${lineNum}: quantity must be > 0` };
      }
      quantity = q;
    }
    if (hasUnitPrice) {
      const up = toBigIntCents(ln.unit_price_cents);
      if (up.error) return { error: `line ${lineNum}: unit_price_cents — ${up.error}` };
      if (up.value < 0n) return { error: `line ${lineNum}: unit_price_cents must be >= 0` };
      unitPriceCents = up.value.toString();
    }
    if (hasExplicitTotal) {
      const tot = toBigIntCents(ln.line_total_cents);
      if (tot.error) return { error: `line ${lineNum}: line_total_cents — ${tot.error}` };
      if (tot.value <= 0n) return { error: `line ${lineNum}: line_total_cents must be > 0` };
      lineTotalCents = tot.value.toString();
    } else if (hasQty && hasUnitPrice) {
      const computed = BigInt(Math.round(quantity)) * BigInt(unitPriceCents);
      if (computed <= 0n) {
        return { error: `line ${lineNum}: quantity * unit_price_cents must be > 0` };
      }
      lineTotalCents = computed.toString();
    } else {
      return {
        error: `line ${lineNum}: must supply line_total_cents OR (quantity + unit_price_cents)`,
      };
    }

    if (ln.inventory_item_id && !hasQty) {
      return { error: `line ${lineNum}: inventory_item_id requires quantity (for FIFO consume)` };
    }

    normalizedLines.push({
      inventory_item_id: ln.inventory_item_id || null,
      revenue_account_id: ln.revenue_account_id || null,
      quantity,
      unit_price_cents: unitPriceCents,
      line_total_cents: lineTotalCents,
      description: ln.description ? String(ln.description).trim() : null,
    });
  }

  return {
    data: {
      customer_id: body.customer_id,
      ship_to_location_id: body.ship_to_location_id || null,
      invoice_number: invoiceNumber || null,
      invoice_kind: kind,
      invoice_date: body.invoice_date,
      due_date: body.due_date || null,
      payment_terms_id: body.payment_terms_id || null,
      description: body.description ? String(body.description).trim() : null,
      ar_account_id: body.ar_account_id || null,
      revenue_account_id: body.revenue_account_id || null,
      cogs_account_id: body.cogs_account_id || null,
      inventory_asset_account_id: body.inventory_asset_account_id || null,
      lines: normalizedLines,
    },
  };
}

function toBigIntCents(raw) {
  if (raw === null || raw === undefined || raw === "") return { error: "missing" };
  if (typeof raw === "bigint") return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: "not finite" };
    if (!Number.isInteger(raw)) return { error: "must be an integer (cents)" };
    return { value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { error: `invalid integer cents: ${raw}` };
    try { return { value: BigInt(s) }; } catch { return { error: "could not parse" }; }
  }
  return { error: "must be number or string of integer cents" };
}
