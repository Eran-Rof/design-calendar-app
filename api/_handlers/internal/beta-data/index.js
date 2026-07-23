// api/internal/beta-data
//
// Beta guardrails — Chunk C: the Beta Data admin surface.
//
// GET  /api/internal/beta-data
//        → { config, summary[], rows[] }
//          config  = the single beta_config row (window state)
//          summary = per-table registry counts { table_name, total, cleaned, outstanding }
//          rows    = outstanding beta_created_docs rows (limit 500, newest
//                    first), each with a DRY-RUN `eligibility` verdict from the
//                    cleanup engine (no writes) + created_by_email.
//
// POST /api/internal/beta-data
//        { action: "start_window", notes? }  → activate the beta window
//                                              (409 when already active)
//        { action: "end_window" }            → deactivate (409 when not active)
//        { action: "cleanup", ids: [registry ids], confirm: true }
//                                            → run the cleanup engine on those
//                                              registry rows only; returns
//                                              per-id outcomes {deleted|already_gone|refused, reason}.
//
// Mirrors the users-access handler structure: service-role client (bypasses
// RLS; the browser cannot touch beta_config / the registry directly),
// resolveUserId for the acting user (stamped into started_by_user_id and
// cleanup_note). The dispatcher gates this route on beta_data:read/write via
// api/_lib/rbac/routePermissions.js — admin-only through the module_keys
// admin-derivation (the `beta` role is never granted beta_data).

import { createClient } from "@supabase/supabase-js";
import { resolveUserId } from "../../../_lib/auth.js";
import { evaluateRegistryRows, cleanupRegistryRows } from "../../../_lib/betaData.js";

export const config = { maxDuration: 60 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Auth-User-Id, X-Internal-Token");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Acting user for provenance stamps. Prefer the email (readable in notes and
// on-screen — no raw UUIDs); fall back to the auth id, then "operator".
async function resolveActor(req, admin) {
  const auth = await resolveUserId(req, admin).catch(() => ({ ok: false, authId: null }));
  if (!auth?.ok || !auth.authId) return { authId: null, label: "operator" };
  try {
    const { data } = await admin.auth.admin.getUserById(auth.authId);
    return { authId: auth.authId, label: data?.user?.email || auth.authId };
  } catch {
    return { authId: auth.authId, label: auth.authId };
  }
}

// auth.users id → email map (small internal user base; one page covers it).
async function loadEmailMap(admin) {
  const map = {};
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of data?.users || []) map[u.id] = u.email || null;
  } catch { /* emails are a nicety */ }
  return map;
}

// Registry counts per table. Paged reads (PostgREST caps a single select at
// 1000 rows) over the two thin columns we aggregate.
async function loadSummary(admin) {
  const perTable = new Map();
  const PAGE = 1000;
  for (let page = 0; page < 50; page++) {
    const { data, error } = await admin
      .from("beta_created_docs")
      .select("table_name, cleaned_at")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return { summary: null, error: error.message };
    for (const r of data || []) {
      const s = perTable.get(r.table_name) || { table_name: r.table_name, total: 0, cleaned: 0, outstanding: 0 };
      s.total += 1;
      if (r.cleaned_at) s.cleaned += 1; else s.outstanding += 1;
      perTable.set(r.table_name, s);
    }
    if (!data || data.length < PAGE) break;
  }
  return {
    summary: [...perTable.values()].sort((a, b) => b.outstanding - a.outstanding || a.table_name.localeCompare(b.table_name)),
    error: null,
  };
}

async function loadConfig(admin) {
  const { data, error } = await admin.from("beta_config").select("*").limit(1).maybeSingle();
  return { row: data || null, error: error ? error.message : null };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const [{ row: cfg, error: cfgErr }, { summary, error: sumErr }, emails] = await Promise.all([
      loadConfig(admin),
      loadSummary(admin),
      loadEmailMap(admin),
    ]);
    // A missing beta_config / beta_created_docs table (chunk A not applied yet)
    // must render as an informative empty state, not a 500.
    if (cfgErr && sumErr) {
      return res.status(200).json({
        config: null, summary: [], rows: [],
        warning: `Beta tables not available yet (${cfgErr}). Apply the chunk-A migration first.`,
      });
    }

    const { data: outstanding, error: rowsErr } = await admin
      .from("beta_created_docs")
      .select("*")
      .is("cleaned_at", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (rowsErr) return res.status(500).json({ error: rowsErr.message });

    // Dry-run eligibility — the engine computes verdicts, writes nothing.
    const verdicts = await evaluateRegistryRows(admin, outstanding || []);

    const rows = (outstanding || []).map((r) => ({
      id: r.id,
      table_name: r.table_name,
      row_id: r.row_id,
      doc_label: r.doc_label || null,
      source: r.source || null,
      created_by_user_id: r.created_by_user_id || null,
      created_by_email: (r.created_by_user_id && emails[r.created_by_user_id]) || null,
      created_at: r.created_at,
      eligibility: verdicts.get(r.id) || { verdict: "refused", reason: "not assessed" },
    }));

    return res.status(200).json({ config: cfg, summary: summary || [], rows });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    const action = body.action;

    // ── Window toggle ────────────────────────────────────────────────────────
    if (action === "start_window" || action === "end_window") {
      const actor = await resolveActor(req, admin);
      const { row: cfg, error: cfgErr } = await loadConfig(admin);
      if (cfgErr) return res.status(500).json({ error: `beta_config: ${cfgErr}` });

      const nowIso = new Date().toISOString();
      if (action === "start_window") {
        if (cfg?.active) return res.status(409).json({ error: "Beta window is already active" });
        const patch = {
          active: true,
          started_at: nowIso,
          ended_at: null,
          started_by_user_id: actor.authId || actor.label,
          updated_at: nowIso,
          ...(typeof body.notes === "string" && body.notes.trim() !== "" ? { notes: body.notes.trim() } : {}),
        };
        // beta_config is a single-row table seeded by chunk A; insert
        // defensively when the row is somehow missing.
        const q = cfg
          ? admin.from("beta_config").update(patch).eq("id", cfg.id).select().single()
          : admin.from("beta_config").insert(patch).select().single();
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ config: data });
      }

      // end_window
      if (!cfg || !cfg.active) return res.status(409).json({ error: "No active beta window to end" });
      const { data, error } = await admin
        .from("beta_config")
        .update({ active: false, ended_at: nowIso, updated_at: nowIso })
        .eq("id", cfg.id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ config: data });
    }

    // ── Cleanup ──────────────────────────────────────────────────────────────
    if (action === "cleanup") {
      if (body.confirm !== true) {
        return res.status(400).json({ error: "cleanup requires confirm: true" });
      }
      const ids = Array.isArray(body.ids) ? body.ids.filter((v) => Number.isInteger(Number(v))) : [];
      if (ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array of registry ids" });
      if (ids.length > 200) return res.status(400).json({ error: "At most 200 rows per cleanup run" });

      const { data: regRows, error: regErr } = await admin
        .from("beta_created_docs")
        .select("*")
        .in("id", ids)
        .is("cleaned_at", null);
      if (regErr) return res.status(500).json({ error: regErr.message });

      const actor = await resolveActor(req, admin);
      const results = await cleanupRegistryRows(admin, regRows || [], { actorLabel: actor.label });

      // Ids the caller sent that were not outstanding (already cleaned/unknown).
      const seen = new Set((regRows || []).map((r) => String(r.id)));
      for (const id of ids) {
        if (!seen.has(String(id))) {
          results.push({ id, outcome: "refused", reason: "not an outstanding registry row" });
        }
      }
      return res.status(200).json({ results });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
