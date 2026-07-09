// api/internal/factor/statements
//
// Factor Module Phase 1 (Rosenthal) — GET the monthly factor_statements rows
// (CLIENT RECAP economics, integer cents), ordered by statement_month ASC.
// Fed by scripts/import-factor-pdfs.mjs; read by the Factor (Rosenthal) panel
// (src/tanda/InternalFactorRecon.tsx).
//
// Auth: static internal token (authenticateInternalCaller) like every other
// /api/internal/** surface; RBAC maps the "factor" segment to the analytics
// read module (routePermissions.js).

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

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

  const { data, error } = await admin
    .from("factor_statements")
    .select("id, statement_month, factor_name, net_sales_cents, cash_collections_cents, chargebacks_net_cents, commissions_cents, interest_cents, fees_other_cents, advances_cents, beginning_net_oar_cents, ending_net_oar_cents, net_due_client_beginning_cents, net_due_client_ending_cents, total_loans_cents, source_file, imported_at")
    .order("statement_month", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ rows: data || [] });
}
