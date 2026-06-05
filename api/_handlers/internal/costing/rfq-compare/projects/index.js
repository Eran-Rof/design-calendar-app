// api/internal/costing/rfq-compare/projects
//
// GET → the costing projects eligible for RFQ comparison: only projects whose
// RFQs have at least one REAL vendor quote (submitted / under_review / awarded).
// Backs the Compare-RFQs project picker so it doesn't list projects with nothing
// to compare. Chain: rfq_quotes (real status) → rfqs.source_costing_project_id
// → costing_projects.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. RFQs that have a real vendor quote.
  const { data: quotes, error: qErr } = await admin
    .from("rfq_quotes")
    .select("rfq_id")
    .in("status", ["submitted", "under_review", "awarded"]);
  if (qErr) return res.status(500).json({ error: qErr.message });
  const rfqIds = [...new Set((quotes || []).map((q) => q.rfq_id).filter(Boolean))];
  if (rfqIds.length === 0) return res.status(200).json([]);

  // 2. Those RFQs' source costing project.
  const { data: rfqs, error: rErr } = await admin
    .from("rfqs")
    .select("source_costing_project_id")
    .in("id", rfqIds);
  if (rErr) return res.status(200).json([]); // pre-migration / no source column → nothing eligible
  const projIds = [...new Set((rfqs || []).map((r) => r.source_costing_project_id).filter(Boolean))];
  if (projIds.length === 0) return res.status(200).json([]);

  // 3. The projects.
  const { data: projs, error: pErr } = await admin
    .from("costing_projects")
    .select("id, project_name")
    .in("id", projIds)
    .order("project_name", { ascending: true });
  if (pErr) return res.status(500).json({ error: pErr.message });

  return res.status(200).json(projs || []);
}
