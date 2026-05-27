// api/internal/scanner/sessions/:id/submit
//
// POST — Submit an open scanner session. Aggregates events into a
//        mode-appropriate output, marks status='submitted' and stamps
//        submitted_at. Returns { session, aggregation, write_results }.
//
// Mode-specific behavior:
//   receive   — Aggregates events into { resolved_item_id → total_qty } and
//               returns the receipt payload as JSON. The full AP receive
//               post (DR Inventory / CR GR-IR) lives in P3-2's territory;
//               this handler does NOT auto-post to GL. Operator picks up
//               the JSON via the admin UI / future AP integration.
//
//   pick      — Mirrors receive but for SO picking (M4 territory). Same
//               aggregation, returned as JSON for the future P3-X SO-ship
//               handler to consume. Placeholder for now.
//
//   transfer  — Aggregates by resolved_item_id. Per the P3-7/P3-8 sequencing
//               note: we DO NOT auto-create inventory_transfers rows. P3-7
//               is a separate chunk and may not be merged yet. Operator
//               manually creates the transfer rows via the P3-7 UX once
//               both chunks land. Deferred per chunk-decoupling rule.
//
//   count     — Defensively probes for inventory_cycle_count_lines. If
//               that table exists (i.e., P3-6 has shipped), writes
//               counted_qty into the matching lines via best-effort upsert
//               keyed by (cycle_count_id=target_id, resolved_item_id).
//               If the table does NOT exist, returns the aggregation JSON
//               with write_results = { skipped: "inventory_cycle_count_lines table not present" }.
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner back-end.
// Per docs/tangerine/P3-acc-core-architecture.md §6.6.

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

  // PR #345: req.query?.id (the dispatcher merges path params into req.query)
  const id = req.query?.id;
  if (!id || !isUuid(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: session, error: sErr } = await admin
    .from("scanner_sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "open") {
    return res.status(409).json({ error: `Cannot submit ${session.status} session` });
  }

  const { data: events, error: evErr } = await admin
    .from("scanner_events")
    .select("*")
    .eq("session_id", id)
    .order("server_received_at", { ascending: true });
  if (evErr) return res.status(500).json({ error: evErr.message });

  const eventsList = events || [];
  const aggregation = aggregateEvents(eventsList);
  let writeResults = null;

  if (session.mode === "receive") {
    // P3-2 (AP receive) will consume this payload. For P3-8 we just return it.
    writeResults = { posted_to_ap: false, note: "AP integration ships in P3-2" };

  } else if (session.mode === "pick") {
    // M4 / future SO-ship handler will consume.
    writeResults = { posted_to_so: false, note: "SO-ship integration ships in a later P3 chunk" };

  } else if (session.mode === "transfer") {
    // Deferred until BOTH P3-7 (inventory_transfers UX) and P3-8 (this chunk)
    // are merged. Do NOT auto-create transfers — operator runs the P3-7
    // create-transfer flow with this aggregation payload as input.
    writeResults = {
      posted_to_transfers: false,
      note: "Transfer auto-creation deferred until both P3-7 and P3-8 are merged. Use the aggregation payload to manually create the transfer.",
    };

  } else if (session.mode === "count") {
    // Defensive: probe for inventory_cycle_count_lines existence.
    const tableExists = await tableExistsInDb(admin, "inventory_cycle_count_lines");
    if (!tableExists) {
      writeResults = {
        wrote_count_lines: 0,
        skipped: "inventory_cycle_count_lines table not present (P3-6 cycle counts not yet shipped)",
      };
    } else if (!session.target_id) {
      writeResults = {
        wrote_count_lines: 0,
        skipped: "session.target_id is null — cannot route counted_qty to a cycle count",
      };
    } else {
      let wrote = 0;
      const errors = [];
      for (const row of aggregation) {
        if (!row.resolved_item_id) continue; // unresolved barcodes can't be applied
        const { error } = await admin
          .from("inventory_cycle_count_lines")
          .upsert(
            {
              cycle_count_id: session.target_id,
              item_id: row.resolved_item_id,
              counted_qty: row.qty,
              entity_id: session.entity_id,
            },
            { onConflict: "cycle_count_id,item_id" },
          );
        if (error) errors.push({ item_id: row.resolved_item_id, error: error.message });
        else wrote += 1;
      }
      writeResults = {
        wrote_count_lines: wrote,
        unresolved_skipped: aggregation.filter((r) => !r.resolved_item_id).length,
        errors,
      };
    }
  }

  // Mark session submitted.
  const { data: updated, error: upErr } = await admin
    .from("scanner_sessions")
    .update({ status: "submitted", submitted_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  return res.status(200).json({
    session: updated,
    aggregation,
    write_results: writeResults,
  });
}

export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Aggregate events by resolved_item_id, summing qty. Unresolved barcodes are
// grouped under a separate `unresolved` bucket so the caller can flag them.
export function aggregateEvents(events) {
  const byItem = new Map();
  const unresolved = new Map();
  for (const ev of events) {
    const qty = Number(ev.qty) || 0;
    if (ev.resolved_item_id) {
      byItem.set(ev.resolved_item_id, (byItem.get(ev.resolved_item_id) || 0) + qty);
    } else {
      const key = ev.scanned_barcode || "(empty)";
      unresolved.set(key, (unresolved.get(key) || 0) + qty);
    }
  }
  const rows = [];
  for (const [item_id, qty] of byItem.entries()) {
    rows.push({ resolved_item_id: item_id, qty });
  }
  for (const [barcode, qty] of unresolved.entries()) {
    rows.push({ resolved_item_id: null, scanned_barcode: barcode, qty });
  }
  return rows;
}

async function tableExistsInDb(admin, tableName) {
  // Cheap existence probe — attempt a HEAD count(*) with limit 0. If the
  // table doesn't exist, PostgREST returns a 404/42P01 error that we
  // can detect and treat as "not present" without crashing.
  try {
    const { error } = await admin
      .from(tableName)
      .select("*", { count: "exact", head: true })
      .limit(0);
    if (!error) return true;
    if (error.code === "42P01" || /relation .* does not exist/i.test(error.message || "")) {
      return false;
    }
    // Some other error — assume table exists but report up via the caller's
    // write_results normal flow. Returning true keeps the count path active
    // so the operator sees the real error rather than a silent skip.
    return true;
  } catch {
    return false;
  }
}
