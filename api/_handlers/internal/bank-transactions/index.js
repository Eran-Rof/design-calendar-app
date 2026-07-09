// api/internal/bank-transactions
//
// GET — list bank_transactions for the default entity.
// Query: ?bank_account_id, ?status (unmatched|matched|...|all),
//        ?from=YYYY-MM-DD, ?to=YYYY-MM-DD, ?limit=N (default 200, max 1000)
//
// Drill-through Phase 2: each row also carries
//   • bank_accounts.gl_account_id + gl_accounts(code, name) — so the UI can
//     open a filtered GL-detail window for the txn's bank GL account, and
//   • matched_je { id, je_number, description, status } resolved from
//     matched_je_line_id — so matched / manual_je_created rows jump straight
//     to the journal entry (Phase 1 JEDetailModal).
//
// Tangerine P6-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_VALUES = ["unmatched", "matched", "manual_je_created", "ignored", "reversed"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }
export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function parseListQuery(params) {
  const out = { bank_account_id: null, status: "unmatched", from: null, to: null, limit: 200 };
  const ba = (params.get("bank_account_id") || "").trim();
  if (ba) {
    if (!isUuid(ba)) return { error: "bank_account_id must be UUID" };
    out.bank_account_id = ba;
  }
  const st = (params.get("status") || "").trim();
  if (st) {
    if (st !== "all" && !STATUS_VALUES.includes(st)) {
      return { error: `status must be 'all' or one of ${STATUS_VALUES.join(", ")}` };
    }
    out.status = st;
  }
  const from = (params.get("from") || "").trim();
  if (from) {
    if (!isISODate(from)) return { error: "from must be YYYY-MM-DD" };
    out.from = from;
  }
  const to = (params.get("to") || "").trim();
  if (to) {
    if (!isISODate(to)) return { error: "to must be YYYY-MM-DD" };
    out.to = to;
  }
  const lim = (params.get("limit") || "").trim();
  if (lim) {
    const n = parseInt(lim, 10);
    if (!Number.isFinite(n) || n < 1) return { error: "limit must be positive integer" };
    out.limit = Math.min(n, 1000);
  }
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = parseListQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  let q = admin
    .from("bank_transactions")
    .select(
      "id, bank_account_id, source, external_txn_id, posted_date, amount_cents, " +
      "description, merchant_name, pending, status, matched_je_line_id, matched_at, " +
      "match_confidence, notes, created_at, " +
      "bank_accounts(name, mask, institution_name, gl_account_id, gl_accounts(code, name))",
    )
    .eq("entity_id", entity.id)
    .order("posted_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(v.data.limit);
  if (v.data.bank_account_id) q = q.eq("bank_account_id", v.data.bank_account_id);
  if (v.data.status !== "all") q = q.eq("status", v.data.status);
  if (v.data.from) q = q.gte("posted_date", v.data.from);
  if (v.data.to)   q = q.lte("posted_date", v.data.to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Drill-through Phase 2 — resolve matched JE line ids to their JE header so
  // the panel links matched rows to the entry (no second round-trip client-side).
  const rows = data || [];
  const lineIds = [...new Set(rows.map((r) => r.matched_je_line_id).filter(Boolean))];
  const jeByLineId = new Map();
  for (let i = 0; i < lineIds.length; i += 200) {
    const chunk = lineIds.slice(i, i + 200);
    const { data: lines, error: lineErr } = await admin
      .from("journal_entry_lines")
      .select("id, journal_entry_id, journal_entries(id, je_number, description, status)")
      .in("id", chunk);
    if (lineErr) return res.status(500).json({ error: lineErr.message });
    for (const ln of lines || []) {
      if (ln.journal_entries) {
        jeByLineId.set(ln.id, {
          id: ln.journal_entries.id,
          je_number: ln.journal_entries.je_number || null,
          description: ln.journal_entries.description || null,
          status: ln.journal_entries.status || null,
        });
      }
    }
  }
  for (const r of rows) {
    r.matched_je = r.matched_je_line_id ? (jeByLineId.get(r.matched_je_line_id) || null) : null;
  }

  return res.status(200).json(rows);
}
