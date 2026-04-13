import { useCallback, useState } from "react";
import type { ExcelData } from "../types";
import { dedupeExcelData } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import { detectNormChanges, type NormChange } from "../normalize";
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
  // Normalization review (shared with upload flow)
  setNormChanges: (v: NormChange[] | null) => void;
  setNormPendingData: (v: ExcelData | null) => void;
  setNormSource: (v: "upload" | "load") => void;
}

interface SyncProgress {
  step: string;
  pct: number;
}

export function useXoroSync(opts: UseXoroSyncOpts) {
  const {
    dates, setExcelData, setRows, setLastSync, setMockMode,
    setMergeHistory, saveMergeHistory,
    setNormChanges, setNormPendingData, setNormSource,
  } = opts;

  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const syncFromXoro = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncProgress({ step: "Fetching inventory + sales orders from Xoro…", pct: 10 });

    try {
      // Single call to serverless endpoint — Pro plan allows 15 min
      // function duration, so we can fetch inventory (84 pages) + sales
      // orders (56 pages) in one go. The server normalizes SKUs and
      // returns ExcelData-shaped JSON.
      const res = await fetch("/api/ats-sync?type=full", {
        signal: AbortSignal.timeout(600000), // 10 min client timeout
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Sync failed" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      if (!json.Result || !json.Data) {
        throw new Error(json.Message || json.error || "No data returned from Xoro");
      }

      setSyncProgress({ step: "Processing Xoro data…", pct: 50 });
      let data: ExcelData = json.Data;
      const meta = (data as any)._meta;
      delete (data as any)._meta;

      // Merge PO WIP events for right-click detail. Inventory API already
      // set onOrder = QtyOnPO — keep that baseline; PO WIP events layer
      // on top so the period cells show individual PO lines linking to
      // PO WIP milestones.
      setSyncProgress({ step: "Loading PO detail from PO WIP…", pct: 60 });
      try {
        const poRes = await fetch(`${SB_URL}/rest/v1/tanda_pos?select=data`, { headers: SB_HEADERS });
        if (poRes.ok) {
          const poRows = await poRes.json();
          const newPos: ExcelData["pos"] = [];
          for (const row of poRows) {
            const po = row.data;
            if (!po || po._archived) continue;
            const poNum = po.PoNumber ?? "";
            const vendor = po.VendorName ?? "";
            const expDate = po.DateExpectedDelivery ?? "";
            const brandName = po.BrandName ?? "";
            const items = po.Items ?? po.PoLineArr ?? [];
            for (const item of items) {
              const rawSku = item.ItemNumber ?? "";
              if (!rawSku) continue;
              const parts = rawSku.split("-");
              const rawConverted = parts.length >= 3 ? parts[0] + " - " + parts.slice(1, -1).join(" - ")
                        : parts.length === 2 ? parts[0] + " - " + parts[1]
                        : rawSku;
              const sku = normalizeSku(rawConverted);
              const qty = item.QtyRemaining != null ? item.QtyRemaining : (item.QtyOrder ?? 0) - (item.QtyReceived ?? 0);
              if (qty <= 0) continue;
              let date = "";
              if (expDate) { const d = new Date(expDate); if (!isNaN(d.getTime())) date = d.toISOString().split("T")[0]; }
              const pn = poNum.toUpperCase();
              const bn = brandName.toUpperCase();
              const store = pn.includes("ECOM") ? "ROF ECOM" : (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) ? "PT" : "ROF";
              const unitCost = item.UnitPrice ?? 0;
              if (date) newPos.push({ sku, date, qty, poNumber: poNum, vendor, store, unitCost });
            }
          }
          if (newPos.length > 0) {
            data = { ...data, pos: newPos };
          }
        }
      } catch (e) {
        console.warn("PO WIP event merge failed (right-click detail will be empty):", e);
      }

      // Dedupe
      data = dedupeExcelData(data);

      // Normalization review — pause if any SKUs would be renamed
      setSyncProgress({ step: "Checking SKU normalization…", pct: 75 });
      const normChanges = detectNormChanges(data);
      if (normChanges.length > 0) {
        setSyncProgress(null);
        setNormPendingData(data);
        setNormChanges(normChanges);
        setNormSource("load");
        setSyncing(false);
        return;
      }

      // Save to Supabase
      setSyncProgress({ step: "Saving to database…", pct: 85 });
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
      });
      if (!saveRes.ok) throw new Error("Failed to save synced data");

      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_base_data", value: JSON.stringify(data) }),
      });
      await saveMergeHistory([]);
      setMergeHistory([]);

      // Compute rows
      setSyncProgress({ step: "Computing ATS grid…", pct: 95 });
      setExcelData(data);
      setRows(computeRowsFromExcelData(data, dates));
      setLastSync(data.syncedAt);
      setMockMode(false);

      setSyncProgress(null);
      console.log(`[Xoro Sync] Complete — ${meta?.skusWithStock ?? data.skus.length} SKUs, ${meta?.soLinesOpen ?? data.sos.length} open SO lines`);
    } catch (e: any) {
      console.error("[Xoro Sync] Failed:", e);
      setSyncError(e.message);
      setSyncProgress(null);
    } finally {
      setSyncing(false);
    }
  }, [dates, setExcelData, setRows, setLastSync, setMockMode, setMergeHistory, saveMergeHistory, setNormChanges, setNormPendingData, setNormSource]);

  return { syncing, syncProgress, syncError, setSyncError, syncFromXoro };
}
