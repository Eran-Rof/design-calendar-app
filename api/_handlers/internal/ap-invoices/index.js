// api/internal/ap-invoices
//
// GET  — list AP invoices. Filters:
//          ?status=<draft|pending_approval|posted|paid|void>
//          ?vendor_id=<uuid>
//          ?from=<YYYY-MM-DD>  / ?to=<YYYY-MM-DD>  (posting_date window)
//          ?include_void=true  (default false; void are hidden)
//          ?q=<search>         (invoice_number ilike)
//          ?limit=N (default 100, max 500)
// POST — create a draft AP invoice. Body:
//          {
//            invoice_kind: 'vendor_bill'|'vendor_credit_memo'|'expense_report',
//            vendor_id, invoice_number, posting_date, due_date?,
//            description?, expense_account_id?, ap_account_id?,
//            lines: [
//              // expense line:
//              { expense_account_id, amount_cents, description? }
//              // inventory line:
//              { inventory_item_id, quantity, unit_cost_cents, description? }
//            ]
//          }
//
//        total_amount_cents is trigger-maintained from invoice_line_items
//        (P3-1 migration). Handler passes lines through and lets the trigger
//        recompute. gl_status defaults 'unposted' but we set it to 'draft'
//        explicitly for legibility in this module.
//
// Tangerine P3 Chunk 2 (M3 Accounts Payable admin UI + handlers).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["draft", "unposted", "pending_approval", "posted", "paid", "void", "reversed"];
const KIND_VALUES = ["vendor_bill", "vendor_credit_memo", "expense_report"];

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
    .select("id, default_ap_account_id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data;
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
    const url = new URL(req.url, `https://${req.headers.host}`);
    const status      = (url.searchParams.get("status") || "").trim();
    const vendorId    = (url.searchParams.get("vendor_id") || "").trim();
    const from        = (url.searchParams.get("from") || "").trim();
    const to          = (url.searchParams.get("to") || "").trim();
    const includeVoid = url.searchParams.get("include_void") === "true";
    const q           = (url.searchParams.get("q") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "100", 10);
    if (Number.isNaN(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;

    if (status && !STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${STATUS_VALUES.join(", ")}` });
    }
    if (vendorId && !UUID_RE.test(vendorId)) {
      return res.status(400).json({ error: "vendor_id must be a uuid" });
    }
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: "from must be YYYY-MM-DD" });
    }
    if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "to must be YYYY-MM-DD" });
    }

    let query = admin
      .from("invoices")
      .select(
        "id, entity_id, vendor_id, invoice_number, invoice_kind, gl_status, " +
        "posting_date, due_date, description, expense_account_id, ap_account_id, " +
        "accrual_je_id, cash_je_id, total_amount_cents, paid_amount_cents, " +
        "created_at, updated_at"
      )
      .eq("entity_id", entityId)
      .order("posting_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq("gl_status", status);
    } else if (!includeVoid) {
      // Hide void by default unless explicitly requested or filtered.
      query = query.neq("gl_status", "void");
    }
    if (vendorId) query = query.eq("vendor_id", vendorId);
    if (from)     query = query.gte("posting_date", from);
    if (to)       query = query.lte("posting_date", to);
    if (q)        query = query.ilike("invoice_number", `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Resolve ap_account_id default from entities if not supplied.
    const ap_account_id = v.data.ap_account_id || entity.default_ap_account_id || null;

    // posting_date is required as the line of demarcation; due_date defaults to
    // posting_date if not supplied (P3-2 doesn't have a vendor.payment_terms
    // resolver yet — that's an enrichment).
    const due_date = v.data.due_date || v.data.posting_date;

    // Insert the invoice header first; trigger will recompute total after lines.
    const insertHeader = {
      entity_id: entityId,
      vendor_id: v.data.vendor_id,
      invoice_number: v.data.invoice_number,
      invoice_kind: v.data.invoice_kind,
      gl_status: "draft",
      posting_date: v.data.posting_date,
      due_date,
      description: v.data.description,
      expense_account_id: v.data.expense_account_id,
      ap_account_id,
    };

    const { data: header, error: hErr } = await admin
      .from("invoices")
      .insert(insertHeader)
      .select()
      .single();
    if (hErr) {
      if (hErr.code === "23505") {
        return res.status(409).json({ error: "Invoice with that number already exists for this vendor" });
      }
      return res.status(500).json({ error: hErr.message });
    }

    // Insert lines (the trigger will rebuild total_amount_cents).
    if (v.data.lines.length > 0) {
      const lineRows = v.data.lines.map((ln, idx) => ({
        invoice_id: header.id,
        line_number: idx + 1,
        description: ln.description,
        expense_account_id: ln.expense_account_id,
        inventory_item_id: ln.inventory_item_id,
        quantity: ln.quantity,
        unit_cost_cents: ln.unit_cost_cents,
        tax_amount_cents: 0,
      }));
      const { error: lErr } = await admin
        .from("invoice_line_items")
        .insert(lineRows);
      if (lErr) {
        // Rollback the header to avoid an orphan with total=0.
        await admin.from("invoices").delete().eq("id", header.id);
        return res.status(500).json({ error: `Failed to insert lines: ${lErr.message}` });
      }
    }

    // Re-read the header so we return the trigger-maintained total_amount_cents.
    const { data: fresh } = await admin
      .from("invoices")
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

function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

/**
 * Validates the create-draft body. Total math (sum of lines == header total) is
 * enforced by the DB trigger — we just sanity-check line shape here. Lines may
 * be of two kinds:
 *   - expense line:    { expense_account_id (uuid), amount_cents (bigint > 0), description? }
 *   - inventory line:  { inventory_item_id (uuid), quantity (number > 0),
 *                        unit_cost_cents (bigint >= 0), description? }
 *
 * We normalize amount_cents on expense lines into quantity=1 + unit_cost_cents=amount
 * because invoice_line_items is shaped that way (the cents-grain trigger sums
 * quantity*unit_cost_cents).
 */
export function validateInsert(body) {
  if (!body.vendor_id || !isUuid(body.vendor_id)) {
    return { error: "vendor_id (uuid) is required" };
  }
  if (!body.invoice_number || !String(body.invoice_number).trim()) {
    return { error: "invoice_number is required" };
  }
  const kind = body.invoice_kind || "vendor_bill";
  if (!KIND_VALUES.includes(kind)) {
    return { error: `invoice_kind must be one of ${KIND_VALUES.join(", ")}` };
  }
  if (!body.posting_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.posting_date)) {
    return { error: "posting_date must be YYYY-MM-DD" };
  }
  if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) {
    return { error: "due_date must be YYYY-MM-DD" };
  }
  if (body.due_date && body.due_date < body.posting_date) {
    return { error: "due_date cannot precede posting_date" };
  }
  if (body.expense_account_id && !isUuid(body.expense_account_id)) {
    return { error: "expense_account_id must be a uuid" };
  }
  if (body.ap_account_id && !isUuid(body.ap_account_id)) {
    return { error: "ap_account_id must be a uuid" };
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { error: "lines must be a non-empty array" };
  }

  const normalizedLines = [];
  for (let i = 0; i < body.lines.length; i++) {
    const ln = body.lines[i] || {};
    const lineNum = i + 1;

    const hasInventory = Boolean(ln.inventory_item_id);
    const hasExpense = Boolean(ln.expense_account_id);
    const hasAmount = ln.amount_cents !== undefined && ln.amount_cents !== null && ln.amount_cents !== "";

    if (hasInventory) {
      if (!isUuid(ln.inventory_item_id)) {
        return { error: `line ${lineNum}: inventory_item_id must be a uuid` };
      }
      const qty = Number(ln.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return { error: `line ${lineNum}: inventory line requires quantity > 0` };
      }
      const uc = toBigIntCents(ln.unit_cost_cents);
      if (uc.error) return { error: `line ${lineNum}: unit_cost_cents — ${uc.error}` };
      if (uc.value < 0n) return { error: `line ${lineNum}: unit_cost_cents must be >= 0` };

      normalizedLines.push({
        inventory_item_id: ln.inventory_item_id,
        expense_account_id: null,
        quantity: qty,
        unit_cost_cents: uc.value.toString(),
        description: ln.description ? String(ln.description).trim() : null,
      });
    } else if (hasExpense && hasAmount) {
      if (!isUuid(ln.expense_account_id)) {
        return { error: `line ${lineNum}: expense_account_id must be a uuid` };
      }
      const amt = toBigIntCents(ln.amount_cents);
      if (amt.error) return { error: `line ${lineNum}: amount_cents — ${amt.error}` };
      if (amt.value <= 0n) return { error: `line ${lineNum}: amount_cents must be > 0` };

      normalizedLines.push({
        inventory_item_id: null,
        expense_account_id: ln.expense_account_id,
        quantity: 1,
        unit_cost_cents: amt.value.toString(),
        description: ln.description ? String(ln.description).trim() : null,
      });
    } else {
      return {
        error: `line ${lineNum}: must be either an inventory line (inventory_item_id + quantity + unit_cost_cents) or an expense line (expense_account_id + amount_cents)`,
      };
    }
  }

  return {
    data: {
      vendor_id: body.vendor_id,
      invoice_number: String(body.invoice_number).trim(),
      invoice_kind: kind,
      posting_date: body.posting_date,
      due_date: body.due_date || null,
      description: body.description ? String(body.description).trim() : null,
      expense_account_id: body.expense_account_id || null,
      ap_account_id: body.ap_account_id || null,
      lines: normalizedLines,
    },
  };
}

/**
 * Coerce a money-cents input (string or number) into BigInt cents. Rejects
 * negatives unless allow_negative is set (the caller checks the sign).
 */
function toBigIntCents(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { error: "missing" };
  }
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
