// api/internal/style-master/dim-values
//
// GET — returns the distinct, sorted, non-null values currently in use for the
// three classifier columns on style_master:
//
//   { groups: string[], categories: string[], sub_categories: string[] }
//
// Drives the searchable dropdowns in the Style Master edit modal (operator
// ask B, 2026-05-30). The dropdowns offer EXISTING values to operators; new
// values can still be added (admin-gated in the UI) via the standard
// POST/PATCH /api/internal/style-master endpoints. The handler itself does
// not gate admin — the admin gate is enforced on the write path (creating
// a row with a never-seen-before classifier), so a read-only dim list is
// safe to expose to any signed-in user.
//
// Implementation note: each classifier is fetched as its own scoped query
// against style_master, filtered to the default entity (ROF) and to non-
// soft-deleted rows. PostgREST returns up to 1000 rows by default, but the
// classifier set is small (single-digit groups, tens of categories, low
// hundreds of sub-categories) so a single batch with a generous cap is
// sufficient. We dedupe + sort in JS so the response is deterministic.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

const DIM_LIMIT = 5000;

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

async function fetchDistinct(admin, entityId, column) {
  const { data, error } = await admin
    .from("style_master")
    .select(column)
    .eq("entity_id", entityId)
    .is("deleted_at", null)
    .not(column, "is", null)
    .limit(DIM_LIMIT);
  if (error) throw new Error(error.message);
  const set = new Set();
  for (const row of data || []) {
    const v = row && row[column];
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  try {
    const [groups, categories, subCategories] = await Promise.all([
      fetchDistinct(admin, entityId, "group_name"),
      fetchDistinct(admin, entityId, "category_name"),
      fetchDistinct(admin, entityId, "sub_category_name"),
    ]);
    return res.status(200).json({
      groups,
      categories,
      sub_categories: subCategories,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
