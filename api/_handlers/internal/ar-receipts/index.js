// api/internal/ar-receipts
//
// GET  — list AR receipts. Filters:
//          ?customer_id=<uuid>
//          ?method=<ach|wire|check|credit_card|cash|paypal|stripe|other>
//          ?from=<YYYY-MM-DD> / ?to=<YYYY-MM-DD>   (receipt_date window)
//          ?include_void=true                       (default false)
//          ?limit=N (default 100, max 500)
//          ?offset=N (default 0) — paginates per PostgREST 1000-row cap rule.
// POST — create a draft AR receipt (header + optional applications).
//          Body:
//            {
//              customer_id, receipt_date, amount_cents,
//              bank_account_id?, customer_payment_method,
//              reference?, notes?,
//              applications?: [
//                { ar_invoice_id, amount_applied_cents, notes? }
//              ]
//            }
//          The header is inserted first; then each application. If any
//          application insert fails, the header is rolled back (orphan
//          cleanup). The DB over-application guard rejects SUM(applied) >
//          receipt.amount_cents → surfaced as 409.
//
// Tangerine P4-5 (AR Receipts admin UI + handlers; arch §4.2, §6.4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ["ach", "wire", "check", "credit_card", "cash", "paypal", "stripe", "other"];

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
    .select("id, default_bank_account_id")
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
    const params = Object.fromEntries(url.searchParams.entries());
    const v = parseListQuery(params);
    if (v.error) return res.status(400).json({ error: v.error });

    const { customer_id, method, from, to, includeVoid, limit, offset } = v.data;

    let query = admin
      .from("ar_receipts")
      .select(
        "id, entity_id, customer_id, receipt_date, amount_cents, " +
        "bank_account_id, customer_payment_method, reference, notes, " +
        "accrual_je_id, cash_je_id, is_void, voided_at, void_reason, " +
        "created_at, updated_at",
      )
      .eq("entity_id", entityId)
      .order("receipt_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (customer_id) query = query.eq("customer_id", customer_id);
    if (method)      query = query.eq("customer_payment_method", method);
    if (from)        query = query.gte("receipt_date", from);
    if (to)          query = query.lte("receipt_date", to);
    if (!includeVoid) query = query.eq("is_void", false);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Best-effort enrichment with applied_cents per receipt for the ledger
    // view. Compute applied = SUM(amount_applied_cents) across this receipt's
    // application rows. Kept in JS to avoid a fragile view dependency.
    let appsByReceipt = {};
    const ids = (data || []).map((r) => r.id);
    if (ids.length > 0) {
      const { data: apps } = await admin
        .from("ar_receipt_applications")
        .select("ar_receipt_id, amount_applied_cents")
        .in("ar_receipt_id", ids);
      if (Array.isArray(apps)) {
        for (const a of apps) {
          const sum = appsByReceipt[a.ar_receipt_id] || 0n;
          appsByReceipt[a.ar_receipt_id] = sum + BigInt(a.amount_applied_cents || 0);
        }
      }
    }
    const enriched = (data || []).map((r) => {
      const applied = appsByReceipt[r.id] || 0n;
      const unapplied = BigInt(r.amount_cents || 0) - applied;
      return {
        ...r,
        applied_cents: applied.toString(),
        unapplied_cents: unapplied.toString(),
      };
    });
    return res.status(200).json(enriched);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Resolve bank account default if not supplied.
    const bankAccountId = v.data.bank_account_id || entity.default_bank_account_id;
    if (!bankAccountId) {
      return res.status(400).json({
        error: "bank_account_id is required (no entities.default_bank_account_id configured)",
      });
    }

    const insertHeader = {
      entity_id: entityId,
      customer_id: v.data.customer_id,
      receipt_date: v.data.receipt_date,
      amount_cents: v.data.amount_cents,
      bank_account_id: bankAccountId,
      customer_payment_method: v.data.customer_payment_method,
      reference: v.data.reference,
      notes: v.data.notes,
      created_by_user_id: v.data.created_by_user_id,
    };

    const { data: header, error: hErr } = await admin
      .from("ar_receipts")
      .insert(insertHeader)
      .select()
      .single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    // Insert applications one at a time so we know which one failed and can
    // orphan-clean the header rather than partially-applied.
    const insertedApps = [];
    for (let i = 0; i < v.data.applications.length; i++) {
      const app = v.data.applications[i];
      const { data: appRow, error: appErr } = await admin
        .from("ar_receipt_applications")
        .insert({
          ar_receipt_id: header.id,
          ar_invoice_id: app.ar_invoice_id,
          amount_applied_cents: app.amount_applied_cents,
          notes: app.notes,
          created_by_user_id: v.data.created_by_user_id,
        })
        .select()
        .single();
      if (appErr) {
        // Roll back: delete already-inserted apps and the header.
        for (const ins of insertedApps) {
          await admin.from("ar_receipt_applications").delete().eq("id", ins.id);
        }
        await admin.from("ar_receipts").delete().eq("id", header.id);

        // Surface the DB over-application guard as 409, else 400.
        const msg = appErr.message || "";
        if (appErr.code === "23514" || /over-application/i.test(msg)) {
          return res.status(409).json({
            error: `Application ${i + 1}: ${msg}`,
          });
        }
        if (appErr.code === "23505") {
          return res.status(409).json({
            error: `Application ${i + 1}: duplicate (ar_receipt, ar_invoice) pair`,
          });
        }
        return res.status(400).json({ error: `Application ${i + 1}: ${msg}` });
      }
      insertedApps.push(appRow);
    }

    // Re-read the header to return fresh state (paid_amount_cents on invoices
    // is trigger-maintained; the header itself has no derived fields, but
    // we return the inserted apps for client consumption).
    return res.status(201).json({
      ...header,
      applications: insertedApps,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function parseListQuery(params) {
  const customer_id = (params.customer_id || "").trim();
  const method      = (params.method || "").trim();
  const from        = (params.from || "").trim();
  const to          = (params.to || "").trim();
  const includeVoid = params.include_void === "true";

  let limit = parseInt(params.limit || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(params.offset || "0", 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (method && !METHODS.includes(method)) {
    return { error: `method must be one of ${METHODS.join(", ")}` };
  }
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return { error: "from must be YYYY-MM-DD" };
  }
  if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { error: "to must be YYYY-MM-DD" };
  }

  return {
    data: {
      customer_id: customer_id || null,
      method: method || null,
      from: from || null,
      to: to || null,
      includeVoid,
      limit,
      offset,
    },
  };
}

/**
 * Validate POST body for ar-receipts create-with-applications.
 *
 * Required:
 *   customer_id (uuid)
 *   receipt_date (YYYY-MM-DD)
 *   amount_cents (bigint, > 0)
 *   customer_payment_method (one of METHODS)
 *
 * Optional:
 *   bank_account_id (uuid) — defaults to entities.default_bank_account_id
 *   reference, notes (string)
 *   created_by_user_id (uuid)
 *   applications: [{ ar_invoice_id (uuid), amount_applied_cents (bigint > 0), notes? }]
 *     Sum of amount_applied_cents must be ≤ amount_cents (over-application).
 *     Under-application is allowed (creates an unapplied receipt visible in
 *     v_ar_unapplied_receipts).
 *     If omitted or empty, the receipt is created as fully-unapplied.
 */
export function validateInsert(body) {
  if (!body.customer_id || !UUID_RE.test(body.customer_id)) {
    return { error: "customer_id (uuid) is required" };
  }
  if (!body.receipt_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.receipt_date)) {
    return { error: "receipt_date must be YYYY-MM-DD" };
  }
  const amt = toBigIntCents(body.amount_cents);
  if (amt.error) return { error: `amount_cents — ${amt.error}` };
  if (amt.value <= 0n) return { error: "amount_cents must be > 0" };

  if (!body.customer_payment_method || !METHODS.includes(body.customer_payment_method)) {
    return { error: `customer_payment_method must be one of ${METHODS.join(", ")}` };
  }
  if (body.bank_account_id && !UUID_RE.test(body.bank_account_id)) {
    return { error: "bank_account_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }

  const applications = [];
  const rawApps = Array.isArray(body.applications) ? body.applications : [];
  let appSumCents = 0n;
  const seenInvoiceIds = new Set();

  for (let i = 0; i < rawApps.length; i++) {
    const a = rawApps[i] || {};
    if (!a.ar_invoice_id || !UUID_RE.test(a.ar_invoice_id)) {
      return { error: `applications[${i}].ar_invoice_id must be a uuid` };
    }
    if (seenInvoiceIds.has(a.ar_invoice_id)) {
      return { error: `applications[${i}].ar_invoice_id: duplicate (same invoice listed twice)` };
    }
    seenInvoiceIds.add(a.ar_invoice_id);

    const cents = toBigIntCents(a.amount_applied_cents);
    if (cents.error) return { error: `applications[${i}].amount_applied_cents — ${cents.error}` };
    if (cents.value <= 0n) return { error: `applications[${i}].amount_applied_cents must be > 0` };

    appSumCents += cents.value;
    applications.push({
      ar_invoice_id: a.ar_invoice_id,
      amount_applied_cents: cents.value.toString(),
      notes: a.notes ? String(a.notes).trim() : null,
    });
  }

  if (appSumCents > amt.value) {
    return {
      error: `applications total (${appSumCents}) exceeds receipt amount_cents (${amt.value})`,
    };
  }

  return {
    data: {
      customer_id: body.customer_id,
      receipt_date: body.receipt_date,
      amount_cents: amt.value.toString(),
      bank_account_id: body.bank_account_id || null,
      customer_payment_method: body.customer_payment_method,
      reference: body.reference ? String(body.reference).trim() : null,
      notes: body.notes ? String(body.notes).trim() : null,
      created_by_user_id: body.created_by_user_id || null,
      applications,
    },
  };
}

function toBigIntCents(raw) {
  if (raw === null || raw === undefined || raw === "") return { error: "required" };
  if (typeof raw === "bigint") return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { error: "not finite" };
    if (!Number.isInteger(raw)) return { error: "must be integer cents" };
    return { value: BigInt(raw) };
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!/^-?\d+$/.test(s)) return { error: `invalid integer cents: ${raw}` };
    try { return { value: BigInt(s) }; } catch { return { error: "could not parse" }; }
  }
  return { error: "must be number or string of integer cents" };
}
