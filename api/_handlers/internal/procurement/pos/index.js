// api/internal/procurement/pos
//
// Tangerine P13-3 — Procurement PO origination handler (M11).
//
// GET   — list tanda_pos rows filtered to procurement_status IN
//         ('draft','pending_approval','approved','open') by default.
//         Optional query:
//           ?status=<draft|pending_approval|approved|open|received|cancelled>
//           ?vendor_id=<uuid>
//           ?pilot=true   (filter to D18 pilot vendor flag)
//           ?from / ?to   (date window on date_order)
//           ?q=<search>   (po_number ilike)
//           ?limit=N      (default 200, max 500)
//           ?include_terminal=true (include received/closed/cancelled rows)
// POST  — create a draft Tangerine-originated PO. Body:
//           {
//             vendor_id, po_number (optional — auto-gen ROF-Pnnnnnn),
//             date_order?, date_expected?, buyer_po?, buyer_name?,
//             expected_landed_cost_cents (required — D9 strict),
//             pilot_vendor_flag?, notes?,
//             lines: [
//               { item_number?, description?, qty_ordered, unit_price_dollars, unit_cost_dollars? }
//             ]
//           }
//
// Per the dispatcher pattern, path params arrive on req.query.* (e.g.
// req.query.id for the [id] route). See api/_handlers/routes.js.
//
// FK note: tanda_po_receipts.tanda_po_id references tanda_pos.id (uuid PK
// per the T5 backfill CREATE TABLE migration). We use tanda_pos.id throughout
// this handler — NOT tanda_pos.uuid_id (legacy bigint-era column).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["draft", "pending_approval", "approved", "open", "received", "closed", "cancelled"];
const ACTIVE_STATUSES = ["draft", "pending_approval", "approved", "open"];

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
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data?.id || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const status      = (url.searchParams.get("status") || "").trim();
    const vendorId    = (url.searchParams.get("vendor_id") || "").trim();
    const pilot       = url.searchParams.get("pilot") === "true";
    const from        = (url.searchParams.get("from") || "").trim();
    const to          = (url.searchParams.get("to") || "").trim();
    const q           = (url.searchParams.get("q") || "").trim();
    const includeTerm = url.searchParams.get("include_terminal") === "true";
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (Number.isNaN(limit) || limit < 1) limit = 200;
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
      .from("tanda_pos")
      .select(
        "id, po_number, vendor, vendor_id, buyer_po, buyer_name, " +
        "date_order, date_expected, status, procurement_status, " +
        "expected_landed_cost_cents, actual_landed_cost_cents, " +
        "pilot_vendor_flag, originated_by_employee_id, " +
        "synced_at, created_at, updated_at"
      )
      .order("date_order", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      query = query.eq("procurement_status", status);
    } else if (!includeTerm) {
      query = query.in("procurement_status", ACTIVE_STATUSES);
    }
    if (vendorId) query = query.eq("vendor_id", vendorId);
    if (pilot)    query = query.eq("pilot_vendor_flag", true);
    if (from)     query = query.gte("date_order", from);
    if (to)       query = query.lte("date_order", to);
    if (q)        query = query.ilike("po_number", `%${q}%`);

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
    const v = validatePoInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const entityId = await resolveDefaultEntity(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    // Auto-generate po_number if missing. Pattern: ROF-PNNNNNN counter on
    // existing po_numbers starting with 'ROF-P'. Best-effort uniqueness — a
    // unique-constraint violation re-runs once with the next available.
    let poNumber = v.data.po_number;
    if (!poNumber) {
      const { data: maxRow } = await admin
        .from("tanda_pos")
        .select("po_number")
        .ilike("po_number", "ROF-P%")
        .order("po_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      let next = 1;
      const match = maxRow?.po_number?.match(/^ROF-P(\d+)$/);
      if (match) next = parseInt(match[1], 10) + 1;
      poNumber = `ROF-P${String(next).padStart(6, "0")}`;
    }

    const insertRow = {
      entity_id: entityId,
      po_number: poNumber,
      vendor: v.data.vendor_name || "",
      vendor_id: v.data.vendor_id,
      buyer_po: v.data.buyer_po,
      buyer_name: v.data.buyer_name,
      date_order: v.data.date_order,
      date_expected: v.data.date_expected,
      status: "",
      procurement_status: "draft",
      expected_landed_cost_cents: v.data.expected_landed_cost_cents,
      pilot_vendor_flag: !!v.data.pilot_vendor_flag,
      originated_by_employee_id: v.data.originated_by_employee_id,
      data: {},
    };

    const { data: header, error: hErr } = await admin
      .from("tanda_pos")
      .insert(insertRow)
      .select()
      .single();
    if (hErr) {
      if (hErr.code === "23505") {
        return res.status(409).json({ error: `PO number ${poNumber} already exists` });
      }
      return res.status(500).json({ error: hErr.message });
    }

    // Insert line items.
    if (v.data.lines.length > 0) {
      const lineRows = v.data.lines.map((ln, idx) => ({
        po_id: header.id,
        line_index: idx + 1,
        item_number: ln.item_number,
        description: ln.description,
        qty_ordered: ln.qty_ordered,
        qty_remaining: ln.qty_ordered,
        unit_price: ln.unit_price,
        line_total: (ln.unit_price || 0) * (ln.qty_ordered || 0),
      }));
      const { error: lErr } = await admin
        .from("po_line_items")
        .insert(lineRows);
      if (lErr) {
        // Rollback header to avoid orphan
        await admin.from("tanda_pos").delete().eq("id", header.id);
        return res.status(500).json({ error: `Failed to insert lines: ${lErr.message}` });
      }
    }

    return res.status(201).json(header);
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

export function validatePoInsert(body) {
  if (!body.vendor_id || !isUuid(body.vendor_id)) {
    return { error: "vendor_id (uuid) is required" };
  }
  if (body.po_number !== undefined && body.po_number !== null && body.po_number !== "") {
    if (typeof body.po_number !== "string" || !body.po_number.trim()) {
      return { error: "po_number must be a non-empty string when provided" };
    }
  }
  // D9 strict: expected_landed_cost_cents is REQUIRED on PO creation.
  const elc = parseCents(body.expected_landed_cost_cents);
  if (elc.error) return { error: `expected_landed_cost_cents — ${elc.error}` };
  if (elc.value < 0n) return { error: "expected_landed_cost_cents must be >= 0" };

  if (body.date_order && !/^\d{4}-\d{2}-\d{2}$/.test(body.date_order)) {
    return { error: "date_order must be YYYY-MM-DD" };
  }
  if (body.date_expected && !/^\d{4}-\d{2}-\d{2}$/.test(body.date_expected)) {
    return { error: "date_expected must be YYYY-MM-DD" };
  }
  if (body.originated_by_employee_id && !isUuid(body.originated_by_employee_id)) {
    return { error: "originated_by_employee_id must be a uuid" };
  }
  if (!Array.isArray(body.lines)) {
    return { error: "lines must be an array" };
  }

  const lines = [];
  for (let i = 0; i < body.lines.length; i++) {
    const ln = body.lines[i] || {};
    const qty = Number(ln.qty_ordered);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { error: `line ${i + 1}: qty_ordered must be > 0` };
    }
    const price = Number(ln.unit_price_dollars ?? ln.unit_price);
    if (!Number.isFinite(price) || price < 0) {
      return { error: `line ${i + 1}: unit_price_dollars must be >= 0` };
    }
    lines.push({
      item_number: ln.item_number ? String(ln.item_number).trim() : null,
      description: ln.description ? String(ln.description).trim() : null,
      qty_ordered: qty,
      unit_price: price,
    });
  }

  return {
    data: {
      vendor_id: body.vendor_id,
      vendor_name: body.vendor_name ? String(body.vendor_name).trim() : null,
      po_number: body.po_number ? String(body.po_number).trim() : null,
      buyer_po: body.buyer_po ? String(body.buyer_po).trim() : null,
      buyer_name: body.buyer_name ? String(body.buyer_name).trim() : null,
      date_order: body.date_order || null,
      date_expected: body.date_expected || null,
      expected_landed_cost_cents: elc.value.toString(),
      pilot_vendor_flag: !!body.pilot_vendor_flag,
      originated_by_employee_id: body.originated_by_employee_id || null,
      lines,
    },
  };
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
