// api/internal/journal-entries/:id/reverse
//
// POST — reverse a posted JE. Creates a new JE with negated lines (debit↔credit),
// flips the original to status='reversed', cross-links via reverses_je_id /
// reversed_by_je_id. Wraps the Chunk 3 reverseJournalEntry helper.
//
// Optional body: { posting_date?, description?, created_by_user_id? }
//
// Tangerine P1 Chunk 8c.

import { createClient } from "@supabase/supabase-js";
import { reverseJournalEntry } from "../../../_lib/accounting/posting/reverse.js";
import {
  extractActorFromRequest,
  callWithAudit,
  requireReason,
} from "../../../_lib/audit/withAuditContext.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { body = {}; }
  }
  const reason = body?.reason ? String(body.reason).trim() : null;

  // T11 D3: reason REQUIRED on REVERSE.
  const reasonGate = requireReason("REVERSE", reason);
  if (reasonGate) return res.status(reasonGate.status).json({ error: reasonGate.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const opts = {};
    if (body?.posting_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.posting_date)) {
        return res.status(400).json({ error: "posting_date must be YYYY-MM-DD" });
      }
      opts.posting_date = body.posting_date;
    }
    if (body?.description) opts.description = String(body.description).trim();
    if (body?.created_by_user_id) opts.created_by_user_id = body.created_by_user_id;

    const newJeId = await reverseJournalEntry(admin, id, opts);

    // T11-2 audit stamp — call reverse_journal_entry_with_audit on the
    // original JE so the status='reversed' flip carries the audit context
    // through to the trigger. reverseJournalEntry above creates the
    // reversal JE and (in current impl) flips the original; this RPC
    // re-asserts the status under the audit-aware path. When the
    // original is already 'reversed', the RPC returns its
    // invalid_transaction_state error which we treat as success since
    // the audit row was already written by the JS-side flip.
    try {
      const actor = await extractActorFromRequest(req, admin);
      const correlation_id =
        req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || null;
      await callWithAudit(admin, "reverse_journal_entry_with_audit", {
        je_id: id,
        reversal_je_id: newJeId,
        actor,
        reason,
        source: "manual",
        correlation_id,
      });
    } catch (auditErr) {
      // Non-fatal — the reversal itself succeeded. Log so we notice if
      // the audit path drifts out of sync with the JS-side reversal.
      console.warn(
        "[je-reverse] audit stamp failed (reversal already applied):",
        auditErr instanceof Error ? auditErr.message : String(auditErr),
      );
    }

    return res.status(201).json({ reversal_je_id: newJeId, original_je_id: id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
    if (/status/i.test(msg))    return res.status(409).json({ error: msg });
    return res.status(400).json({ error: msg });
  }
}
