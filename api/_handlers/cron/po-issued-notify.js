// api/cron/po-issued-notify
//
// Fires the po_issued notification (in-app bell + email) for tanda_pos
// rows that were synced recently and don't yet have a po_issued
// notification on record.
//
// Why a cron and not a hook? The PO upsert is client-side in
// src/tanda/hooks/useSyncOps.ts using the anon Supabase key — internal
// apps are explicitly off-limits for edits. send-notification requires
// the service-role key, so the client can't call it directly. A cron
// reading tanda_pos closes the loop without touching the internal app.
//
// Scheduled every 15 min. Safe to re-run: dedupe via the existence of a
// notifications row with event_type='po_issued' and metadata->>po_id
// matching the tanda_pos uuid_id.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 120 };

// Cutoff: only consider POs synced on/after this date. Prevents the
// first cron run from blasting historical POs. Tighten as needed.
const HISTORICAL_CUTOFF = "2026-05-10";

async function sendNotification(origin, payload) {
  if (!origin) return;
  try {
    await fetch(`${origin}/api/send-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* non-blocking */ }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret) {
    const got = req.headers.authorization || "";
    if (got !== `Bearer ${expectedSecret}`) return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });

  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const origin = `https://${req.headers.host}`;

  // Pull recent POs. uuid_id is the stable id used as deep-link target.
  const { data: pos, error } = await admin
    .from("tanda_pos")
    .select("uuid_id, po_number, vendor, vendor_id, data, synced_at")
    .gte("synced_at", `${HISTORICAL_CUTOFF}T00:00:00Z`)
    .order("synced_at", { ascending: true })
    .limit(500);
  if (error) return res.status(500).json({ error: "tanda_pos fetch failed: " + error.message });

  // Resolve vendor name → id map for rows missing vendor_id.
  const { data: vendorRows } = await admin.from("vendors").select("id, name");
  const vendorByName = new Map();
  for (const v of vendorRows ?? []) vendorByName.set((v.name || "").toLowerCase(), v.id);

  // Existing po_issued notifications keyed by metadata.po_id.
  const poIds = (pos || []).map((p) => p.uuid_id).filter(Boolean);
  let notifiedIds = new Set();
  if (poIds.length > 0) {
    const { data: existing } = await admin
      .from("notifications")
      .select("metadata")
      .eq("event_type", "po_issued")
      .in("metadata->>po_id", poIds);
    for (const row of existing || []) {
      const id = row?.metadata?.po_id;
      if (id) notifiedIds.add(id);
    }
  }

  const result = { considered: pos?.length || 0, fired: 0, skipped_already_notified: 0, skipped_no_vendor: 0, vendor_id_backfilled: 0 };

  for (const po of pos || []) {
    if (!po.uuid_id) continue;
    if (notifiedIds.has(po.uuid_id)) { result.skipped_already_notified++; continue; }

    let vendorId = po.vendor_id;
    if (!vendorId) {
      const name = (po.vendor || po.data?.VendorName || "").toLowerCase();
      vendorId = vendorByName.get(name) || null;
      if (vendorId) {
        // Best-effort backfill so future runs (and RLS-scoped reads) hit fast paths.
        try {
          await admin.from("tanda_pos").update({ vendor_id: vendorId }).eq("uuid_id", po.uuid_id);
          result.vendor_id_backfilled++;
        } catch { /* non-blocking */ }
      }
    }
    if (!vendorId) { result.skipped_no_vendor++; continue; }

    await sendNotification(origin, {
      event_type: "po_issued",
      title: `New PO issued · ${po.po_number}`,
      body: `Ring of Fire has issued PO ${po.po_number}. Log in to acknowledge and review line items.`,
      link: `/vendor/pos/${po.uuid_id}`,
      metadata: { po_id: po.uuid_id, po_number: po.po_number, vendor_id: vendorId },
      recipient: { vendor_id: vendorId },
      dedupe_key: `po_issued_${po.uuid_id}`,
      email: true,
    });
    result.fired++;
  }

  return res.status(200).json(result);
}
