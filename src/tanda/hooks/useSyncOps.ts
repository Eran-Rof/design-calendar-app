import { useRef } from "react";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { type XoroPO, type SyncFilters, mapXoroRaw } from "../../utils/tandaTypes";
import { getArchiveDecisions } from "../syncLogic";
import type { SyncLogEntry } from "../state/sync/syncTypes";
import { useTandaStore } from "../store/index";

// ── Xoro fetch helpers (module-level, same as TandA.tsx) ─────────────────────

interface XoroFetchOpts {
  page?: number;
  fetchAll?: boolean;
  signal?: AbortSignal;
  statuses?: string[];
  vendors?: string[];
  poNumber?: string;
  dateFrom?: string;
  dateTo?: string;
}

function applyFilters(pos: XoroPO[], filters?: SyncFilters): XoroPO[] {
  if (!filters) return pos;
  return pos.filter(po => {
    if (filters.poNumbers?.length && !filters.poNumbers.some(pn => (po.PoNumber ?? "").toLowerCase().includes(pn.toLowerCase()))) return false;
    if (filters.statuses?.length && !filters.statuses.includes(po.StatusName ?? "")) return false;
    if (filters.vendors?.length && !filters.vendors.some(v => v.toLowerCase() === (po.VendorName ?? "").toLowerCase())) return false;
    if (filters.dateFrom) {
      const d = po.DateOrder ? new Date(po.DateOrder) : null;
      if (!d || d < new Date(filters.dateFrom)) return false;
    }
    if (filters.dateTo) {
      const d = po.DateOrder ? new Date(po.DateOrder) : null;
      if (!d || d > new Date(filters.dateTo + "T23:59:59")) return false;
    }
    return true;
  });
}

// ── Supabase helper (same shape as TandA.tsx sb) ─────────────────────────────
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    insert: async (rows: any) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: SB_HEADERS, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any, opts?: { onConflict?: string }) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const url = `${SB_URL}/rest/v1/${table}${opts?.onConflict ? `?on_conflict=${opts.onConflict}` : ""}`;
      const res = await fetch(url, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
    single: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}&limit=1`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data: Array.isArray(data) ? data[0] ?? null : null, error: res.ok ? null : data };
    },
  }),
};

export { fetchXoroPOs, applyFilters };

async function fetchXoroPOs(opts: XoroFetchOpts = {}): Promise<{ pos: XoroPO[]; totalPages: number }> {
  const { page = 1, fetchAll = false, signal, statuses, vendors, poNumber, dateFrom, dateTo } = opts;
  const params = new URLSearchParams({ path: "purchaseorder/getpurchaseorder", per_page: "200", page_size: "200", pagesize: "200", rows: "200", limit: "200", RecordsPerPage: "200", PageSize: "200", itemsPerPage: "200" });
  if (fetchAll) { params.set("fetch_all", "true"); } else { params.set("page", String(page)); }
  // Only set status when caller explicitly provides one. Xoro's server-side
  // status filter is unreliable (drops rows for multi-word values, ignores
  // comma lists) — omitting it forces a full dataset that we filter client-side.
  if (statuses?.length) params.set("status", statuses.join(","));
  if (vendors?.length) params.set("vendor_name", vendors.join(","));
  if (poNumber) params.set("order_number", poNumber);
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d.getTime())) params.set("created_at_min", d.toISOString());
  }
  if (dateTo) {
    const d = new Date(dateTo + "T23:59:59");
    if (!isNaN(d.getTime())) params.set("created_at_max", d.toISOString());
  }
  // 120s per-request timeout covers a full paginated fetch_all from the proxy.
  const timeoutCtl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtl.abort(), 120000);
  const onAbort = () => timeoutCtl.abort();
  if (signal) {
    if (signal.aborted) timeoutCtl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(`/api/xoro-proxy?${params}`, { signal: timeoutCtl.signal });
  } catch (err: any) {
    if (timeoutCtl.signal.aborted && !signal?.aborted) {
      throw new Error("Xoro proxy timed out after 30s");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  if (!res.ok) throw new Error(`Xoro proxy error: ${res.status}`);
  const json = await res.json();
  if (!json.Result) {
    if (Array.isArray(json.Data) && json.Data.length > 0) {
      // Has data despite Result:false — use it
    } else {
      return { pos: [], totalPages: 0 };
    }
  }
  const raw = Array.isArray(json.Data) ? json.Data : [];
  if (json._pagesActuallyFetched) console.log(`[Xoro] pages fetched: ${json._pagesActuallyFetched}, records: ${raw.length}`);
  return { pos: mapXoroRaw(raw), totalPages: json.TotalPages ?? 1 };
}

// ── Dependencies that live in TandA.tsx and must be injected ─────────────────
export interface SyncOpsDeps {
  archivePO: (poNumber: string) => Promise<void>;
  loadCachedPOs: () => Promise<void>;
  syncVendorsToDC: (replace: boolean, vendorNames: string[]) => Promise<void>;
  addHistory: (poNumber: string, description: string) => Promise<void>;
}

export function useSyncOps(deps: SyncOpsDeps) {
  const syncAbortRef = useRef<AbortController | null>(null);

  // ── Cancel sync ─────────────────────────────────────────────────────────
  function cancelSync() {
    syncAbortRef.current?.abort();
    syncAbortRef.current = null;
    const store = useTandaStore.getState();
    store.setSyncField("syncing", false);
    store.setSyncField("syncErr", "Sync cancelled.");
  }

  // ── Sync log helpers ─────────────────────────────────────────────────────
  async function loadSyncLog() {
    try {
      const res = await sb.from("app_data").single("value", "key=eq.tanda_sync_log");
      if (res.data?.value) useTandaStore.getState().setSyncField("syncLog", JSON.parse(res.data.value) || []);
    } catch(_) {}
  }

  async function appendSyncLog(entry: SyncLogEntry) {
    const syncLog = useTandaStore.getState().syncLog;
    const next = [entry, ...syncLog].slice(0, 10); // keep last 10 sync events
    useTandaStore.getState().setSyncField("syncLog", next);
    try {
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "tanda_sync_log", value: JSON.stringify(next) }),
      });
    } catch(_) {}
  }

  // ── Sync from Xoro with filters ───────────────────────────────────────────
  async function syncFromXoro(filters?: SyncFilters) {
    const store = useTandaStore.getState();
    const setSyncField = store.setSyncField;

    // Abort any previous sync
    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    // Capture applied filters before resetting state
    const appliedFilters = filters && (
      (filters.vendors?.length ?? 0) > 0 ||
      (filters.statuses?.length ?? 0) > 0 ||
      (filters.poNumbers?.length ?? 0) > 0 ||
      filters.dateFrom || filters.dateTo
    ) ? {
      vendors: filters.vendors?.length ? filters.vendors : undefined,
      statuses: filters.statuses?.length ? filters.statuses : undefined,
      poNumbers: filters.poNumbers?.length ? filters.poNumbers : undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
    } : undefined;

    setSyncField("syncing", true);
    setSyncField("syncErr", "");
    setSyncField("syncDone", null);
    setSyncField("syncProgress", 0);
    setSyncField("syncProgressMsg", "Connecting to Xoro\u2026");
    setSyncField("showSyncModal", false);
    setSyncField("syncFilters", { poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] });
    try {
      // Xoro's `status` param works per single value but silently ignores
      // comma-joined lists (returns only terminal POs). Fan out one request
      // per status, in parallel. Scope the list to the 6 statuses we care
      // about (drops Pending/Draft from the old 8-status fan-out) to keep
      // concurrent fetches low enough to avoid rate-limit timeouts.
      const ACTIVE_FETCH_STATUSES = ["Open", "Released", "Partially Received"];
      const TERMINAL_FETCH_STATUSES = ["Received", "Closed", "Cancelled"];
      const statusList = filters?.statuses?.length
        ? filters.statuses
        : [...ACTIVE_FETCH_STATUSES, ...TERMINAL_FETCH_STATUSES];
      const apiPoNumber = filters?.poNumbers?.length === 1 ? filters.poNumbers[0] : undefined;

      setSyncField("syncProgressMsg", "Fetching POs from Xoro\u2026");
      setSyncField("syncProgress", 10);

      const baseFetchOpts = { fetchAll: true, signal: controller.signal, vendors: filters?.vendors, poNumber: apiPoNumber, dateFrom: filters?.dateFrom, dateTo: filters?.dateTo };
      // Batch at 2 with a short stagger between batches. 3 was still tripping
      // Xoro's per-caller rate limit for Released/Cancelled buckets.
      const CONCURRENCY = 2;
      const BATCH_DELAY_MS = 600;
      const statusResults: PromiseSettledResult<{ pos: XoroPO[]; totalPages: number }>[] = [];
      const [, existingRowsRes] = await Promise.all([
        (async () => {
          for (let i = 0; i < statusList.length; i += CONCURRENCY) {
            if (i > 0) await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            const batch = statusList.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.allSettled(
              batch.map(status => fetchXoroPOs({ ...baseFetchOpts, statuses: [status] }))
            );
            statusResults.push(...batchResults);
          }
        })(),
        sb.from("tanda_pos").select("po_number,data,buyer_po"),
      ]);

      let all: XoroPO[] = [];
      const errors: string[] = [];
      for (let i = 0; i < statusResults.length; i++) {
        const result = statusResults[i];
        if (result.status === "fulfilled") {
          const pos = Array.isArray(result.value?.pos) ? result.value.pos : [];
          all = [...all, ...pos];
        } else {
          errors.push(`${statusList[i]}: ${(result as PromiseRejectedResult).reason?.message ?? "unknown"}`);
        }
      }
      if (statusResults.every(r => r.status === "rejected")) {
        throw new Error(`Xoro sync failed: ${errors[0] ?? "all fetches rejected"}`);
      }

      // Apply non-status filters (vendor/poNumber/date) only. Status is applied
      // later so terminal-status POs still flow through to archive detection.
      all = applyFilters(all, filters ? { ...filters, statuses: [] } : undefined);

      setSyncField("syncProgress", 78);

      const { data: existingRows } = existingRowsRes;
      const existingMap = new Map<string, XoroPO>(
        (existingRows ?? []).map((r: any) => [r.po_number as string, r.data as XoroPO])
      );
      // Treat any non-empty buyer_po in the DB as a user override and keep it
      // on subsequent syncs. Clearing the field reopens it to Xoro's value.
      const existingBuyerPoMap = new Map<string, string>(
        (existingRows ?? []).map((r: any) => [r.po_number as string, (r.buyer_po ?? "") as string])
      );

      // Active set for DB: user's selection if any, else the "active" defaults.
      // Match loosely (lowercase + collapsed whitespace) so Xoro variants like
      // "OPEN", "Partial Received", "partially received" all still qualify.
      const DEFAULT_ACTIVE_STATUSES = ["Open", "Released", "Partially Received"];
      const normalizeStatus = (s: string) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
      const rawActive = filters?.statuses?.length ? filters.statuses : DEFAULT_ACTIVE_STATUSES;
      const activeSet = new Set(rawActive.map(normalizeStatus));
      // "Partially Received" and "Partial Received" should both match when
      // either is requested — treat the two as synonyms.
      if (activeSet.has("partially received")) activeSet.add("partial received");
      if (activeSet.has("partial received")) activeSet.add("partially received");

      const synced = all.filter(po => activeSet.has(normalizeStatus(po.StatusName ?? "")));

      const addedPOs = synced.filter(po => !existingMap.has(po.PoNumber ?? ""));
      // Always update ALL existing POs to ensure QtyReceived/QtyRemaining data is fresh
      const changedPOs = synced.filter(po => existingMap.has(po.PoNumber ?? ""));
      const addedCount   = addedPOs.length;
      const changedCount = changedPOs.length;
      const toUpsert     = [...addedPOs, ...changedPOs];

      setSyncField("syncProgress", 85);
      setSyncField("syncProgressMsg",
        toUpsert.length > 0
          ? `Saving ${toUpsert.length} new/changed PO${toUpsert.length !== 1 ? "s" : ""} to database\u2026`
          : "No changes detected, skipping database write\u2026"
      );

      const now = new Date().toISOString();
      if (toUpsert.length > 0) {
        const { error: upsertError } = await sb.from("tanda_pos").upsert(
          toUpsert.map(po => {
            const poNum = po.PoNumber ?? `unknown-${Math.random()}`;
            const userBuyerPo = existingBuyerPoMap.get(poNum) || "";
            const buyerPo = userBuyerPo || po.BuyerPo || "";
            return {
              po_number:     poNum,
              vendor:        po.VendorName ?? "",
              date_order:    po.DateOrder ?? null,
              date_expected: po.DateExpectedDelivery ?? null,
              status:        po.StatusName ?? "",
              buyer_po:      buyerPo || null,
              data:          { ...po, BuyerPo: buyerPo },
              synced_at:     now,
            };
          }),
          { onConflict: "po_number" }
        );
        if (upsertError) {
          const msg = (upsertError as any)?.message || (upsertError as any)?.hint || JSON.stringify(upsertError);
          throw new Error(`Failed to save POs to database: ${msg}`);
        }
      }

      setSyncField("syncProgress", 88);
      setSyncField("syncProgressMsg", "Archiving closed/received/deleted POs\u2026");

      const cachedRows = (existingRows ?? []).map((r: any) => ({ po_number: r.po_number as string, data: r.data as XoroPO }));

      // Only check for missing POs on a full unfiltered sync (fetch already
      // succeeded or we'd have thrown above).
      const isFullSync = !filters?.poNumbers?.length && !filters?.vendors?.length && !filters?.dateFrom && !filters?.dateTo && !filters?.statuses?.length;
      // One fetch returns all statuses — any cached PO absent from `all` is
      // genuinely missing from Xoro. Pass a sentinel Set to enable source-3
      // archive detection (the Set's contents aren't used, just the non-null check).
      const statusesWithResults = new Set<string>(all.map(po => po.StatusName ?? "").filter(Boolean));

      const archiveDecisions = getArchiveDecisions(all, cachedRows, isFullSync ? statusesWithResults : null);
      const archiveFailures: Array<{ poNumber: string; error: string }> = [];
      for (const { poNumber, freshData } of archiveDecisions) {
        try {
          if (freshData) {
            // Source 1: Xoro returned the PO as terminal — archive with fresh data so
            // the status label is correct (e.g. "Received" not the stale "Released").
            const archivedData = { ...freshData, _archived: true, _archivedAt: now };
            const { error: archErr } = await sb.from("tanda_pos").upsert({ po_number: poNumber, vendor: freshData.VendorName ?? "", status: freshData.StatusName ?? "", data: archivedData, synced_at: now }, { onConflict: "po_number" });
            if (archErr) {
              const msg = (archErr as any)?.message || JSON.stringify(archErr);
              throw new Error(msg);
            }
            useTandaStore.getState().removePo(poNumber);
            const selected = useTandaStore.getState().selected;
            if (selected?.PoNumber === poNumber) useTandaStore.getState().setCoreField("selected", null);
          } else {
            // Source 2/3: PO has a terminal status in the DB, or is absent from ALL
            // Xoro status buckets (deleted). Archive using existing DB data.
            await deps.archivePO(poNumber);
          }
        } catch (err: any) {
          const msg = err?.message || String(err);
          console.warn(`Archive failed for ${poNumber}:`, msg);
          archiveFailures.push({ poNumber, error: msg });
        }
      }
      const deletedCount = archiveDecisions.length - archiveFailures.length;
      if (archiveFailures.length > 0) {
        const sample = archiveFailures.slice(0, 3).map(f => f.poNumber).join(", ");
        const more = archiveFailures.length > 3 ? ` +${archiveFailures.length - 3} more` : "";
        setSyncField("syncErr", `Sync completed but ${archiveFailures.length} PO${archiveFailures.length === 1 ? "" : "s"} failed to archive (${sample}${more}). Check console for details.`);
      }

      setSyncField("syncProgress", 95);
      setSyncField("syncProgressMsg", "Reloading PO cache\u2026");
      await deps.loadCachedPOs();

      // Auto-add any new vendor names from this sync into Design Calendar
      const syncedVendorNames = Array.from(new Set(synced.map(po => po.VendorName ?? "").filter(Boolean))) as string[];
      if (syncedVendorNames.length > 0) {
        setSyncField("syncProgressMsg", "Syncing new vendors to Design Calendar\u2026");
        await deps.syncVendorsToDC(false, syncedVendorNames);
      }

      setSyncField("lastSync", now);
      setSyncField("syncProgress", 100);

      const user = useTandaStore.getState().user;
      for (const po of synced.slice(0, 5)) {
        deps.addHistory(po.PoNumber ?? "", `PO synced from Xoro (${synced.length} POs in batch${deletedCount > 0 ? `, ${deletedCount} removed` : ""})`);
      }
      if (synced.length > 5) deps.addHistory(synced[0]?.PoNumber ?? "", `... and ${synced.length - 5} more POs synced`);

      setSyncField("syncDone", { added: addedCount, changed: changedCount, deleted: deletedCount });
      await appendSyncLog({ ts: new Date().toISOString(), user: user?.name || "Unknown", success: true, added: addedCount, changed: changedCount, deleted: deletedCount, filters: appliedFilters });
    } catch (e: any) {
      const errMsg = e.name === "AbortError" ? "Sync timed out or was cancelled" : (e.message ?? "Sync failed");
      if (e.name === "AbortError") setSyncField("syncErr", "Sync timed out or was cancelled. Check your Xoro API credentials and try again.");
      else setSyncField("syncErr", e.message ?? "Sync failed");
      const user = useTandaStore.getState().user;
      await appendSyncLog({ ts: new Date().toISOString(), user: user?.name || "Unknown", success: false, added: 0, changed: 0, deleted: 0, error: errMsg, filters: appliedFilters });
    } finally {
      syncAbortRef.current = null;
      setSyncField("syncing", false);
      setSyncField("syncProgress", 0);
      setSyncField("syncProgressMsg", "");
    }
  }

  return { cancelSync, syncFromXoro, loadSyncLog, appendSyncLog, syncAbortRef };
}
