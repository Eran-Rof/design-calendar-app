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
      // Step 1a: Fetch inventory (the critical data)
      const invRes = await fetch("/api/ats-sync?type=inventory", {
        signal: AbortSignal.timeout(90000),
      });
      if (!invRes.ok) {
        const err = await invRes.json().catch(() => ({ error: "Sync failed" }));
        throw new Error(err.error ?? `HTTP ${invRes.status}`);
      }
      const invJson = await invRes.json();
      if (!invJson.Result || !invJson.skus) {
        throw new Error(invJson.Message || "No inventory data returned");
      }

      // Step 1b: Fetch sales orders (separate call, tolerate failure)
      setSyncProgress({ step: "Fetching sales orders from Xoro…", pct: 35 });
      let sos: ExcelData["sos"] = [];
      try {
        const soRes = await fetch("/api/ats-sync?type=salesorders", {
          signal: AbortSignal.timeout(90000),
        });
        if (soRes.ok) {
          const soJson = await soRes.json();
          if (soJson.Result && soJson.sos) sos = soJson.sos;
        }
      } catch (e) {
        console.warn("SO fetch failed, continuing with inventory only:", e);
      }

      setSyncProgress({ step: "Processing Xoro data…", pct: 50 });
      let data: ExcelData = {
        syncedAt: new Date().toISOString(),
        skus: invJson.skus,
        pos: [],
        sos,
      };
      const meta = { skusWithStock: invJson.skus?.length, soLinesOpen: sos.length };

      // Step 2: Apply PO data from PO WIP (tanda_pos)
      setSyncProgress({ step: "Merging PO data from PO WIP…", pct: 65 });
      try {
        const base: ExcelData = { ...data, pos: [], skus: data.skus.map(s => ({ ...s, onOrder: 0 })) };
        data = await applyPOWIPData(base);
      } catch (e) {
        console.warn("PO WIP merge failed, using Xoro PO data:", e);
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
