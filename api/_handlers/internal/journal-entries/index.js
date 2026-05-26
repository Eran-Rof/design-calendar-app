// api/internal/journal-entries
//
// GET  — list JEs. Default returns posted only; ?include_drafts=true for all.
//        Query: ?period_id=<uuid>, ?basis=ACCRUAL|CASH, ?source_table=<str>,
//        ?source_id=<str>, ?limit=N (default 100, max 500)
// POST — accountant-authored manual JE. Calls the existing gl_post_journal_entry
//        RPC (atomic; the Chunk 2 trigger validates balance/period/control on
//        commit). Body: { basis: ACCRUAL|CASH|BOTH, posting_date, description,
//        lines: [{ line_number, account_id, debit, credit, memo?, subledger_type?, subledger_id? }] }.
//        BOTH posts two sibling JEs (one ACCRUAL, one CASH) with identical lines
//        and links via gl_link_sibling_je.
//
// Tangerine P1 Chunk 8c. Wraps Chunk 3's posting service from the accountant UI.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const BASIS_VALUES = ["ACCRUAL", "CASH"];

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

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const periodId    = (url.searchParams.get("period_id") || "").trim();
    const basis       = (url.searchParams.get("basis") || "").trim();
    const srcTable    = (url.searchParams.get("source_table") || "").trim();
    const srcId       = (url.searchParams.get("source_id") || "").trim();
    const includeDrafts = url.searchParams.get("include_drafts") === "true";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

    let query = admin
      .from("journal_entries")
      .select("id, entity_id, period_id, basis, journal_type, posting_date, source_module, source_table, source_id, description, status, posted_at, sibling_je_id, reversed_by_je_id, reverses_je_id, created_at")
      .eq("entity_id", entityId)
      .order("posting_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!includeDrafts) query = query.eq("status", "posted");
    if (periodId)       query = query.eq("period_id", periodId);
    if (basis)          query = query.eq("basis", basis);
    if (srcTable)       query = query.eq("source_table", srcTable);
    if (srcId)          query = query.eq("source_id", srcId);

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
    const v = validateManualPost(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Build the payload(s) — BOTH expands to two RPC calls; single-basis is one.
    const bases = v.data.basis === "BOTH" ? ["ACCRUAL", "CASH"] : [v.data.basis];
    const journalType = v.data.journal_type || "manual";
    const description = v.data.description;

    const payloadFor = (basis) => ({
      entity_id: entityId,
      basis,
      journal_type: journalType,
      posting_date: v.data.posting_date,
      source_module: "manual",
      source_table: null,
      source_id: null,
      description,
      sibling_je_id: null,
      created_by_user_id: null,
      lines: v.data.lines,
    });

    const jeIds = [];
    try {
      for (const b of bases) {
        const { data, error } = await admin.rpc("gl_post_journal_entry", { payload: payloadFor(b) });
        if (error) {
          // If the second call fails after the first succeeded, the first is left
          // posted. The caller can see this via the partial response and reverse.
          return res.status(400).json({
            error: `Posting failed on basis=${b}: ${error.message}`,
            partial: jeIds,
          });
        }
        jeIds.push({ basis: b, je_id: data });
      }
      // If BOTH, link the sibling pair.
      if (jeIds.length === 2) {
        const { error } = await admin.rpc("gl_link_sibling_je", {
          je_a: jeIds[0].je_id,
          je_b: jeIds[1].je_id,
        });
        if (error) return res.status(500).json({ error: `Sibling link failed: ${error.message}`, posted: jeIds });
      }
      return res.status(201).json({ posted: jeIds });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateManualPost(body) {
  if (!body.basis) return { error: "basis is required (ACCRUAL | CASH | BOTH)" };
  if (!["ACCRUAL", "CASH", "BOTH"].includes(body.basis)) {
    return { error: "basis must be ACCRUAL, CASH, or BOTH" };
  }
  if (!body.posting_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.posting_date)) {
    return { error: "posting_date must be YYYY-MM-DD" };
  }
  if (!body.description || !String(body.description).trim()) {
    return { error: "description is required" };
  }
  if (body.journal_type != null && typeof body.journal_type !== "string") {
    return { error: "journal_type must be a string" };
  }
  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    return { error: "lines must be an array of at least 2 entries" };
  }

  // Per-line validation + balance check (BigInt cents, matches api/_lib/money.js + posting/balanced.js)
  let debitCents = 0n;
  let creditCents = 0n;
  for (const line of body.lines) {
    if (!line.line_number || !Number.isInteger(line.line_number) || line.line_number < 1) {
      return { error: "every line needs an integer line_number >= 1" };
    }
    if (!line.account_id || !/^[0-9a-f-]{36}$/i.test(line.account_id)) {
      return { error: `line ${line.line_number}: account_id must be a uuid` };
    }
    const d = toCents(line.debit, `line ${line.line_number} debit`);
    const c = toCents(line.credit, `line ${line.line_number} credit`);
    if (d.error) return d;
    if (c.error) return c;
    if (d.cents > 0n && c.cents > 0n) {
      return { error: `line ${line.line_number}: cannot have both debit and credit nonzero` };
    }
    if (d.cents === 0n && c.cents === 0n) {
      return { error: `line ${line.line_number}: at least one of debit/credit must be nonzero` };
    }
    if (d.cents < 0n || c.cents < 0n) {
      return { error: `line ${line.line_number}: negative amounts not allowed` };
    }
    debitCents  += d.cents;
    creditCents += c.cents;

    // subledger pairing
    const sType = line.subledger_type;
    const sId   = line.subledger_id;
    if ((sType && !sId) || (!sType && sId)) {
      return { error: `line ${line.line_number}: subledger_type and subledger_id must be both set or both empty` };
    }
  }
  if (debitCents !== creditCents) {
    return {
      error: `Unbalanced: debits=${centsToStr(debitCents)} credits=${centsToStr(creditCents)}`,
    };
  }
  if (debitCents === 0n) {
    return { error: "Total debits/credits cannot be zero" };
  }

  return {
    data: {
      basis: body.basis,
      posting_date: body.posting_date,
      description: String(body.description).trim(),
      journal_type: body.journal_type,
      lines: body.lines.map((l) => ({
        line_number:    l.line_number,
        account_id:     l.account_id,
        debit:          String(l.debit ?? "0"),
        credit:         String(l.credit ?? "0"),
        memo:           l.memo ?? null,
        subledger_type: l.subledger_type || null,
        subledger_id:   l.subledger_id || null,
      })),
    },
  };
}

function toCents(s, label) {
  if (s == null || s === "") return { cents: 0n };
  const str = typeof s === "string" ? s.trim() : String(s);
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(str)) {
    return { error: `${label}: invalid money value "${s}"` };
  }
  const neg = str.startsWith("-");
  const u = neg ? str.slice(1) : str;
  const [whole, frac = ""] = u.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(padded);
  return { cents: neg ? -cents : cents };
}

function centsToStr(cents) {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
