// api/internal/procurement/qc-inspections/[id]
//
// Tangerine P13-5 — M26 QC inspection detail + update.
//
// GET   — return inspection header + findings array + receipt + PO context.
// PATCH — update inspection. Supports:
//           - status transition (pending → passed/failed/partial; partial → passed/failed)
//           - inspector_employee_id, inspection_date, overall_pass_rate, notes
//           - if status moves to 'failed' AND inspection has any
//             severity='critical' findings, the handler auto-creates a
//             case (M47/P7-9) with subject
//             "QC failure — PO {po_number} — {N} critical findings" and
//             writes case_id back onto the inspection row.

import { createClient } from "@supabase/supabase-js";
import { nextCaseNumber } from "../../cases/index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["pending", "passed", "failed", "partial"];

// Allowed transitions — pending can go anywhere; partial can resolve;
// passed/failed are sticky (operator can re-open by going back to pending
// via the dedicated reopen path which is not in scope for this chunk).
const ALLOWED_TRANSITIONS = {
  pending: new Set(["passed", "failed", "partial"]),
  partial: new Set(["passed", "failed"]),
  passed:  new Set([]),
  failed:  new Set([]),
};

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
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

  const { data: insp, error: fetchErr } = await admin
    .from("tanda_po_qc_inspections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!insp) return res.status(404).json({ error: "Inspection not found" });

  if (req.method === "GET") {
    const { data: findings } = await admin
      .from("tanda_po_qc_findings")
      .select("*")
      .eq("inspection_id", id)
      .order("created_at");
    return res.status(200).json({ ...insp, findings: findings || [] });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInspectionPatch(body || {}, insp.status);
    if (v.error) return res.status(400).json({ error: v.error });

    const update = { ...v.data };
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    // Failed-inspection auto-case (M47/P7-9 integration) — only fires the
    // FIRST time we move into 'failed' AND only when there is at least one
    // severity='critical' finding. case_id is written back onto the row.
    let createdCaseId = null;
    if (update.status === "failed" && !insp.case_id) {
      const { data: criticalFindings } = await admin
        .from("tanda_po_qc_findings")
        .select("id, severity")
        .eq("inspection_id", id)
        .eq("severity", "critical");
      const nCritical = (criticalFindings || []).length;
      if (nCritical > 0) {
        // Resolve PO number for the subject line — tanda_po_receipts.id
        // (uuid) → tanda_pos.id (legacy bigint PK on the existing tanda_pos
        // table; per memory feedback_tanda_pos_uuid_id_for_fks our UUID FK
        // would normally use uuid_id, but the P13-1 migration declared the
        // tanda_po_receipts.tanda_po_id → tanda_pos(id) FK against the
        // existing bigint id column on tanda_pos (flag — fix in a later
        // chunk). We read po_number off whichever row the FK actually
        // points at, so this lookup is robust either way.)
        const { data: receipt } = await admin
          .from("tanda_po_receipts")
          .select("id, tanda_po_id")
          .eq("id", insp.receipt_id)
          .maybeSingle();
        let poNumber = receipt?.tanda_po_id ? String(receipt.tanda_po_id).slice(0, 12) : "(unknown)";
        if (receipt?.tanda_po_id) {
          const { data: po } = await admin
            .from("tanda_pos")
            .select("po_number, id, uuid_id")
            .or(`id.eq.${receipt.tanda_po_id},uuid_id.eq.${receipt.tanda_po_id}`)
            .limit(1)
            .maybeSingle();
          if (po?.po_number) poNumber = po.po_number;
        }

        const year = new Date().getUTCFullYear();
        const caseNumber = await nextCaseNumber(admin, insp.entity_id, year);
        const subject = `QC failure — PO ${poNumber} — ${nCritical} critical finding${nCritical === 1 ? "" : "s"}`;
        const { data: caseRow, error: caseErr } = await admin
          .from("cases")
          .insert({
            entity_id: insp.entity_id,
            case_number: caseNumber,
            status: "open",
            severity: "high",
            subject,
            body: `Auto-created by QC inspection ${id}. Receipt: ${insp.receipt_id}. Critical findings: ${nCritical}.`,
          })
          .select()
          .single();
        if (caseErr) {
          return res.status(500).json({ error: `Failed to auto-create QC case: ${caseErr.message}` });
        }
        createdCaseId = caseRow.id;
        update.case_id = caseRow.id;
      }
    }

    const { data: updated, error: upErr } = await admin
      .from("tanda_po_qc_inspections")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({ ...updated, auto_case_id: createdCaseId });
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}

function isUuid(s) { return typeof s === "string" && UUID_RE.test(s); }

export function validateInspectionPatch(body, currentStatus) {
  const out = {};

  if ("status" in body) {
    const next = body.status;
    if (!STATUS_VALUES.includes(next)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
    if (next !== currentStatus) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] || new Set();
      if (!allowed.has(next)) {
        return {
          error: `Cannot transition from '${currentStatus}' to '${next}'. Allowed: ${[...allowed].join(", ") || "(none — terminal)"}`,
        };
      }
    }
    out.status = next;
  }

  if ("inspection_date" in body) {
    if (body.inspection_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.inspection_date)) {
      return { error: "inspection_date must be YYYY-MM-DD" };
    }
    out.inspection_date = body.inspection_date;
  }
  if ("inspector_employee_id" in body) {
    if (body.inspector_employee_id && !isUuid(body.inspector_employee_id)) {
      return { error: "inspector_employee_id must be a uuid" };
    }
    out.inspector_employee_id = body.inspector_employee_id || null;
  }
  if ("overall_pass_rate" in body) {
    if (body.overall_pass_rate === null || body.overall_pass_rate === "") {
      out.overall_pass_rate = null;
    } else {
      const n = typeof body.overall_pass_rate === "number"
        ? body.overall_pass_rate
        : parseFloat(body.overall_pass_rate);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return { error: "overall_pass_rate must be a number 0..1" };
      }
      out.overall_pass_rate = n;
    }
  }
  if ("notes" in body) {
    out.notes = body.notes ? String(body.notes).trim() : null;
  }

  return { data: out };
}

export { ALLOWED_TRANSITIONS as INSPECTION_TRANSITIONS };
