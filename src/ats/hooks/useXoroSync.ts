import { useCallback, useState } from "react";
import type { ExcelData } from "../types";
import { dedupeExcelData } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import type { MergeOp } from "./useMergeHistory";

interface UseXoroSyncOpts {
  dates: string[];
  setExcelData: (v: ExcelData | null) => void;
  setRows: (v: any) => void;
  setLastSync: (v: string) => void;
  setMockMode: (v: boolean) => void;
  setMergeHistory: (v: MergeOp[]) => void;
  saveMergeHistory: (v: MergeOp[]) => Promise<void>;
  applyPOWIPData: (data: ExcelData) => Promise<ExcelData>;
}

interface SyncProgress {
  step: string;
  pct: number;
}

export function useXoroSync(opts: UseXoroSyncOpts) {
  const {
    dates, setExcelData, setRows, setLastSync, setMockMode,
    setMergeHistory, saveMergeHistory, applyPOWIPData,
  } = opts;

  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const syncFromXoro = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncProgress({ step: "Fetching inventory from Xoro…", pct: 10 });

    try {
      // Step 1: Fetch inventory + sales orders from the serverless endpoint
      const res = await fetch("/api/ats-sync?type=full", {
        signal: AbortSignal.timeout(55000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Sync failed" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      setSyncProgress({ step: "Processing Xoro data…", pct: 50 });
      const json = await res.json();
      if (!json.Result || !json.Data) {
        throw new Error(json.Message || json.error || "No data returned from Xoro");
      }

      let data: ExcelData = json.Data;
      const meta = (json.Data as any)._meta;
      delete (data as any)._meta;

      // Step 2: Apply PO data from PO WIP (tanda_pos) for timeline events.
      // The inventory API already set onOrder = QtyOnPO per item. We keep
      // that as the baseline and layer PO WIP events (pos[]) on top for
      // the date-based timeline. We do NOT zero out onOrder — if PO WIP
      // can't match a SKU, the inventory API total is still correct.
      setSyncProgress({ step: "Merging PO data from PO WIP…", pct: 65 });
      try {
        // Save original onOrder from inventory API
        const invOnOrder = new Map(data.skus.map(s => [s.sku, s.onOrder || 0]));
        const base: ExcelData = { ...data, pos: [], skus: data.skus.map(s => ({ ...s })) };
        const merged = await applyPOWIPData(base);
        // For each SKU: use PO WIP's onOrder if it found events, else keep inventory's
        data = {
          ...merged,
          skus: merged.skus.map(s => ({
            ...s,
            onOrder: s.onOrder > 0 ? s.onOrder : (invOnOrder.get(s.sku) ?? s.onOrder),
          })),
        };
      } catch (e) {
        console.warn("PO WIP merge failed, using Xoro inventory PO totals:", e);
      }

      // Step 3: Dedupe
      data = dedupeExcelData(data);

      // Step 4: Save to Supabase
      setSyncProgress({ step: "Saving to database…", pct: 80 });
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
      });
      if (!saveRes.ok) throw new Error("Failed to save synced data");

      // Save base snapshot + clear merge history (fresh sync = fresh start)
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_base_data", value: JSON.stringify(data) }),
      });
      await saveMergeHistory([]);
      setMergeHistory([]);

      // Step 5: Compute rows
      setSyncProgress({ step: "Computing ATS grid…", pct: 95 });
      setExcelData(data);
      setRows(computeRowsFromExcelData(data, dates));
      setLastSync(data.syncedAt);
      setMockMode(false);

      setSyncProgress(null);
      console.log(`[Xoro Sync] Complete — ${meta?.skusWithStock ?? "?"} SKUs, ${meta?.soLinesOpen ?? "?"} open SO lines`);
    } catch (e: any) {
      console.error("[Xoro Sync] Failed:", e);
      setSyncError(e.message);
      setSyncProgress(null);
    } finally {
      setSyncing(false);
    }
  }, [dates, setExcelData, setRows, setLastSync, setMockMode, setMergeHistory, saveMergeHistory, applyPOWIPData]);

  return { syncing, syncProgress, syncError, setSyncError, syncFromXoro };
}
