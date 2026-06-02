// api/internal/sales-reps/:id/assignments
//
// GET    — list customer_sales_rep_assignments for the rep (joined with customer).
// POST   — add a new assignment.
//          Body: { customer_id, share_pct?, effective_from?, effective_to? }
// DELETE — remove an assignment by ?assignment_id=<uuid>.
//
// Tangerine P7-6 (arch §4.4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function getRepId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("assignments");
  return tail > 0 ? parts[tail - 1] : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const repId = getRepId(req);
  if (!repId || !UUID_RE.test(repId)) {
    return res.status(400).json({ error: "Invalid rep id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Confirm the rep exists.
  const { data: rep, error: repErr } = await admin
    .from("sales_reps")
    .select("id, entity_id")
    .eq("id", repId)
    .maybeSingle();
  if (repErr) return res.status(500).json({ error: repErr.message });
  if (!rep) return res.status(404).json({ error: "Sales rep not found" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("customer_sales_rep_assignments")
      .select(
        "id, customer_id, sales_rep_id, share_pct, effective_from, effective_to, created_at, " +
        "customers(id, code, name)",
      )
      .eq("sales_rep_id", repId)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateAssignmentInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = {
      sales_rep_id: repId,
      customer_id: v.data.customer_id,
      share_pct: v.data.share_pct,
      effective_from: v.data.effective_from,
      effective_to: v.data.effective_to,
    };
    const { data: inserted, error: insErr } = await admin
      .from("customer_sales_rep_assignments")
      .insert(row)
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: insErr.message });
    return res.status(201).json(inserted);
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const assignmentId = url.searchParams.get("assignment_id");
    if (!assignmentId || !UUID_RE.test(assignmentId)) {
      return res.status(400).json({ error: "assignment_id (uuid) is required" });
    }
    const { error: delErr } = await admin
      .from("customer_sales_rep_assignments")
      .delete()
      .eq("id", assignmentId)
      .eq("sales_rep_id", repId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function isISODate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

export function validateAssignmentInsert(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };

  if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) {
    return { error: "customer_id (uuid) is required" };
  }

  let share_pct = 100;
  if (body.share_pct != null && body.share_pct !== "") {
    const n = Number(body.share_pct);
    if (!Number.isFinite(n)) return { error: "share_pct must be a number" };
    if (n <= 0 || n > 100) return { error: "share_pct must be > 0 and ≤ 100" };
    share_pct = n;
  }

  let effective_from = null;
  if (body.effective_from != null && body.effective_from !== "") {
    if (!isISODate(String(body.effective_from))) {
      return { error: "effective_from must be ISO date YYYY-MM-DD" };
    }
    effective_from = String(body.effective_from);
  } else {
    effective_from = new Date().toISOString().slice(0, 10);
  }

  let effective_to = null;
  if (body.effective_to != null && body.effective_to !== "") {
    if (!isISODate(String(body.effective_to))) {
      return { error: "effective_to must be ISO date YYYY-MM-DD" };
    }
    effective_to = String(body.effective_to);
    if (effective_to < effective_from) {
      return { error: "effective_to must be on or after effective_from" };
    }
  }

  return {
    data: {
      customer_id: String(body.customer_id),
      share_pct,
      effective_from,
      effective_to,
    },
  };
}
