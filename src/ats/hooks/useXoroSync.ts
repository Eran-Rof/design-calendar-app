import { useCallback, useState } from "react";
import type { ExcelData } from "../types";
import { dedupeExcelData } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import { normalizeSku } from "../helpers";
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
      // ── Client-side pagination through xoro-proxy ──
      // Serverless has a 60s limit; Xoro's API is too slow for 84 pages in
      // one call. Browser has no timeout — we paginate here, one single
      // page per proxy call, 5 in parallel per batch.

      // Page 1 to learn total page count
      setSyncProgress({ step: "Fetching inventory page 1…", pct: 5 });
      const p1Res = await fetch("/api/xoro-proxy?app=ats&path=inventory/getinventorybyitem&min_on_hand=1&page=1", {
        signal: AbortSignal.timeout(60000),
      });
      if (!p1Res.ok) throw new Error(`Inventory fetch failed: ${p1Res.status}`);
      const p1 = await p1Res.json();
      if (!p1.Result) throw new Error(p1.Message || "Xoro inventory failed");
      const totalPages = p1.TotalPages || 1;
      const allItems: any[] = [...(p1.Data || [])];

      // Remaining pages in parallel batches of 5 (Xoro handles 5 concurrent
      // better than 10+ — fewer rate-limit issues).
      const BATCH = 5;
      for (let start = 2; start <= totalPages; start += BATCH) {
        const end = Math.min(start + BATCH - 1, totalPages);
        const pct = Math.round(5 + ((start - 1) / totalPages) * 45);
        setSyncProgress({ step: `Inventory pages ${start}–${end} of ${totalPages}…`, pct });
        const pageNums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
        const results = await Promise.allSettled(
          pageNums.map(p =>
            fetch(`/api/xoro-proxy?app=ats&path=inventory/getinventorybyitem&min_on_hand=1&page=${p}`, {
              signal: AbortSignal.timeout(60000),
            }).then(r => r.json())
          )
        );
        for (const r of results) {
          if (r.status === "fulfilled" && Array.isArray(r.value?.Data)) {
            allItems.push(...r.value.Data);
          }
        }
      }

      // Build ExcelData skus from raw inventory items
      setSyncProgress({ step: "Processing inventory…", pct: 52 });
      const skuMap: Record<string, ExcelData["skus"][0]> = {};
      for (const item of allItems) {
        const raw = item.ItemNumber || "";
        if (!raw) continue;
        const parts = raw.split("-");
        const rawSku = parts.length >= 3 ? parts[0] + " - " + parts.slice(1, -1).join(" - ")
          : parts.length === 2 ? parts[0] + " - " + parts[1] : raw;
        const sku = normalizeSku(rawSku);
        const sn = (item.StoreName || "").toUpperCase();
        const store = sn.includes("ECOM") ? "ROF ECOM"
          : (sn.includes("PSYCHO") || sn.includes("PTUNA") || sn.includes("P TUNA") || sn === "PT" || sn.startsWith("PREBOOK")) ? "PT"
          : (sn.includes("ROF") || sn.includes("RING")) ? "ROF" : item.StoreName || "ROF";
        const key = `${sku}::${store}`;
        if (!skuMap[key]) {
          skuMap[key] = { sku, description: item.ItemDescription || "", store, onHand: 0, onOrder: 0, onCommitted: 0 };
        }
        skuMap[key].onHand      += item.OnHandQty   || 0;
        skuMap[key].onOrder     += item.QtyOnPO      || 0;
        skuMap[key].onCommitted += item.QtyOnSO      || 0;
      }

      setSyncProgress({ step: "Fetching sales order detail…", pct: 55 });
      let sos: ExcelData["sos"] = [];
      try {
        const soRes = await fetch("/api/ats-sync?type=salesorders", {
          signal: AbortSignal.timeout(60000),
        });
        if (soRes.ok) {
          const soJson = await soRes.json();
          if (soJson.Result && soJson.sos) sos = soJson.sos;
        }
      } catch (e) {
        console.warn("SO fetch failed, continuing with inventory only:", e);
      }

      const skus = Object.values(skuMap);
      let data: ExcelData = { syncedAt: new Date().toISOString(), skus, pos: [], sos };
      const meta = { skusWithStock: skus.length, soLinesOpen: sos.length, totalInvItems: allItems.length };

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
