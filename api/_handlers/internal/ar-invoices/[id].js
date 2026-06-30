// api/internal/ar-invoices/[id]
//
// GET    — fetch one AR invoice + lines.
// PATCH  — edit draft/unposted only. Returns 405 once gl_status is anything
//          else (sent/partial_paid/paid/void/reversed/posted_historical).
// DELETE — hard-delete only for draft/unposted. Returns 409 once gl_status
//          moves past pending_approval. (Use /void instead.)
//
// Tangerine P4 Chunk 4 (M4 Accounts Receivable).

import { createClient } from "@supabase/supabase-js";
import { reopenSalesOrderFromInvoice } from "../../../_lib/sales-orders/reopenFromInvoice.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_VALUES = ["customer_invoice", "customer_credit_memo", "customer_invoice_historical"];
const EDITABLE_STATUSES = new Set(["draft", "unposted"]);
const DELETABLE_STATUSES = new Set(["draft", "unposted"]);

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: invoice, error: fetchErr } = await admin
    .from("ar_invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin
      .from("ar_invoice_lines")
      .select("*")
      .eq("ar_invoice_id", id)
      .order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    return res.status(200).json({ ...invoice, lines: lines || [] });
  }

  if (req.method === "PATCH") {
    if (!EDITABLE_STATUSES.has(invoice.gl_status)) {
      res.setHeader("Allow", "GET");
      return res.status(405).json({
        error: `Cannot edit invoice in gl_status='${invoice.gl_status}'. Only draft/unposted invoices are editable. Void or issue a credit memo instead.`,
      });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    if (Object.keys(v.data.header).length > 0) {
      const { error: upErr } = await admin
        .from("ar_invoices")
        .update(v.data.header)
        .eq("id", id);
      if (upErr) {
        if (upErr.code === "23505") {
          return res.status(409).json({ error: "Invoice with that number already exists for this entity" });
        }
        return res.status(500).json({ error: upErr.message });
      }
    }

    if (v.data.lines) {
      const { error: delErr } = await admin
        .from("ar_invoice_lines")
        .delete()
        .eq("ar_invoice_id", id);
      if (delErr) return res.status(500).json({ error: `Failed to clear lines: ${delErr.message}` });

      if (v.data.lines.length > 0) {
        const lineRows = v.data.lines.map((ln, idx) => ({
          ar_invoice_id: id,
          line_number: idx + 1,
          description: ln.description,
          revenue_account_id: ln.revenue_account_id,
          inventory_item_id: ln.inventory_item_id,
          quantity: ln.quantity,
          unit_price_cents: ln.unit_price_cents,
          line_total_cents: ln.line_total_cents,
          tax_amount_cents: 0,
        }));
        const { error: insErr } = await admin.from("ar_invoice_lines").insert(lineRows);
        if (insErr) return res.status(500).json({ error: `Failed to insert lines: ${insErr.message}` });
      }
    }

    const { data: fresh } = await admin
      .from("ar_invoices")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return res.status(200).json(fresh);
  }

  if (req.method === "DELETE") {
    if (!DELETABLE_STATUSES.has(invoice.gl_status)) {
      return res.status(409).json({
        error: `Cannot delete invoice in gl_status='${invoice.gl_status}'. Use /void instead.`,
      });
    }
    // Re-open the originating sales order (if any) BEFORE deleting — the reopen
    // reads this invoice's lines to know how much to un-invoice. Otherwise the SO
    // is stranded in 'invoiced' and effectively lost.
    let reopened = { reopened: false, so_number: null };
    try { reopened = await reopenSalesOrderFromInvoice(admin, id); } catch { /* best-effort; never block the delete */ }
    // FK CASCADE on ar_invoice_lines handles line cleanup.
    const { error: delErr } = await admin
      .from("ar_invoice_lines")
      .delete()
      .eq("ar_invoice_id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    const { error: invErr } = await admin
      .from("ar_invoices")
      .delete()
      .eq("id", id);
    if (invErr) return res.status(500).json({ error: invErr.message });
    return res.status(200).json({ deleted: true, reopened_sales_order: reopened.reopened, so_number: reopened.so_number });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  const header = {};
  let lines = null;

  if ("entity_id" in body) return { error: "entity_id is locked" };
  if ("gl_status" in body) {
    return { error: "gl_status is not patchable here — use /post or /void" };
  }
  if ("accrual_je_id" in body || "cash_je_id" in body) {
    return { error: "JE pointers are server-controlled" };
  }
  if ("paid_amount_cents" in body || "total_amount_cents" in body) {
    return { error: "amount fields are trigger-maintained" };
  }
  if ("invoice_kind" in body) {
    if (!KIND_VALUES.includes(body.invoice_kind)) {
      return { error: `invoice_kind must be one of ${KIND_VALUES.join(", ")}` };
    }
    header.invoice_kind = body.invoice_kind;
  }

  if ("customer_id" in body) {
    if (!body.customer_id || !UUID_RE.test(body.customer_id)) {
      return { error: "customer_id must be a uuid" };
    }
    header.customer_id = body.customer_id;
  }
  if ("ship_to_location_id" in body) {
    if (body.ship_to_location_id && !UUID_RE.test(body.ship_to_location_id)) {
      return { error: "ship_to_location_id must be a uuid" };
    }
    header.ship_to_location_id = body.ship_to_location_id || null;
  }
  if ("invoice_number" in body) {
    const s = String(body.invoice_number || "").trim();
    if (!s) return { error: "invoice_number must be non-empty" };
    header.invoice_number = s;
  }
  if ("invoice_date" in body) {
    if (body.invoice_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.invoice_date)) {
      return { error: "invoice_date must be YYYY-MM-DD" };
    }
    header.invoice_date = body.invoice_date;
    header.posting_date = body.invoice_date;
  }
  if ("due_date" in body) {
    if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      return { error: "due_date must be YYYY-MM-DD" };
    }
    header.due_date = body.due_date || null;
  }
  if ("payment_terms_id" in body) {
    if (body.payment_terms_id && !UUID_RE.test(body.payment_terms_id)) {
      return { error: "payment_terms_id must be a uuid" };
    }
    header.payment_terms_id = body.payment_terms_id || null;
  }
  if ("description" in body) {
    header.description = body.description ? String(body.description).trim() : null;
  }
  for (const fld of ["ar_account_id", "revenue_account_id", "cogs_account_id", "inventory_asset_account_id"]) {
    if (fld in body) {
      if (body[fld] && !UUID_RE.test(body[fld])) {
        return { error: `${fld} must be a uuid` };
      }
      header[fld] = body[fld] || null;
    }
  }

  if ("lines" in body) {
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return { error: "lines (when provided) must be a non-empty array" };
    }
    const normalized = [];
    for (let i = 0; i < body.lines.length; i++) {
      const ln = body.lines[i] || {};
      const lineNum = i + 1;
      if (ln.inventory_item_id && !UUID_RE.test(ln.inventory_item_id)) {
        return { error: `line ${lineNum}: inventory_item_id must be a uuid` };
      }
      if (ln.revenue_account_id && !UUID_RE.test(ln.revenue_account_id)) {
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
        const up = parseCents(ln.unit_price_cents);
        if (up.error) return { error: `line ${lineNum}: unit_price_cents — ${up.error}` };
        if (up.value < 0n) return { error: `line ${lineNum}: unit_price_cents must be >= 0` };
        unitPriceCents = up.value.toString();
      }
      if (hasExplicitTotal) {
        const tot = parseCents(ln.line_total_cents);
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
        return { error: `line ${lineNum}: must supply line_total_cents OR (quantity + unit_price_cents)` };
      }
      if (ln.inventory_item_id && !hasQty) {
        return { error: `line ${lineNum}: inventory_item_id requires quantity (for FIFO consume)` };
      }

      normalized.push({
        inventory_item_id: ln.inventory_item_id || null,
        revenue_account_id: ln.revenue_account_id || null,
        quantity,
        unit_price_cents: unitPriceCents,
        line_total_cents: lineTotalCents,
        description: ln.description ? String(ln.description).trim() : null,
      });
    }
    lines = normalized;
  }

  return { data: { header, lines } };
}

function parseCents(raw) {
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
