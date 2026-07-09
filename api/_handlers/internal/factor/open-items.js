// api/internal/factor/open-items
//
// Factor Module Phase 1 (Rosenthal) — GET the month-end open-AR detail
// (factor_ar_open_items, from the FACTORED AR DETAILED report).
//
// Query params (one of):
//   as_of = YYYY-MM-DD  — exact report as-of date
//   month = YYYY-MM     — resolves to the LATEST as_of inside that month
//                         (Rosenthal runs the report on the last business
//                         day, e.g. 8/29 for August)
//   (none)              — returns { dates: [...] } of distinct as-of dates
//
// Response: { as_of, rows } — rows carry the invoice-grain columns plus the
// linked customer_id (nullable). Explicit .range() sidesteps the PostgREST
// 1000-row default cap (a month currently carries ~200-260 rows).
//
// Auth: authenticateInternalCaller like sibling /api/internal handlers.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_RE = /^\d{4}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function distinctAsOfDates(admin) {
  // Small table (one batch of rows per month) — read the column and dedupe.
  const { data, error } = await admin
    .from("factor_ar_open_items")
    .select("as_of_date")
    .order("as_of_date", { ascending: true })
    .range(0, 49999);
  if (error) throw new Error(error.message);
  return [...new Set((data || []).map((r) => r.as_of_date))];
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const asOfParam = (url.searchParams.get("as_of") || "").trim();
  const monthParam = (url.searchParams.get("month") || "").trim();

  try {
    let asOf = null;
    if (asOfParam) {
      if (!ISO_DATE_RE.test(asOfParam)) return res.status(400).json({ error: "as_of must be YYYY-MM-DD" });
      asOf = asOfParam;
    } else if (monthParam) {
      if (!ISO_MONTH_RE.test(monthParam)) return res.status(400).json({ error: "month must be YYYY-MM" });
      const dates = await distinctAsOfDates(admin);
      asOf = dates.filter((d) => d.startsWith(`${monthParam}-`)).pop() || null;
      if (!asOf) return res.status(200).json({ as_of: null, rows: [] });
    } else {
      const dates = await distinctAsOfDates(admin);
      return res.status(200).json({ dates });
    }

    const { data, error } = await admin
      .from("factor_ar_open_items")
      .select("as_of_date, factor_customer_no, customer_name, item_num, item_type, po_num, item_date, due_date, terms, gross_amt_cents, item_balance_cents, customer_id")
      .eq("as_of_date", asOf)
      .order("customer_name", { ascending: true })
      .order("due_date", { ascending: true, nullsFirst: true })
      .order("item_num", { ascending: true })
      .range(0, 9999); // explicit — PostgREST silently caps at 1000 otherwise
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ as_of: asOf, rows: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
