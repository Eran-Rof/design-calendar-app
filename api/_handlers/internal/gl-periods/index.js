// api/internal/gl-periods
//
// GET — list periods for ROF entity. Optional ?fiscal_year=, ?status=,
//       ?include_counts=true (JOINs journal_entries to surface posted_je_count).
// POST is rejected (405). Periods are bootstrapped by migration — not user-created.
//
// Tangerine P1 Chunk 8b.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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

  if (req.method === "POST") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Periods are bootstrapped by migration; user-create is not supported.",
    });
  }

  if (req.method === "GET") {
    const entityId = await resolveDefaultEntityId(admin);
    if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

    const url = new URL(req.url, `https://${req.headers.host}`);
    const fiscalYear   = (url.searchParams.get("fiscal_year") || "").trim();
    const status       = (url.searchParams.get("status") || "").trim();
    const includeCounts = url.searchParams.get("include_counts") === "true";

    let query = admin
      .from("gl_periods")
      .select("id, entity_id, fiscal_year, period_number, starts_on, ends_on, status, soft_closed_at, closed_at, closed_by_user_id, created_at, updated_at")
      .eq("entity_id", entityId)
      .order("fiscal_year", { ascending: true })
      .order("period_number", { ascending: true });

    if (fiscalYear)  query = query.eq("fiscal_year", parseInt(fiscalYear, 10));
    if (status)      query = query.eq("status", status);

    const { data: periods, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    if (!includeCounts) {
      return res.status(200).json(periods || []);
    }

    // Augment each period with a posted JE count. One query, group in JS.
    const periodIds = (periods || []).map((p) => p.id);
    let countsByPeriod = new Map();
    if (periodIds.length > 0) {
      const { data: jeRows, error: jeErr } = await admin
        .from("journal_entries")
        .select("period_id")
        .in("period_id", periodIds)
        .eq("status", "posted");
      if (jeErr) return res.status(500).json({ error: jeErr.message });
      for (const row of jeRows || []) {
        countsByPeriod.set(row.period_id, (countsByPeriod.get(row.period_id) || 0) + 1);
      }
    }
    const augmented = (periods || []).map((p) => ({ ...p, posted_je_count: countsByPeriod.get(p.id) || 0 }));
    return res.status(200).json(augmented);
  }

  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}
