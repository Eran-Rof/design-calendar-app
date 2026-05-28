// api/internal/cases/:id
//
// GET   — fetch one case + comment thread (joined; comments ASC).
// PATCH — update header (status, severity, assignee_user_id, subject, body,
//          customer_id, ar_invoice_id, rma_id, sales_order_id).
//          status/severity validated against CHECK enum; trigger fills
//          resolved_at on status flip to resolved/closed.
// DELETE — hard-delete (comments cascade). Reserved for operator cleanup
//          of test rows; production flow is status='closed'.
//
// Tangerine P7-9 (arch §6).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_VALUES = ["open", "in_progress", "resolved", "closed"];
const SEVERITY_VALUES = ["low", "normal", "high", "urgent"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
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

  const { data: caseRow, error: fetchErr } = await admin
    .from("cases")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!caseRow) return res.status(404).json({ error: "Case not found" });

  if (req.method === "GET") {
    const { data: comments, error: cErr } = await admin
      .from("case_comments")
      .select("id, case_id, author_user_id, body, is_internal, external_email, created_at")
      .eq("case_id", id)
      .order("created_at", { ascending: true });
    if (cErr) return res.status(500).json({ error: cErr.message });

    let customer = null;
    if (caseRow.customer_id) {
      const { data: c } = await admin
        .from("customers")
        .select("id, code, name")
        .eq("id", caseRow.customer_id)
        .maybeSingle();
      customer = c || null;
    }

    return res.status(200).json({
      ...caseRow,
      customer,
      comments: comments || [],
    });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    if (Object.keys(v.data).length === 0) {
      return res.status(200).json(caseRow);
    }

    const { data: updated, error: upErr } = await admin
      .from("cases")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (upErr) return res.status(500).json({ error: upErr.message });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    const { error: delErr } = await admin.from("cases").delete().eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function validatePatch(body) {
  // Server-controlled / locked columns.
  const LOCKED = [
    "id", "entity_id", "case_number",
    "resolved_at", "created_at", "updated_at", "created_by_user_id",
  ];
  for (const k of LOCKED) {
    if (k in body) return { error: `${k} is not patchable here` };
  }

  const out = {};

  if ("status" in body) {
    if (!STATUS_VALUES.includes(body.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
    out.status = body.status;
  }
  if ("severity" in body) {
    if (!SEVERITY_VALUES.includes(body.severity)) {
      return { error: `severity must be one of ${SEVERITY_VALUES.join(", ")}` };
    }
    out.severity = body.severity;
  }
  if ("subject" in body) {
    const s = typeof body.subject === "string" ? body.subject.trim() : "";
    if (!s) return { error: "subject must be non-empty" };
    if (s.length > 500) return { error: "subject must be ≤ 500 chars" };
    out.subject = s;
  }
  if ("body" in body) {
    out.body = body.body == null ? null : String(body.body);
  }
  if ("assignee_user_id" in body) {
    if (body.assignee_user_id == null || body.assignee_user_id === "") {
      out.assignee_user_id = null;
    } else if (!UUID_RE.test(body.assignee_user_id)) {
      return { error: "assignee_user_id must be a uuid or null" };
    } else {
      out.assignee_user_id = body.assignee_user_id;
    }
  }
  if ("customer_id" in body) {
    if (body.customer_id == null || body.customer_id === "") {
      out.customer_id = null;
    } else if (!UUID_RE.test(body.customer_id)) {
      return { error: "customer_id must be a uuid or null" };
    } else {
      out.customer_id = body.customer_id;
    }
  }
  if ("ar_invoice_id" in body) {
    if (body.ar_invoice_id == null || body.ar_invoice_id === "") {
      out.ar_invoice_id = null;
    } else if (!UUID_RE.test(body.ar_invoice_id)) {
      return { error: "ar_invoice_id must be a uuid or null" };
    } else {
      out.ar_invoice_id = body.ar_invoice_id;
    }
  }
  if ("rma_id" in body) {
    if (body.rma_id == null || body.rma_id === "") {
      out.rma_id = null;
    } else if (!UUID_RE.test(body.rma_id)) {
      return { error: "rma_id must be a uuid or null" };
    } else {
      out.rma_id = body.rma_id;
    }
  }
  if ("sales_order_id" in body) {
    if (body.sales_order_id == null || body.sales_order_id === "") {
      out.sales_order_id = null;
    } else if (!UUID_RE.test(body.sales_order_id)) {
      return { error: "sales_order_id must be a uuid or null" };
    } else {
      out.sales_order_id = body.sales_order_id;
    }
  }
  if ("external_email" in body) {
    out.external_email = body.external_email ? String(body.external_email).trim() : null;
  }

  return { data: out };
}
