// POST /api/tanda/sync-from-xoro — server-side Xoro→tanda_pos refresh.
//
// The browser-side useSyncOps.ts has done this work since day one (fan
// out per-status fetches → upsert tanda_pos), but it only runs when
// someone clicks "Sync" in the PO WIP UI. The nightly pipeline needs the
// same refresh without a browser. This endpoint is the missing half of
// the chain:
//
//   Xoro  ──(this endpoint)──▶  tanda_pos  ──(/api/planning/sync-open-pos)──▶  ip_open_purchase_orders
//
// The downstream half already exists in api/_lib/planning-sync.js
// (syncOpenPosFromTandaPos). Nightly script post_purchase_orders.py
// calls both endpoints in sequence.
//
// Active-status scope: Open + Released + Partially Received. Terminal
// statuses (Received/Closed/Cancelled) are deliberately NOT fetched —
// the planning grid only cares about not-yet-received supply, and the
// browser's archive logic only needs to run when the user is looking at
// the UI. For nightly cleanup, syncOpenPosFromTandaPos's qty_open<=0
// filter already drops fully-received POs from ip_open_purchase_orders.
//
// Buyer_po preservation: when a user has set a custom BuyerPo in the UI
// (stored in tanda_pos.buyer_po), we preserve it across nightly syncs.
// Mirrors the existing useSyncOps.ts behaviour at line 297-307.
//
// Auth: bearer DESIGN_CALENDAR_API_TOKEN (same gate post_to_ats.py /
// post_master_data.py / post_invoice_detail.py use).

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchXoroAll } from "../../_lib/xoro-client.js";
import { authenticateDesignCalendarCaller, rateLimit } from "../../_lib/auth.js";

export const config = { maxDuration: 300 };

const PO_PATH = "purchaseorder/getpurchaseorder";
const ACTIVE_STATUSES = ["Open", "Released", "Partially Received"];
// Mirror src/tanda/syncLogic.ts AUTO_ARCHIVE_STATUSES + isPartial guard.
// "Partially Received" matches "Partial" so it's deliberately excluded
// from the terminal set here — stays active.
const TERMINAL_STATUSES = ["Received", "Closed", "Cancelled"];
const ALL_STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];
// Max per-PO re-fetches per run for the "disappeared-active" catch (see below).
// Single-PO fetches by order_number are fast, but the first run has a backlog
// of every stale-active PO — cap it so the run stays well under the 300s
// function timeout and drains over a few nights.
const REFETCH_CAP = 50;

function isPartial(s) {
  return (s || "").toLowerCase().includes("partial");
}
function shouldArchive(statusName) {
  return TERMINAL_STATUSES.includes(statusName) && !isPartial(statusName);
}

// Flatten Xoro's wrapped PO shape ({ poHeader: {...}, poLines: [...] })
// into the flat shape the browser-side useSyncOps writes to tanda_pos
// (PoNumber, VendorName, ... at the top level + Items: [...] for lines).
// This MUST mirror src/utils/tandaTypes.ts::mapXoroRaw() — same lookup
// keys, same fallback chain — so tanda_pos rows written by the nightly
// agent are indistinguishable from rows written by the PO WIP UI.
//
// Why flatten here, not let downstream do it: api/_lib/planning-sync.js
// (syncOpenPosFromTandaPos) reads po.PoLineArr / po.Items only — it
// won't recognize Xoro's poLines array. Writing the wrapped shape would
// silently drop every PO's line items at promote time.
function flattenXoroPo(raw) {
  const h = raw?.poHeader ?? raw ?? {};
  const lines = Array.isArray(raw?.poLines) ? raw.poLines
              : Array.isArray(raw?.PoLineArr) ? raw.PoLineArr
              : Array.isArray(raw?.Items) ? raw.Items
              : [];
  return {
    PoNumber:              h.OrderNumber ?? h.PoNumber ?? "",
    VendorName:            h.VendorName ?? "",
    DateOrder:             h.DateOrder ?? "",
    DateExpectedDelivery:  h.DateExpectedDelivery ?? "",
    VendorReqDate:         h.VendorReqDate ?? "",
    StatusName:            h.StatusName ?? "",
    CurrencyCode:          h.CurrencyCode ?? "USD",
    Memo:                  h.Memo ?? "",
    Tags:                  h.Tags ?? "",
    PaymentTermsName:      h.PaymentTermsName ?? "",
    ShipMethodName:        h.ShipMethodName ?? "",
    CarrierName:           h.CarrierName ?? "",
    BuyerName:             h.BuyerName ?? "",
    BuyerPo:               h.ReferenceNumber ?? h.RefNumber ?? h.BuyerOrderNumber ?? h.BuyerPo ?? "",
    BrandName:             h.BrandName ?? h.Brand ?? "",
    TotalAmount:           h.TotalAmount ?? 0,
    Items: lines.map((l) => ({
      ItemNumber:           l.PoItemNumber ?? l.ItemNumber ?? "",
      Description:          l.Description ?? l.Title ?? "",
      QtyOrder:             l.QtyOrder ?? 0,
      QtyReceived:          l.QtyReceived ?? 0,
      QtyRemaining:         l.QtyRemaining ?? ((l.QtyOrder ?? 0) - (l.QtyReceived ?? 0)),
      UnitPrice:            l.UnitPrice ?? l.EffectiveUnitPrice ?? 0,
      StatusName:           l.StatusName ?? l.Status ?? l.LineStatusName ?? "",
      DateExpectedDelivery: l.DateExpectedDelivery ?? l.DeliveryDate ?? l.DateDelivery ?? l.DateExpected ?? "",
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = authenticateDesignCalendarCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // Match the cadence the other Design Calendar scriptable endpoints use
  // (master/sync = 12/hr, sales/sync-invoices = 30/hr). PO sync is a
  // single nightly call; 12/hr is plenty and keeps the budget tight in
  // case a flaky pipeline retries hard.
  const tokenTail = (req.headers.authorization || "").slice(-8) || "anon";
  const rl = rateLimit(`tanda-sync-from-xoro:${tokenTail}`, { limit: 12, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return res.status(rl.status).json({ error: rl.error, retry_after_s: rl.retry_after_s });

  const SB_URL = (process.env.VITE_SUPABASE_URL || "").trim();
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const requestId = randomUUID();
  const startedAtIso = new Date().toISOString();
  const result = {
    request_id: requestId,
    statuses_fetched: ACTIVE_STATUSES,
    xoro_pages_walked: 0,
    xoro_pos_returned: 0,
    pos_unique_after_dedup: 0,
    upserted: 0,
    active_upserted: 0,
    archived_total: 0,
    archived_source_xoro_terminal: 0,
    archived_source_cache_terminal: 0,
    archived_source_missing_from_xoro: 0,
    refetch_candidates: 0,
    refetch_billed_prioritized: 0,
    refetch_done: 0,
    refetch_archived: 0,
    refetch_refreshed: 0,
    refetch_not_found: 0,
    refetch_failed: 0,
    skipped_no_po_number: 0,
    skipped_tombstoned: 0,
    user_archived_preserved: 0,
    buyer_po_preserved: 0,
    native_reconcile_received: 0,
    native_reconcile_cancelled: 0,
    native_reconcile_ambiguous: 0,
    per_status: [],
    errors: [],
  };

  try {
    // 1. Fan out Xoro fetches sequentially across ALL 6 statuses (3 active +
    //    3 terminal). Parallel fan-out trips Xoro rate limits (the browser
    //    uses CONCURRENCY=2 + 600ms stagger; server-side we have time, so
    //    go strictly sequential).
    //
    //    Why fetch terminals: source-1 archive detection (per
    //    src/tanda/syncLogic.ts::getArchiveDecisions) needs to see POs
    //    that have flipped to Received/Closed/Cancelled in Xoro since the
    //    last sync. Without this, tanda_pos accumulates stale "active"
    //    rows whose Xoro counterpart is already done. Discovered when
    //    PO WIP showed 206 active POs but Xoro showed 141 — the 65 stale
    //    rows polluted ip_open_purchase_orders with phantom open supply.
    // Active statuses only (3 fetches). Terminal-status fetches were
    // attempted twice and both hit Vercel FUNCTION_INVOCATION_TIMEOUT
    // (300s cap) — even with the terminal-page cap of 10 and CONCURRENCY=2
    // fan-out. Likely cause: Xoro's per-page response latency on Received
    // status is variable enough that the 90s-per-attempt × 3-retry budget
    // can exhaust the function timeout on one stuck page.
    //
    // Trade-off: source-1 archive (POs that flipped to terminal in Xoro
    // since last sync) requires the terminal-status fetches we just
    // dropped. Without source-1, terminal POs stay marked active in
    // tanda_pos until somebody clicks Sync in PO WIP (browser does the
    // full 6-status walk). The user explicitly accepted this trade-off —
    // see commit message + memory.
    //
    // Source-2 + source-3 archive (cached-already-terminal, missing-from-
    // Xoro-with-cached-terminal) still run below — they need only the
    // active-status results to compare against.
    const allRaw = [];
    let allStatusesSucceeded = true;
    for (const status of ACTIVE_STATUSES) {
      const r = await fetchXoroAll({
        path: PO_PATH,
        params: { per_page: "200", status },
      });
      const pageCount = Array.isArray(r.body?._pageCounts) ? r.body._pageCounts.length : 0;
      const records = Array.isArray(r.body?.Data) ? r.body.Data : [];
      result.xoro_pages_walked += pageCount;
      result.xoro_pos_returned += records.length;
      result.per_status.push({ status, pages: pageCount, records: records.length, ok: !!r.ok });
      if (!r.ok) {
        allStatusesSucceeded = false;
        result.errors.push(`status=${status}: ${r.body?.error || r.body?.Message || "fetch failed"}`);
        continue;
      }
      allRaw.push(...records);
    }
    if (allRaw.length === 0 && result.errors.length > 0) {
      return res.status(502).json({ ...result, error: "All status fetches failed" });
    }

    // 2. Flatten + dedup by PoNumber. A PO that flips status mid-walk
    //    can appear in more than one bucket; the active fetch comes
    //    first in ALL_STATUSES so a still-active PO wins over a stale
    //    terminal sighting.
    const byPo = new Map();
    for (const raw of allRaw) {
      const flat = flattenXoroPo(raw);
      const poNumber = String(flat.PoNumber ?? "").trim();
      if (!poNumber) { result.skipped_no_po_number++; continue; }
      if (!byPo.has(poNumber)) byPo.set(poNumber, flat);
    }
    result.pos_unique_after_dedup = byPo.size;
    if (byPo.size === 0) {
      return res.status(200).json(result);
    }

    // 3. Pull existing tanda_pos rows. Need full data field this time
    //    (not just buyer_po) so the archive logic can read each row's
    //    last known status + _archived flag.
    const cachedByPo = new Map();
    {
      let offset = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await admin
          .from("tanda_pos")
          .select("po_number, buyer_po, data")
          .order("po_number", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) {
          result.errors.push(`tanda_pos lookup: ${error.message}`);
          break;
        }
        if (!data || data.length === 0) break;
        for (const r of data) cachedByPo.set(r.po_number, r);
        if (data.length < PAGE) break;
        offset += PAGE;
      }
    }

    // 3b. Load tombstones. A tombstoned po_number is a PO the user has
    //     permanently-deleted from PO WIP. We must NOT upsert it back even
    //     if Xoro still reports the PO as active — otherwise the delete
    //     silently reverses on the next nightly run (the bug that motivated
    //     the tombstone table; see migration 20260629C00000).
    const tombstoned = new Set();
    {
      const { data, error } = await admin
        .from("tanda_po_tombstones")
        .select("po_number");
      if (error) {
        result.errors.push(`tombstone lookup: ${error.message}`);
      } else if (Array.isArray(data)) {
        for (const r of data) tombstoned.add(r.po_number);
      }
    }
    for (const poNumber of [...byPo.keys()]) {
      if (tombstoned.has(poNumber)) {
        byPo.delete(poNumber);
        result.skipped_tombstoned++;
      }
    }

    // 4. Decide which POs to archive. Mirrors src/tanda/syncLogic.ts::
    //    getArchiveDecisions exactly — three sources, same guards.
    const archiveByPo = new Map(); // poNumber → flat-or-null
    // Source 1: Xoro returned PO as terminal AND it was previously cached.
    // Skips first-time-seen terminals so a fresh sync doesn't pull historical
    // archived POs into the app.
    for (const [poNumber, flat] of byPo) {
      if (shouldArchive(flat.StatusName) && cachedByPo.has(poNumber)) {
        archiveByPo.set(poNumber, flat);
        result.archived_source_xoro_terminal++;
      }
    }
    // Source 2: Cached PO already has terminal status but isn't yet
    // marked _archived. (Catches catch-up on POs missed by source 1
    // because Xoro paginated them off the visible window.)
    for (const [poNumber, row] of cachedByPo) {
      if (archiveByPo.has(poNumber)) continue;
      if (row.data?._archived) continue;
      if (shouldArchive(row.data?.StatusName ?? "")) {
        archiveByPo.set(poNumber, null);
        result.archived_source_cache_terminal++;
      }
    }
    // Source 3: PO completely missing from Xoro AND last known status was
    // terminal. Only safe when ALL status fetches succeeded — partial
    // failures could create false positives. Mirrors syncLogic.ts:81-83
    // (skips Partially Received explicitly).
    if (allStatusesSucceeded) {
      for (const [poNumber, row] of cachedByPo) {
        if (archiveByPo.has(poNumber) || row.data?._archived) continue;
        if (byPo.has(poNumber)) continue;
        const lastStatus = row.data?.StatusName ?? "";
        if (shouldArchive(lastStatus)) {
          archiveByPo.set(poNumber, null);
          result.archived_source_missing_from_xoro++;
        }
      }
    }
    // Source 1b (disappeared-active re-fetch): a PO that flips to
    //   Received/Closed in Xoro DROPS OUT of the active-status fetch while
    //   still cached as Open/Released/Partially Received. Sources 1-3 miss it
    //   (its CACHED status isn't terminal, and terminal statuses aren't
    //   fetched wholesale — that walk times out). Re-fetch each such PO by
    //   order_number (a single-PO query, fast, no full-terminal walk) to get
    //   its authoritative current status; archive if terminal, else refresh.
    //   Capped per run; only when all active fetches succeeded (else a missing
    //   PO may just be a failed page, not a real disappearance).
    if (allStatusesSucceeded) {
      const candidates = [];
      for (const [poNumber, row] of cachedByPo) {
        if (archiveByPo.has(poNumber) || row.data?._archived) continue;
        if (byPo.has(poNumber) || tombstoned.has(poNumber)) continue;
        const lastStatus = row.data?.StatusName ?? "";
        if (ACTIVE_STATUSES.includes(lastStatus) || isPartial(lastStatus)) candidates.push(poNumber);
      }
      result.refetch_candidates = candidates.length;
      // Prioritize candidates that have an AP bill (invoice_line_items.po_number)
      // — a bill is a strong "this PO was received" signal, so those most
      // likely flipped terminal. Fetch them first within the per-run cap so the
      // real received POs are corrected fastest. Only worth querying when the
      // candidate list exceeds the cap.
      let ordered = candidates;
      if (candidates.length > REFETCH_CAP) {
        const billed = new Set();
        for (let i = 0; i < candidates.length; i += 500) {
          const { data } = await admin
            .from("invoice_line_items")
            .select("po_number")
            .in("po_number", candidates.slice(i, i + 500));
          for (const r of data || []) if (r.po_number) billed.add(r.po_number);
        }
        result.refetch_billed_prioritized = candidates.filter((p) => billed.has(p)).length;
        ordered = [...candidates].sort((a, b) => (billed.has(b) ? 1 : 0) - (billed.has(a) ? 1 : 0));
      }
      for (const poNumber of ordered.slice(0, REFETCH_CAP)) {
        const r = await fetchXoroAll({ path: PO_PATH, params: { per_page: "200", order_number: poNumber } });
        if (!r.ok) { result.refetch_failed++; continue; }
        result.refetch_done++;
        const recs = Array.isArray(r.body?.Data) ? r.body.Data : [];
        const match = recs.map(flattenXoroPo).find((f) => String(f.PoNumber ?? "").trim() === poNumber);
        if (!match) { result.refetch_not_found++; continue; } // deleted/hidden — leave for a later run
        if (shouldArchive(match.StatusName)) {
          archiveByPo.set(poNumber, match); // fresh terminal data → archive pass below
          result.refetch_archived++;
        } else {
          byPo.set(poNumber, match); // still active (was paginated off) → active-upsert refreshes it
          result.refetch_refreshed++;
        }
      }
    }

    result.archived_total = archiveByPo.size;

    // 5. Build active-upsert rows. Skip POs that are heading to archive —
    //    they get their own upsert pass below with _archived=true.
    const now = new Date().toISOString();
    const activeRows = [];
    for (const [poNumber, flat] of byPo) {
      if (archiveByPo.has(poNumber)) continue;
      const isActive = ACTIVE_STATUSES.includes(flat.StatusName) || isPartial(flat.StatusName);
      if (!isActive) continue; // a terminal-status PO not in archive set (never previously cached) — skip
      const cached = cachedByPo.get(poNumber);
      const userBuyerPo = (cached?.buyer_po) || "";
      const buyerPo = userBuyerPo || flat.BuyerPo || "";
      if (userBuyerPo) result.buyer_po_preserved++;
      // Preserve a user-set `_archived: true` from the cached row. The
      // previous code stamped `_archived: false` on every active upsert,
      // which silently reversed every manual Archive action in PO WIP
      // (Xoro keeps reporting the PO as Open/Released, so the sync wiped
      // the flag on the next run). User-initiated archive sticks; un-
      // archive is still possible from the PO WIP UI (writes false).
      const wasUserArchived = cached?.data?._archived === true;
      if (wasUserArchived) result.user_archived_preserved++;
      activeRows.push({
        po_number: poNumber,
        vendor: flat.VendorName ?? "",
        date_order: flat.DateOrder || null,
        date_expected: flat.DateExpectedDelivery || null,
        status: flat.StatusName ?? "",
        buyer_po: buyerPo || null,
        data: {
          ...flat,
          BuyerPo: buyerPo,
          ...(wasUserArchived
            ? { _archived: true, _archivedAt: cached.data._archivedAt ?? now }
            : { _archived: false }),
        },
        synced_at: now,
      });
    }

    // 6. Build archive-upsert rows. Mirrors useSyncOps.ts:387-393 — fresh
    //    Xoro data when available (source 1), else cached data (sources
    //    2 and 3) so the archive carries whatever the last known shape was.
    const archiveRows = [];
    for (const [poNumber, freshFlat] of archiveByPo) {
      const cached = cachedByPo.get(poNumber);
      const base = freshFlat ?? cached?.data ?? { PoNumber: poNumber };
      const buyerPo = (cached?.buyer_po) || base.BuyerPo || "";
      const archivedData = { ...base, _archived: true, _archivedAt: now, BuyerPo: buyerPo };
      archiveRows.push({
        po_number: poNumber,
        vendor: archivedData.VendorName ?? "",
        date_order: archivedData.DateOrder || null,
        date_expected: archivedData.DateExpectedDelivery || null,
        status: archivedData.StatusName ?? "",
        buyer_po: buyerPo || null,
        data: archivedData,
        synced_at: now,
      });
    }

    const rows = [...activeRows, ...archiveRows];
    result.active_upserted = activeRows.length;

    // 7. Upsert in chunks (Supabase REST tops out around 1MB body).
    //    `upserted` counts BOTH active and archive writes — the per-bucket
    //    breakdown lives in `active_upserted` + `archived_total`.
    let upsertedRowCount = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await admin
        .from("tanda_pos")
        .upsert(chunk, { onConflict: "po_number", ignoreDuplicates: false });
      if (error) {
        result.errors.push(`upsert chunk ${i}: ${error.message}`);
        continue;
      }
      upsertedRowCount += chunk.length;
    }
    result.upserted = upsertedRowCount;

    // 8. Reconcile the NATIVE purchase_orders table with Xoro's terminal state.
    //    The internal PO grid reads native `purchase_orders`; the Xoro import
    //    stamped their status once and NOTHING demotes them when Xoro later
    //    receives/closes the PO (it archives in tanda_pos, but the native copy
    //    stays draft/issued/in_transit) — so the grid over-reports open POs and
    //    value (observed: 248 native-active vs 132 truly active in Xoro, a
    //    $7.5M phantom-open overstatement). Each run, demote every [xoro-import]
    //    native PO that is still active but whose tanda_pos counterpart is
    //    ARCHIVED, to its true terminal status:
    //      • Received/Closed/Partially Received, or any line QtyReceived>0 → 'received'
    //      • Cancelled/Void                                               → 'cancelled'
    //      • archived Open/Released with no receipt + not cancelled-named  → LEAVE
    //        (ambiguous: could be a user-archived-but-open PO) and report the count.
    //    Never touches app-native POs (no [xoro-import] tag) or already-terminal
    //    rows. Best-effort: wrapped so a failure here never fails the tanda_pos sync.
    try {
      const { data: nativeActive, error: naErr } = await admin
        .from("purchase_orders")
        .select("id, po_number, notes")
        .in("status", ["draft", "issued", "partially_received", "in_transit"]);
      if (naErr) throw naErr;
      const candidates = (nativeActive || []).filter(
        (p) => p.po_number && String(p.notes || "").includes("[xoro-import]"),
      );
      if (candidates.length) {
        const nums = candidates.map((p) => p.po_number);
        const tandaByNum = new Map();
        for (let i = 0; i < nums.length; i += 500) {
          const { data } = await admin
            .from("tanda_pos")
            .select("po_number, data")
            .in("po_number", nums.slice(i, i + 500));
          for (const r of data || []) tandaByNum.set(r.po_number, r.data);
        }
        const toReceived = [], toCancelled = [];
        for (const p of candidates) {
          const d = tandaByNum.get(p.po_number);
          if (!d || d._archived !== true) continue; // still active in Xoro (or unknown) → leave
          const st = String(d.StatusName || "").toLowerCase();
          const items = Array.isArray(d.Items) ? d.Items : [];
          const anyReceived = items.some((i) => Number(i.QtyReceived ?? 0) > 0);
          if (st.includes("cancel") || st.includes("void")) toCancelled.push(p.id);
          else if (anyReceived || st.includes("receiv") || st.includes("closed")) toReceived.push(p.id);
          else result.native_reconcile_ambiguous++; // archived but no receipt signal — leave for review
        }
        for (const [ids, status] of [[toReceived, "received"], [toCancelled, "cancelled"]]) {
          for (let i = 0; i < ids.length; i += 200) {
            const { error } = await admin
              .from("purchase_orders")
              .update({ status })
              .in("id", ids.slice(i, i + 200));
            if (error) result.errors.push(`native reconcile ${status}: ${error.message}`);
          }
        }
        result.native_reconcile_received = toReceived.length;
        result.native_reconcile_cancelled = toCancelled.length;
      }
    } catch (e) {
      result.errors.push(`native reconcile failed: ${String(e?.message || e)}`);
    }

    // 9. Record the completed fetch in xoro_sync_logs. The 01:30 UTC
    //    xoro-mirror-nightly orchestrator gates on
    //    MAX(xoro_sync_logs.completed_at WHERE status='complete') < 25h —
    //    but NOTHING ever wrote this table, so the guard tripped every night
    //    and the AR/AP/inventory mirror + daily summary JEs silently skipped
    //    (37 skipped nights vs 3 manual backfills as of 2026-07-07). This
    //    endpoint runs near the END of the 21:00 nightly chain (and on the
    //    PO WIP Sync button), so its success is the freshness signal the
    //    guard was designed around. Best-effort: never fails the sync.
    try {
      await admin.from("xoro_sync_logs").insert({
        sync_type: "nightly_po_sync",
        status: "complete",
        started_at: startedAtIso,
        completed_at: new Date().toISOString(),
        records_processed: result.upserted || 0,
        raw_summary: { request_id: requestId, source: "tanda/sync-from-xoro" },
      });
    } catch (e) {
      result.errors.push(`xoro_sync_logs write failed: ${String(e?.message || e)}`);
    }

    return res.status(200).json(result);
  } catch (e) {
    console.error(`[tanda/sync-from-xoro ${requestId}] failed:`, e);
    return res.status(500).json({ ...result, error: "Sync failed", message: String(e?.message || e) });
  }
}
