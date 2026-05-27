// api/internal/scanner/events/batch
//
// POST — Bulk-insert scanner events with idempotent offline replay.
//        Body: { session_id, events: [ { client_event_id, scanned_barcode,
//                resolved_item_id?, qty?, client_timestamp, notes? }, ... ] }
//
//        Per-event result: { client_event_id, inserted: true|false, error? }
//        The handler iterates events one-by-one so a single bad row doesn't
//        sink the batch. Each INSERT runs with ON CONFLICT (session_id,
//        client_event_id) DO NOTHING semantics by attempting the insert
//        first, then probing for the existing row on the conflict code path.
//
//        Idempotency contract:
//          POSTing the same client_event_id twice on the same session
//          inserts the first time (inserted=true) and is a no-op the
//          second time (inserted=false, no error).
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner back-end.
// Per docs/tangerine/P3-acc-core-architecture.md §6.5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  const v = validateBatch(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Load the session to inherit entity_id + verify it's not cancelled/submitted.
  const { data: session, error: sErr } = await admin
    .from("scanner_sessions")
    .select("id, entity_id, status")
    .eq("id", v.data.session_id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "open") {
    return res.status(409).json({ error: `Cannot add events to ${session.status} session` });
  }

  const results = [];
  for (const ev of v.data.events) {
    const row = {
      entity_id: session.entity_id,
      session_id: session.id,
      client_event_id: ev.client_event_id,
      scanned_barcode: ev.scanned_barcode,
      resolved_item_id: ev.resolved_item_id || null,
      qty: ev.qty,
      client_timestamp: ev.client_timestamp,
      notes: ev.notes || null,
    };
    const { error } = await admin
      .from("scanner_events")
      .insert(row);

    if (!error) {
      results.push({ client_event_id: ev.client_event_id, inserted: true });
      continue;
    }
    // 23505 unique_violation == idempotent replay. Treat as success-no-op.
    if (error.code === "23505") {
      results.push({ client_event_id: ev.client_event_id, inserted: false });
      continue;
    }
    results.push({
      client_event_id: ev.client_event_id,
      inserted: false,
      error: error.message,
    });
  }

  return res.status(200).json({ session_id: session.id, results });
}

export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function validateBatch(body) {
  if (!body.session_id || !isUuid(body.session_id)) {
    return { error: "session_id required (uuid)" };
  }
  if (!Array.isArray(body.events)) {
    return { error: "events must be an array" };
  }
  if (body.events.length === 0) {
    return { error: "events must be non-empty" };
  }
  if (body.events.length > 500) {
    return { error: "events may not exceed 500 per batch" };
  }
  const cleaned = [];
  for (let i = 0; i < body.events.length; i++) {
    const ev = body.events[i];
    if (!ev || typeof ev !== "object") {
      return { error: `events[${i}] must be an object` };
    }
    if (!ev.client_event_id || !isUuid(ev.client_event_id)) {
      return { error: `events[${i}].client_event_id required (uuid)` };
    }
    if (!ev.scanned_barcode || typeof ev.scanned_barcode !== "string" || !ev.scanned_barcode.trim()) {
      return { error: `events[${i}].scanned_barcode required` };
    }
    if (ev.resolved_item_id != null && ev.resolved_item_id !== "" && !isUuid(ev.resolved_item_id)) {
      return { error: `events[${i}].resolved_item_id must be a uuid` };
    }
    const qty = ev.qty == null ? 1 : Number(ev.qty);
    if (!Number.isFinite(qty)) {
      return { error: `events[${i}].qty must be a finite number` };
    }
    if (!ev.client_timestamp || typeof ev.client_timestamp !== "string") {
      return { error: `events[${i}].client_timestamp required` };
    }
    if (Number.isNaN(Date.parse(ev.client_timestamp))) {
      return { error: `events[${i}].client_timestamp must be a parseable timestamp` };
    }
    cleaned.push({
      client_event_id: ev.client_event_id,
      scanned_barcode: String(ev.scanned_barcode).trim(),
      resolved_item_id: ev.resolved_item_id || null,
      qty,
      client_timestamp: ev.client_timestamp,
      notes: ev.notes ? String(ev.notes) : null,
    });
  }
  return { data: { session_id: body.session_id, events: cleaned } };
}
