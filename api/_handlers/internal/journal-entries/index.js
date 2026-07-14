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

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { applyBrandScope } from "../../../_lib/brandContext.js";
import { expandJeLines } from "../../../_lib/glAllocation.js";
import { requestIfRequired } from "../../../_lib/approvals/index.js";
import {
  extractActorFromRequest,
  setAuditSessionVars,
  requireReason,
} from "../../../_lib/audit/withAuditContext.js";

export const config = { maxDuration: 15 };

const BASIS_VALUES = ["ACCRUAL", "CASH"];
const SOURCE_VALUES = [
  "manual", "xoro_mirror", "shopify", "fba", "walmart",
  "faire", "edi_3pl", "plaid_sync", "api", "system",
];

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
    const source      = (url.searchParams.get("source") || "").trim();
    const includeDrafts = url.searchParams.get("include_drafts") === "true";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

    if (source && !SOURCE_VALUES.includes(source)) {
      return res.status(400).json({ error: `source must be one of ${SOURCE_VALUES.join(", ")}` });
    }

    let query = admin
      .from("journal_entries")
      .select("id, je_number, entity_id, period_id, basis, journal_type, posting_date, source_module, source_table, source_id, source, description, status, posted_at, sibling_je_id, reversed_by_je_id, reverses_je_id, created_at, posted_by_user_id, created_by_user_id")
      .eq("entity_id", entityId)
      .order("posting_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    // P15 C3 — brand scoping (no-op unless BRAND_SCOPE_MODE=enforce + a brand selected).
    query = applyBrandScope(query, req);

    if (!includeDrafts) query = query.eq("status", "posted");
    if (periodId)       query = query.eq("period_id", periodId);
    if (basis)          query = query.eq("basis", basis);
    if (srcTable)       query = query.eq("source_table", srcTable);
    if (srcId)          query = query.eq("source_id", srcId);
    if (source)         query = query.eq("source", source);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Resolve who posted / created each JE to a display name so the detail
    // modal can show "Posted at <time> by <name>". v_audit_user_resolved maps
    // auth.users → employees.display_name (email fallback). Best-effort: on any
    // failure the rows still return, just without the *_by_name fields.
    const rows = data || [];
    const userIds = Array.from(new Set(
      rows.flatMap((r) => [r.posted_by_user_id, r.created_by_user_id]).filter(Boolean),
    ));
    if (userIds.length > 0) {
      try {
        const { data: users } = await admin
          .from("v_audit_user_resolved")
          .select("user_id, display_name, email")
          .in("user_id", userIds);
        const nameById = Object.fromEntries(
          (users || []).map((u) => [u.user_id, u.display_name || u.email || null]),
        );
        for (const r of rows) {
          r.posted_by_name = r.posted_by_user_id ? (nameById[r.posted_by_user_id] || null) : null;
          r.created_by_name = r.created_by_user_id ? (nameById[r.created_by_user_id] || null) : null;
        }
      } catch { /* non-fatal — omit names */ }
    }
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateManualPost(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // T11 D3: reason REQUIRED on POST. gl_post_journal_entry flips
    // status='posted' which the audit_row_changes_trigger detects as POST.
    const reason = body?.reason ? String(body.reason).trim() : null;
    const reasonGate = requireReason("POST", reason);
    if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

    const actor = await extractActorFromRequest(req, admin);
    // Maker identity for the segregation-of-duties gate. The SPA fetch shim
    // (src/utils/internalApiAuth.ts) injects X-Auth-User-Id on every
    // /api/internal/** call, so that header is the reliable maker id in this
    // deployment (the per-user Supabase JWT is optional).
    const makerAuthId =
      headerStr(req.headers?.["x-auth-user-id"]) || actor.auth_id || null;
    const correlation_id =
      req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;

    // ── Maker/checker gate (HUMAN manual path only) ─────────────────────────
    // This endpoint IS the human "post a manual JE" path (source_module=
    // 'manual'). Automated posters — the Xoro mirror, crons, backfill scripts,
    // and audit_source='migration' SQL — call gl_post_journal_entry directly
    // and never reach this handler, so they are inherently exempt. If an active
    // approval_rule matches the JE's total debits, hold the post and open an
    // approval_request instead of writing the ledger. The JE only posts once a
    // DIFFERENT authorized user approves (see decide.js je_manual_post hook).
    const totalDebitCents = sumDebitCents(v.data.lines);
    let gate = { required: false };
    try {
      gate = await requestIfRequired(admin, {
        kind: "je_manual_post",
        entity_id: entityId,
        context_table: "journal_entries",
        // No JE row exists yet (we post only on approval). Use a synthetic id;
        // the decide hook rewrites context_id to the real JE id once posted so
        // JEDetailModal can render the approval history against the posted JE.
        context_id: randomUUID(),
        amount_cents: Number(totalDebitCents),
        currency: "USD",
        source_kind: "manual",
        payload: {
          entity_id: entityId,
          basis: v.data.basis,
          journal_type: v.data.journal_type || "manual",
          posting_date: v.data.posting_date,
          description: v.data.description,
          reason,
          lines: v.data.lines,
          total_debit_cents: totalDebitCents.toString(),
          created_by_user_id: makerAuthId,
        },
        created_by_user_id: makerAuthId,
      });
    } catch (e) {
      return res.status(500).json({
        error: `Approval routing failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (gate.required) {
      return res.status(202).json({
        requires_approval: true,
        approval_request_id: gate.request_id,
        status: "pending_approval",
        message:
          "This journal entry is at or above the approval threshold and was submitted for approval. It will post once a different authorized user approves it.",
      });
    }

    // Below threshold — post immediately (unchanged behavior).
    const result = await postManualJournalEntry(admin, {
      entityId,
      data: v.data,
      reason,
      actor,
      correlation_id,
    });
    return res.status(result.status).json(result.body);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// Post a validated manual JE to the ledger. Shared by the direct (below
// threshold) handler path AND the approvals decide-hook (once a gated JE has
// been approved). Returns { status, body } so both callers can relay it.
//
// T11-2 audit context is best-effort here (the manual JE flow's documented v1
// gap re: PostgREST connection pooling — the trigger's audit_trigger_failure
// path records missing context). `actor` is { auth_id, employee_id,
// display_name } (may be all-null for service callers).
export async function postManualJournalEntry(admin, { entityId, data, reason, actor, correlation_id }) {
  const safeActor = actor || { auth_id: null, employee_id: null, display_name: null };
  try {
    await setAuditSessionVars(admin, {
      actor: safeActor,
      reason,
      source: "manual",
      correlation_id: correlation_id || null,
    });
  } catch (e) {
    console.warn(
      "[je-post] setAuditSessionVars failed (best-effort):",
      e instanceof Error ? e.message : String(e),
    );
  }

  // M50 C — split any brand-rollup account line into its brand-child accounts
  // by the allocation %. No-op unless BRAND_SCOPE_MODE=enforce. Stays balanced.
  const postLines = await expandJeLines(admin, data.lines);

  const bases = data.basis === "BOTH" ? ["ACCRUAL", "CASH"] : [data.basis];
  const journalType = data.journal_type || "manual";
  const payloadFor = (basis) => ({
    entity_id: entityId,
    basis,
    journal_type: journalType,
    posting_date: data.posting_date,
    source_module: "manual",
    source_table: null,
    source_id: null,
    description: data.description,
    sibling_je_id: null,
    created_by_user_id: safeActor.auth_id || null,
    lines: postLines,
  });

  const jeIds = [];
  try {
    for (const b of bases) {
      const { data: jeId, error } = await admin.rpc("gl_post_journal_entry", { payload: payloadFor(b) });
      if (error) {
        // If the second call fails after the first succeeded, the first is left
        // posted. The caller can see this via the partial response and reverse.
        return { status: 400, body: { error: `Posting failed on basis=${b}: ${error.message}`, partial: jeIds } };
      }
      jeIds.push({ basis: b, je_id: jeId });
    }
    if (jeIds.length === 2) {
      const { error } = await admin.rpc("gl_link_sibling_je", { je_a: jeIds[0].je_id, je_b: jeIds[1].je_id });
      if (error) return { status: 500, body: { error: `Sibling link failed: ${error.message}`, posted: jeIds } };
    }
    return { status: 201, body: { posted: jeIds } };
  } catch (e) {
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}

// Coerce a possibly-array header value to a trimmed string (or null).
function headerStr(v) {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

// Sum the debit side of validated lines, in integer cents (BigInt). Used to
// drive the approval-rule amount matcher.
function sumDebitCents(lines) {
  let total = 0n;
  for (const l of lines || []) {
    const c = toCents(l.debit, "debit");
    if (!c.error) total += c.cents;
  }
  return total;
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
        memo_line_2:    l.memo_line_2 ?? null,
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
