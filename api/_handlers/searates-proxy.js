// api/searates-proxy.js — Vercel Node.js Serverless Function
//
// Phase 1.7 — proxy for Searates /tracking. Every call is user-initiated
// (no polling/cron). Logs each call + estimated cost to api_call_log.
//
// Responsibilities:
//   1. Validate the caller's Supabase JWT and resolve to a vendor_users row
//   2. Call Searates with api_key (query param per their v3 spec)
//   3. Upsert shipment + events using the server-side mapper below
//   4. Write an api_call_log row regardless of success/failure
//   5. Return the stored shipment + event count + remaining quota
//
// The mapper mirrors src/vendor/shipmentUtils.ts. That file has vitest
// coverage — keep the two in sync when updating.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SEARATES_KEY = process.env.SEARATES_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SEARATES_KEY || !SB_URL || !SERVICE_KEY) {
    return res.status(500).json({
      error: "Server not configured",
      searatesKey: !!SEARATES_KEY,
      supabaseUrl: !!SB_URL,
      serviceKey: !!SERVICE_KEY,
    });
  }

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── Authenticate caller ──────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "Missing bearer token" });

  let callerAuthId = null;
  try {
    const { data } = await admin.auth.getUser(jwt);
    callerAuthId = data?.user?.id ?? null;
  } catch {
    callerAuthId = null;
  }
  if (!callerAuthId) return res.status(401).json({ error: "Invalid or expired token" });

  const { data: vu, error: vuErr } = await admin
    .from("vendor_users")
    .select("id, vendor_id")
    .eq("auth_id", callerAuthId)
    .maybeSingle();
  if (vuErr) return res.status(500).json({ error: "Vendor lookup failed: " + vuErr.message });
  if (!vu) return res.status(403).json({ error: "Caller is not linked to a vendor" });

  // ── Parse request params ─────────────────────────────────────────────────
  const url = new URL(req.url, `https://${req.headers.host}`);
  const number = (url.searchParams.get("number") || "").trim();
  const typeRaw = (url.searchParams.get("type") || "").trim().toUpperCase();
  const sealine = (url.searchParams.get("sealine") || "").trim();
  const force_update = url.searchParams.get("force_update") === "true";
  const po_number = (url.searchParams.get("po_number") || "").trim() || null;

  if (!number) return res.status(400).json({ error: "Missing 'number' query parameter" });
  if (typeRaw && !["CT", "BL", "BK"].includes(typeRaw)) {
    return res.status(400).json({ error: "'type' must be CT, BL, or BK" });
  }
  const type = typeRaw || null;

  // ── Call Searates ────────────────────────────────────────────────────────
  const t0 = Date.now();
  const srParams = new URLSearchParams();
  srParams.set("api_key", SEARATES_KEY);
  srParams.set("number", number);
  if (type) srParams.set("type", type);
  if (sealine) srParams.set("sealine", sealine);
  if (force_update) srParams.set("force_update", "true");
  const srUrl = `https://tracking.searates.com/tracking?${srParams.toString()}`;

  let response_status = 0;
  let response_message = "";
  let searatesBody = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const srRes = await fetch(srUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    response_status = srRes.status;
    const text = await srRes.text();
    try { searatesBody = JSON.parse(text); } catch {
      searatesBody = { raw: text.slice(0, 500) };
    }
    response_message = (searatesBody && searatesBody.message) || "";
  } catch (err) {
    response_status = err.name === "AbortError" ? 504 : 500;
    response_message = err.name === "AbortError" ? "Timeout" : err.message;
  }

  const duration_ms = Date.now() - t0;
  // Cost estimate is a heuristic until we wire up Searates billing webhooks.
  // force_update=true always hits the live sealine (full cost); cached reads
  // are typically cheaper. Adjust when we have real billing data.
  const estimated_cost_cents = force_update ? 5 : 2;

  // Log fire-and-forget — never block the response on logging.
  admin.from("api_call_log").insert({
    api_name: "searates",
    caller_auth_id: callerAuthId,
    number,
    number_type: type,
    force_update,
    response_status,
    response_message: (response_message || "").slice(0, 500),
    estimated_cost_cents,
    duration_ms,
  }).then(() => {}, () => {});

  if (response_status < 200 || response_status >= 300) {
    return res.status(response_status).json({
      error: response_message || "Searates request failed",
      details: searatesBody,
    });
  }

  // ── Map + upsert ────────────────────────────────────────────────────────
  const shipmentRow = mapShipment(searatesBody);
  if (!shipmentRow) {
    return res.status(502).json({
      error: "Searates response is missing metadata — cannot map to a shipment row",
      details: searatesBody,
    });
  }

  const nowIso = new Date().toISOString();
  const { data: upserted, error: upErr } = await admin
    .from("shipments")
    .upsert(
      {
        vendor_id: vu.vendor_id,
        vendor_user_id: vu.id,
        po_number,
        number: shipmentRow.number,
        number_type: shipmentRow.number_type,
        sealine_scac: shipmentRow.sealine_scac,
        sealine_name: shipmentRow.sealine_name,
        pol_locode: shipmentRow.pol_locode,
        pod_locode: shipmentRow.pod_locode,
        pol_date: shipmentRow.pol_date,
        pod_date: shipmentRow.pod_date,
        eta: shipmentRow.eta,
        ata: shipmentRow.ata,
        current_status: shipmentRow.current_status,
        last_tracked_at: nowIso,
        raw_payload: searatesBody,
        updated_at: nowIso,
      },
      { onConflict: "vendor_id,number,number_type" }
    )
    .select()
    .single();
  if (upErr) {
    return res.status(500).json({ error: "Upsert shipment failed: " + upErr.message });
  }

  // Replace events for this shipment. Searates responses are authoritative —
  // partial updates would leave stale predictive events in the table.
  await admin.from("shipment_events").delete().eq("shipment_id", upserted.id);
  const eventRows = mapEvents(searatesBody).map((e) => ({ ...e, shipment_id: upserted.id }));
  if (eventRows.length > 0) {
    const { error: evErr } = await admin.from("shipment_events").insert(eventRows);
    if (evErr) {
      return res.status(500).json({ error: "Insert events failed: " + evErr.message });
    }
  }

  return res.status(200).json({
    shipment: upserted,
    events_count: eventRows.length,
    api_calls_remaining:
      (searatesBody && searatesBody.data && searatesBody.data.metadata &&
       searatesBody.data.metadata.api_calls && searatesBody.data.metadata.api_calls.remaining) || null,
  });
}

// ── Response mapping ─────────────────────────────────────────────────────
// Mirrors src/vendor/shipmentUtils.ts. Keep in sync when updating.

function mapShipment(r) {
  const meta = r && r.data && r.data.metadata;
  if (!meta || !meta.number || !meta.type) return null;

  const locById = new Map();
  for (const l of (r.data.locations || [])) locById.set(l.id, l);

  const pol = r.data.route && r.data.route.pol;
  const pod = r.data.route && r.data.route.pod;
  const polLoc = pol && pol.location != null ? locById.get(pol.location) : null;
  const podLoc = pod && pod.location != null ? locById.get(pod.location) : null;

  const podActual = !!(pod && pod.actual);
  const eta = !podActual ? (pod && pod.date) || null : null;
  const ata = podActual ? (pod && pod.date) || null : null;

  return {
    number: meta.number,
    number_type: meta.type,
    sealine_scac: meta.sealine || null,
    sealine_name: meta.sealine_name || null,
    pol_locode: (polLoc && polLoc.locode) || null,
    pod_locode: (podLoc && podLoc.locode) || null,
    pol_date: (pol && pol.date) || null,
    pod_date: (pod && pod.date) || null,
    eta,
    ata,
    current_status: meta.status || null,
    last_tracked_at: meta.updated_at || null,
  };
}

function mapEvents(r) {
  const locById = new Map();
  for (const l of ((r && r.data && r.data.locations) || [])) locById.set(l.id, l);
  const facById = new Map();
  for (const f of ((r && r.data && r.data.facilities) || [])) facById.set(f.id, f);

  const out = [];
  for (const c of ((r && r.data && r.data.containers) || [])) {
    for (const e of (c.events || [])) {
      const loc = e.location != null ? locById.get(e.location) : null;
      const fac = e.facility != null ? facById.get(e.facility) : null;
      out.push({
        container_number: c.number || null,
        order_id: e.order_id == null ? null : e.order_id,
        event_code: e.event_code || null,
        event_type: e.event_type || null,
        status: e.status || null,
        description: e.description || null,
        location_locode: (loc && loc.locode) || null,
        facility_name: (fac && fac.name) || null,
        event_date: e.date || null,
        is_actual: !!e.actual,
        raw_json: e,
      });
    }
  }
  return out;
}
