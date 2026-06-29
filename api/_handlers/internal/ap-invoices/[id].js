// api/internal/ap-invoices/[id]
//
// GET    — fetch one AP invoice + lines.
// PATCH  — edit draft only. Returns 405 if gl_status is anything other than
//          'draft' / 'unposted'. Replaces lines wholesale when `lines` is in
//          the body (the trigger rebuilds total_amount_cents).
// DELETE — hard-delete only for draft / unposted. Returns 409 once gl_status
//          is past pending_approval (posted/paid/void/reversed).
//
// Tangerine P3 Chunk 2.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_VALUES = ["vendor_bill", "vendor_credit_memo", "expense_report"];
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

  // Fetch current row up front; all branches need it.
  const { data: invoice, error: fetchErr } = await admin
    .from("invoices")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  if (req.method === "GET") {
    // NB: invoice_line_items orders by `line_index` — there is NO `line_number`
    // column on this table (ordering by it 500'd the Inventory Snapshot bill
    // drill: "column invoice_line_items.line_number does not exist").
    const { data: lines, error: lErr } = await admin
      .from("invoice_line_items")
      .select("*")
      .eq("invoice_id", id)
      .order("line_index", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    return res.status(200).json({ ...invoice, lines: lines || [] });
  }

  if (req.method === "PATCH") {
    if (!EDITABLE_STATUSES.has(invoice.gl_status)) {
      res.setHeader("Allow", "GET");
      return res.status(405).json({
        error: `Cannot edit invoice in gl_status='${invoice.gl_status}'. Only draft/unposted invoices are editable. Void or reverse instead.`,
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
        .from("invoices")
        .update(v.data.header)
        .eq("id", id);
      if (upErr) {
        if (upErr.code === "23505") {
          return res.status(409).json({ error: "Invoice with that number already exists for this vendor" });
        }
        return res.status(500).json({ error: upErr.message });
      }
    }

    if (v.data.lines) {
      // Replace lines: delete then insert. The trigger rebuilds total.
      const { error: delErr } = await admin
        .from("invoice_line_items")
        .delete()
        .eq("invoice_id", id);
      if (delErr) return res.status(500).json({ error: `Failed to clear lines: ${delErr.message}` });

      if (v.data.lines.length > 0) {
        const lineRows = v.data.lines.map((ln, idx) => ({
          invoice_id: id,
          line_index: idx + 1, // invoice_line_items uses line_index, not line_number
          description: ln.description,
          expense_account_id: ln.expense_account_id,
          inventory_item_id: ln.inventory_item_id,
          quantity: ln.quantity,
          unit_cost_cents: ln.unit_cost_cents,
          tax_amount_cents: 0,
        }));
        const { error: insErr } = await admin.from("invoice_line_items").insert(lineRows);
        if (insErr) return res.status(500).json({ error: `Failed to insert lines: ${insErr.message}` });
      }
    }

    // Re-read for the trigger-maintained total.
    const { data: fresh } = await admin
      .from("invoices")
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
    // FK CASCADE on invoice_line_items handles line cleanup.
    const { error: delErr } = await admin
      .from("invoice_line_items")
      .delete()
      .eq("invoice_id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    const { error: invErr } = await admin
      .from("invoices")
      .delete()
      .eq("id", id);
    if (invErr) return res.status(500).json({ error: invErr.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  const header = {};
  let lines = null;

  if ("entity_id" in body) return { error: "entity_id is locked" };
  if ("gl_status" in body) {
    return { error: "gl_status is not patchable here — use /post, /pay, or /void" };
  }
  if ("accrual_je_id" in body || "cash_je_id" in body) {
    return { error: "JE pointers are server-controlled" };
  }
  if ("paid_amount_cents" in body || "total_amount_cents" in body) {
    return { error: "amount fields are trigger-maintained" };
  }

  if ("vendor_id" in body) {
    if (!body.vendor_id || !UUID_RE.test(body.vendor_id)) {
      return { error: "vendor_id must be a uuid" };
    }
    header.vendor_id = body.vendor_id;
  }
  if ("invoice_number" in body) {
    const s = String(body.invoice_number || "").trim();
    if (!s) return { error: "invoice_number must be non-empty" };
    header.invoice_number = s;
  }
  if ("invoice_kind" in body) {
    if (!KIND_VALUES.includes(body.invoice_kind)) {
      return { error: `invoice_kind must be one of ${KIND_VALUES.join(", ")}` };
    }
    header.invoice_kind = body.invoice_kind;
  }
  if ("posting_date" in body) {
    if (body.posting_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.posting_date)) {
      return { error: "posting_date must be YYYY-MM-DD" };
    }
    header.posting_date = body.posting_date;
  }
  if ("due_date" in body) {
    if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
      return { error: "due_date must be YYYY-MM-DD" };
    }
    header.due_date = body.due_date || null;
  }
  if ("description" in body) {
    header.description = body.description ? String(body.description).trim() : null;
  }
  if ("receiving_channel" in body) {
    if (body.receiving_channel != null && body.receiving_channel !== "WS" && body.receiving_channel !== "EC") {
      return { error: "receiving_channel must be WS or EC" };
    }
    header.receiving_channel = body.receiving_channel || null;
  }
  if ("expense_account_id" in body) {
    if (body.expense_account_id && !UUID_RE.test(body.expense_account_id)) {
      return { error: "expense_account_id must be a uuid" };
    }
    header.expense_account_id = body.expense_account_id || null;
  }
  if ("ap_account_id" in body) {
    if (body.ap_account_id && !UUID_RE.test(body.ap_account_id)) {
      return { error: "ap_account_id must be a uuid" };
    }
    header.ap_account_id = body.ap_account_id || null;
  }
  if ("payment_terms_id" in body) {
    if (body.payment_terms_id && !UUID_RE.test(body.payment_terms_id)) {
      return { error: "payment_terms_id must be a uuid" };
    }
    header.payment_terms_id = body.payment_terms_id || null;
  }

  if ("lines" in body) {
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return { error: "lines (when provided) must be a non-empty array" };
    }
    const normalized = [];
    for (let i = 0; i < body.lines.length; i++) {
      const ln = body.lines[i] || {};
      const lineNum = i + 1;
      const hasInventory = Boolean(ln.inventory_item_id);
      const hasExpense = Boolean(ln.expense_account_id);
      const hasAmount = ln.amount_cents !== undefined && ln.amount_cents !== null && ln.amount_cents !== "";

      if (hasInventory) {
        if (!UUID_RE.test(ln.inventory_item_id)) {
          return { error: `line ${lineNum}: inventory_item_id must be a uuid` };
        }
        const qty = Number(ln.quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
          return { error: `line ${lineNum}: inventory line requires quantity > 0` };
        }
        const uc = parseCents(ln.unit_cost_cents);
        if (uc.error) return { error: `line ${lineNum}: unit_cost_cents — ${uc.error}` };
        if (uc.value < 0n) return { error: `line ${lineNum}: unit_cost_cents must be >= 0` };
        normalized.push({
          inventory_item_id: ln.inventory_item_id,
          expense_account_id: null,
          quantity: qty,
          unit_cost_cents: uc.value.toString(),
          description: ln.description ? String(ln.description).trim() : null,
        });
      } else if (hasExpense && hasAmount) {
        if (!UUID_RE.test(ln.expense_account_id)) {
          return { error: `line ${lineNum}: expense_account_id must be a uuid` };
        }
        const amt = parseCents(ln.amount_cents);
        if (amt.error) return { error: `line ${lineNum}: amount_cents — ${amt.error}` };
        if (amt.value <= 0n) return { error: `line ${lineNum}: amount_cents must be > 0` };
        normalized.push({
          inventory_item_id: null,
          expense_account_id: ln.expense_account_id,
          quantity: 1,
          unit_cost_cents: amt.value.toString(),
          description: ln.description ? String(ln.description).trim() : null,
        });
      } else {
        return {
          error: `line ${lineNum}: must be either inventory (inventory_item_id+quantity+unit_cost_cents) or expense (expense_account_id+amount_cents)`,
        };
      }
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
