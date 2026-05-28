// api/internal/crm/opportunities
//
// GET  — list opportunities. Filters:
//          ?stage=new|qualified|proposal|won|lost
//          ?owner_user_id=<uuid>
//          ?customer_id=<uuid>
//          ?q=<substring>  (case-insensitive ILIKE on title)
//          ?limit=N (default 100, max 500)
//          ?offset=N (default 0)
// POST — create new opportunity.
//          Body:
//            {
//              title (required, non-empty),
//              customer_id?, owner_user_id?,
//              stage?  (default 'new'),
//              expected_cents?, probability_pct? (default 50),
//              expected_close_date?, description?,
//              metadata?, created_by_user_id?
//            }
//          Server generates opportunity_number OPP-YYYY-NNNNN if not supplied;
//          uniqueness is per (entity, opportunity_number).
//
// Tangerine P8-2 (arch §4).
//
// Schema reference (per CURRENT-SCHEMA.md):
//   crm_opportunities(id, entity_id, customer_id, opportunity_number, title,
//                     stage, stage_changed_at, expected_cents, probability_pct,
//                     expected_close_date, actual_close_date, loss_reason,
//                     owner_user_id, description, metadata, created_at,
//                     updated_at, created_by_user_id)

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_VALUES = ["new", "qualified", "proposal", "won", "lost"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntity(admin) {
  const { data } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  return data || null;
}

/**
 * Generate the next opportunity_number for an entity in YYYY year-bucket.
 * Format: OPP-YYYY-NNNNN (5-digit zero-padded sequence per year).
 *
 * Reads the max existing opportunity_number for the year prefix and increments.
 * Race-safe enough for low volume; the per-entity unique constraint catches
 * collisions.
 */
export async function nextOpportunityNumber(admin, entityId, year) {
  const prefix = `OPP-${year}-`;
  const { data } = await admin
    .from("crm_opportunities")
    .select("opportunity_number")
    .eq("entity_id", entityId)
    .like("opportunity_number", `${prefix}%`)
    .order("opportunity_number", { ascending: false })
    .limit(1);
  let next = 1;
  if (Array.isArray(data) && data.length > 0) {
    const last = data[0].opportunity_number;
    const m = /^OPP-\d{4}-(\d+)$/.exec(last || "");
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(next).padStart(5, "0")}`;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });
  const entityId = entity.id;

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const params = Object.fromEntries(url.searchParams.entries());
    const v = parseListQuery(params);
    if (v.error) return res.status(400).json({ error: v.error });

    const { stage, owner_user_id, customer_id, q, limit, offset } = v.data;

    let query = admin
      .from("crm_opportunities")
      .select(
        "id, entity_id, customer_id, opportunity_number, title, stage, " +
        "stage_changed_at, expected_cents, probability_pct, expected_close_date, " +
        "actual_close_date, loss_reason, owner_user_id, description, metadata, " +
        "created_at, updated_at, created_by_user_id",
      )
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (stage)          query = query.eq("stage", stage);
    if (owner_user_id)  query = query.eq("owner_user_id", owner_user_id);
    if (customer_id)    query = query.eq("customer_id", customer_id);
    if (q)              query = query.ilike("title", `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Enrich with customer name (best-effort, single batch fetch).
    const customerIds = Array.from(new Set((data || []).map((r) => r.customer_id).filter(Boolean)));
    let customers = {};
    if (customerIds.length > 0) {
      const { data: custData } = await admin
        .from("customers")
        .select("id, code, name")
        .in("id", customerIds);
      for (const c of custData || []) customers[c.id] = c;
    }

    const enriched = (data || []).map((r) => ({
      ...r,
      customer: r.customer_id ? customers[r.customer_id] || null : null,
    }));
    return res.status(200).json(enriched);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const year = new Date().getUTCFullYear();
    const oppNumber = v.data.opportunity_number || (await nextOpportunityNumber(admin, entityId, year));

    const row = {
      entity_id: entityId,
      opportunity_number: oppNumber,
      title: v.data.title,
      customer_id: v.data.customer_id,
      owner_user_id: v.data.owner_user_id,
      stage: v.data.stage,
      expected_cents: v.data.expected_cents,
      probability_pct: v.data.probability_pct,
      expected_close_date: v.data.expected_close_date,
      description: v.data.description,
      metadata: v.data.metadata,
      created_by_user_id: v.data.created_by_user_id,
    };

    // Set session actor for any triggers that may fire on insert (none in P8-1,
    // but defensive — keeps parity with PATCH/stage handlers).
    if (v.data.created_by_user_id) {
      await admin.rpc("set_config", {
        setting_name: "app.current_user_id",
        new_value: v.data.created_by_user_id,
        is_local: true,
      }).catch(() => {});
    }

    const { data: inserted, error: insErr } = await admin
      .from("crm_opportunities")
      .insert(row)
      .select()
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        return res.status(409).json({ error: `opportunity_number ${oppNumber} already exists for this entity` });
      }
      return res.status(500).json({ error: insErr.message });
    }
    return res.status(201).json(inserted);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export function parseListQuery(params) {
  const stage          = (params.stage || "").trim();
  const owner_user_id  = (params.owner_user_id || "").trim();
  const customer_id    = (params.customer_id || "").trim();
  const q              = (params.q || "").trim();

  let limit = parseInt(params.limit || "100", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;
  let offset = parseInt(params.offset || "0", 10);
  if (Number.isNaN(offset) || offset < 0) offset = 0;

  if (stage && !STAGE_VALUES.includes(stage)) {
    return { error: `stage must be one of ${STAGE_VALUES.join(", ")}` };
  }
  if (owner_user_id && !UUID_RE.test(owner_user_id)) {
    return { error: "owner_user_id must be a uuid" };
  }
  if (customer_id && !UUID_RE.test(customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (q.length > 200) {
    return { error: "q must be ≤ 200 chars" };
  }

  return {
    data: {
      stage: stage || null,
      owner_user_id: owner_user_id || null,
      customer_id: customer_id || null,
      q: q || null,
      limit,
      offset,
    },
  };
}

export function validateInsert(body) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { error: "title is required" };
  if (title.length > 500) return { error: "title must be ≤ 500 chars" };

  const stage = body.stage ? String(body.stage).trim() : "new";
  if (!STAGE_VALUES.includes(stage)) {
    return { error: `stage must be one of ${STAGE_VALUES.join(", ")}` };
  }

  let probability_pct = 50;
  if (body.probability_pct !== undefined && body.probability_pct !== null && body.probability_pct !== "") {
    const n = Number(body.probability_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100 || !Number.isInteger(n)) {
      return { error: "probability_pct must be an integer between 0 and 100" };
    }
    probability_pct = n;
  }

  let expected_cents = null;
  if (body.expected_cents !== undefined && body.expected_cents !== null && body.expected_cents !== "") {
    const n = Number(body.expected_cents);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { error: "expected_cents must be a non-negative integer" };
    }
    expected_cents = n;
  }

  let expected_close_date = null;
  if (body.expected_close_date) {
    const d = String(body.expected_close_date).trim();
    if (!DATE_RE.test(d)) return { error: "expected_close_date must be YYYY-MM-DD" };
    expected_close_date = d;
  }

  if (body.customer_id && !UUID_RE.test(body.customer_id)) {
    return { error: "customer_id must be a uuid" };
  }
  if (body.owner_user_id && !UUID_RE.test(body.owner_user_id)) {
    return { error: "owner_user_id must be a uuid" };
  }
  if (body.created_by_user_id && !UUID_RE.test(body.created_by_user_id)) {
    return { error: "created_by_user_id must be a uuid" };
  }
  if (body.opportunity_number !== undefined && body.opportunity_number !== null && body.opportunity_number !== "") {
    const on = String(body.opportunity_number).trim();
    if (!/^OPP-\d{4}-\d{5,}$/.test(on)) {
      return { error: "opportunity_number must match OPP-YYYY-NNNNN" };
    }
  }

  let metadata = {};
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return { error: "metadata must be an object" };
    }
    metadata = body.metadata;
  }

  return {
    data: {
      title,
      stage,
      probability_pct,
      expected_cents,
      expected_close_date,
      customer_id: body.customer_id || null,
      owner_user_id: body.owner_user_id || null,
      description: body.description ? String(body.description) : null,
      metadata,
      created_by_user_id: body.created_by_user_id || null,
      opportunity_number: body.opportunity_number ? String(body.opportunity_number).trim() : null,
    },
  };
}
