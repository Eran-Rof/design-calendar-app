// api/internal/procurement/qc/:id  (h591)
//
// P13-C2 — QC Inspections vertical, single-inspection CRUD.
// FINANCIALLY INERT: records inspection results + findings only. NO journal
// entries, NO GL posting, NO AP. Disposition GL posting is a FUTURE chunk.
//
// GET    → inspection header + findings[].
// PATCH  → update status / notes / overall_pass_rate + REPLACE findings
//          (delete-then-reinsert, mirroring the receipt line-replace pattern).
//          When the body passes `line_dispositions:[{receipt_line_id,
//          qty_accepted, qty_rejected}]`, those receipt lines' accepted/rejected
//          qty are updated IFF each line belongs to this inspection's receipt.
//          This is a bookkeeping update only — NO GL is touched.
// DELETE → delete inspection (cascades findings).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QC_STATUSES = ["pending", "passed", "failed", "partial"];
const SEVERITIES = ["minor", "major", "critical"];
// Statuses that may carry receipt line-disposition updates.
const DISPOSITION_STATUSES = ["passed", "failed", "partial"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

// Mirror of index.js's findings normalizer (replacement variant).
function normalizeFindings(body) {
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const out = [];
  let fn = 0;
  for (const f of findings) {
    fn += 1;
    if (!f || typeof f !== "object") continue;
    if (!f.category && !f.severity && !f.description) continue;
    const category = f.category ? String(f.category).trim() : "";
    if (!category) return { error: `finding ${fn}: category required` };
    const severity = f.severity ? String(f.severity).trim() : "";
    if (!SEVERITIES.includes(severity)) return { error: `finding ${fn}: severity must be one of ${SEVERITIES.join(", ")}` };
    const description = f.description ? String(f.description).trim() : "";
    if (!description) return { error: `finding ${fn}: description required` };
    const qty = f.qty_affected == null || f.qty_affected === "" ? 0 : Math.round(Number(f.qty_affected));
    if (!Number.isFinite(qty) || qty < 0) return { error: `finding ${fn}: qty_affected must be >= 0` };
    out.push({
      category,
      severity,
      qty_affected: qty,
      description,
      photo_urls: Array.isArray(f.photo_urls) ? f.photo_urls.map((u) => String(u)) : null,
      resolution: f.resolution ? String(f.resolution).trim() : null,
    });
  }
  return { findings: out };
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: inspection, error: iErr } = await admin
    .from("tanda_po_qc_inspections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (iErr) return res.status(500).json({ error: iErr.message });
  if (!inspection) return res.status(404).json({ error: "Inspection not found" });

  if (req.method === "GET") {
    const { data: findings, error: fErr } = await admin
      .from("tanda_po_qc_findings")
      .select("*")
      .eq("inspection_id", id)
      .order("created_at", { ascending: true });
    if (fErr) return res.status(500).json({ error: fErr.message });

    let receipt = null;
    if (inspection.receipt_id) {
      const { data: rec } = await admin
        .from("tanda_po_receipts")
        .select("id, purchase_order_id, receipt_date, status")
        .eq("id", inspection.receipt_id)
        .maybeSingle();
      receipt = rec || null;
    }

    return res.status(200).json({ ...inspection, findings: findings || [], receipt });
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("tanda_po_qc_inspections").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const patch = {};
    if ("status" in body) {
      const status = body.status ? String(body.status).trim() : "";
      if (!QC_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${QC_STATUSES.join(", ")}` });
      }
      patch.status = status;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;
    if ("inspector_employee_id" in body) {
      patch.inspector_employee_id =
        body.inspector_employee_id && UUID_RE.test(String(body.inspector_employee_id))
          ? body.inspector_employee_id
          : null;
    }
    if ("inspection_date" in body) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.inspection_date || ""))) {
        return res.status(400).json({ error: "inspection_date must be YYYY-MM-DD" });
      }
      patch.inspection_date = body.inspection_date;
    }
    if ("overall_pass_rate" in body) {
      if (body.overall_pass_rate == null || body.overall_pass_rate === "") {
        patch.overall_pass_rate = null;
      } else {
        const r = Number(body.overall_pass_rate);
        if (!Number.isFinite(r) || r < 0 || r > 1) {
          return res.status(400).json({ error: "overall_pass_rate must be between 0 and 1" });
        }
        patch.overall_pass_rate = Math.round(r * 10000) / 10000;
      }
    }

    // Replace findings when supplied.
    const replacingFindings = Array.isArray(body.findings);
    let normFindings = null;
    if (replacingFindings) {
      const f = normalizeFindings(body);
      if (f.error) return res.status(400).json({ error: f.error });
      normFindings = f.findings;
    }

    // OPTIONAL receipt line dispositions — a bookkeeping update of accepted /
    // rejected qty on the linked receipt's lines. NO GL posting. Allowed only
    // alongside a passed/failed/partial status (effective: patched or current).
    const dispositions = Array.isArray(body.line_dispositions) ? body.line_dispositions : null;
    let normDispositions = null;
    if (dispositions && dispositions.length) {
      const effectiveStatus = patch.status || inspection.status;
      if (!DISPOSITION_STATUSES.includes(effectiveStatus)) {
        return res.status(409).json({
          error: `line_dispositions require status ${DISPOSITION_STATUSES.join("/")} (currently ${effectiveStatus}).`,
        });
      }
      // Validate every referenced receipt line belongs to this inspection's
      // receipt before touching anything.
      const { data: recLines, error: rlErr } = await admin
        .from("tanda_po_receipt_lines")
        .select("id")
        .eq("receipt_id", inspection.receipt_id);
      if (rlErr) return res.status(500).json({ error: rlErr.message });
      const validLineIds = new Set((recLines || []).map((l) => String(l.id)));

      const seen = new Set();
      normDispositions = [];
      let dn = 0;
      for (const d of dispositions) {
        dn += 1;
        const lineId = d && d.receipt_line_id;
        if (!lineId || !UUID_RE.test(String(lineId))) {
          return res.status(400).json({ error: `disposition ${dn}: receipt_line_id (uuid) required` });
        }
        if (!validLineIds.has(String(lineId))) {
          return res.status(400).json({ error: `disposition ${dn}: receipt_line_id does not belong to this inspection's receipt` });
        }
        if (seen.has(String(lineId))) {
          return res.status(400).json({ error: `disposition ${dn}: duplicate receipt_line_id` });
        }
        seen.add(String(lineId));
        const linePatch = {};
        if (d.qty_accepted != null && d.qty_accepted !== "") {
          const acc = Math.round(Number(d.qty_accepted));
          if (!Number.isFinite(acc) || acc < 0) return res.status(400).json({ error: `disposition ${dn}: qty_accepted must be >= 0` });
          linePatch.qty_accepted = acc;
        }
        if (d.qty_rejected != null && d.qty_rejected !== "") {
          const rej = Math.round(Number(d.qty_rejected));
          if (!Number.isFinite(rej) || rej < 0) return res.status(400).json({ error: `disposition ${dn}: qty_rejected must be >= 0` });
          linePatch.qty_rejected = rej;
        }
        if (Object.keys(linePatch).length === 0) continue;
        normDispositions.push({ id: lineId, patch: linePatch });
      }
    }

    // Apply header patch.
    if (Object.keys(patch).length > 0) {
      const { error: uErr } = await admin.from("tanda_po_qc_inspections").update(patch).eq("id", id);
      if (uErr) return res.status(500).json({ error: uErr.message });
    }

    // Replace findings (delete-then-reinsert).
    if (replacingFindings) {
      await admin.from("tanda_po_qc_findings").delete().eq("inspection_id", id);
      if (normFindings.length) {
        const rows = normFindings.map((x) => ({ ...x, inspection_id: id }));
        const { error: fErr } = await admin.from("tanda_po_qc_findings").insert(rows);
        if (fErr) return res.status(500).json({ error: `Findings update failed: ${fErr.message}` });
      }
    }

    // Apply receipt line dispositions (bookkeeping only — NO GL).
    if (normDispositions && normDispositions.length) {
      for (const d of normDispositions) {
        const { error: dErr } = await admin
          .from("tanda_po_receipt_lines")
          .update(d.patch)
          .eq("id", d.id)
          .eq("receipt_id", inspection.receipt_id);
        if (dErr) return res.status(500).json({ error: `Disposition update failed: ${dErr.message}` });
      }
    }

    const { data: fresh, error: frErr } = await admin
      .from("tanda_po_qc_inspections")
      .select("*")
      .eq("id", id)
      .single();
    if (frErr) return res.status(500).json({ error: frErr.message });
    return res.status(200).json(fresh);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
