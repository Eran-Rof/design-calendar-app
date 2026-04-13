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
    setSyncProgress({ step: "Fetching inventory from Xoro…", pct: 10 });

    try {
      // ── Client-side pagination through xoro-proxy ──
      // The ats-sync serverless function times out at 60s for 84+ pages.
      // Instead, the browser paginates directly — no timeout limit.

      // Step 1a: Fetch inventory page 1 to get total page count
      const p1Res = await fetch("/api/xoro-proxy?app=ats&path=inventory/getinventorybyitem&min_on_hand=1&page=1");
      const p1 = await p1Res.json();
      if (!p1.Result) throw new Error(p1.Message || "Xoro inventory failed");
      const totalPages = p1.TotalPages || 1;
      const allItems: any[] = [...(p1.Data || [])];

      // Fetch remaining pages in parallel batches of 10 from the browser.
      // Each call goes through the proxy as a single-page request.
      const BATCH = 10;
      for (let start = 2; start <= totalPages; start += BATCH) {
        const end = Math.min(start + BATCH - 1, totalPages);
        const pct = Math.round(10 + ((start - 1) / totalPages) * 40);
        setSyncProgress({ step: `Fetching inventory pages ${start}–${end} of ${totalPages}…`, pct });
        const pageNums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
        const results = await Promise.allSettled(
          pageNums.map(p => fetch(`/api/xoro-proxy?app=ats&path=inventory/getinventorybyitem&min_on_hand=1&page=${p}`).then(r => r.json()))
        );
        for (const r of results) {
          if (r.status === "fulfilled" && Array.isArray(r.value?.Data)) {
            allItems.push(...r.value.Data);
          }
        }
      }

      // Convert raw inventory items to ExcelData skus
      setSyncProgress({ step: "Processing inventory…", pct: 48 });
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

      // Step 1b: Fetch sales orders (use ats-sync endpoint — smaller dataset)
      setSyncProgress({ step: "Fetching sales orders…", pct: 50 });
      let sos: ExcelData["sos"] = [];
      try {
        const soRes = await fetch("/api/ats-sync?type=salesorders");
        if (soRes.ok) {
          const soJson = await soRes.json();
          if (soJson.Result && soJson.sos) sos = soJson.sos;
        }
      } catch (e) {
        console.warn("SO sync failed, continuing with inventory only:", e);
      }

      setSyncProgress({ step: "Processing data…", pct: 55 });
      const skus = Object.values(skuMap);
      let data: ExcelData = { syncedAt: new Date().toISOString(), skus, pos: [], sos };
      const meta = { skusWithStock: skus.length, soLinesOpen: sos.length, totalInvItems: allItems.length };

      // Step 2: Merge PO WIP events for the right-click detail popups.
      // onOrder totals come from the inventory API (QtyOnPO) — we do NOT
      // overwrite those. We only pull pos[] events from tanda_pos so the
      // period-cell right-click shows individual PO lines + links to PO WIP.
      setSyncProgress({ step: "Loading PO detail from PO WIP…", pct: 65 });
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

      // Step 3: Dedupe
      data = dedupeExcelData(data);

      // Step 3b: Check for normalization changes — if found, pause and
      // show the review modal (same flow as Excel upload). The user
      // approves/rejects, then applyNormReview finishes the save.
      setSyncProgress({ step: "Checking SKU normalization…", pct: 75 });
      const normChanges = detectNormChanges(data);
      if (normChanges.length > 0) {
        setSyncProgress(null);
        setNormPendingData(data);
        setNormChanges(normChanges);
        setNormSource("load");
        setSyncing(false);
        return; // user will approve → applyNormReview handles the rest
      }

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
  }, [dates, setExcelData, setRows, setLastSync, setMockMode, setMergeHistory, saveMergeHistory]);

  return { syncing, syncProgress, syncError, setSyncError, syncFromXoro };
}
