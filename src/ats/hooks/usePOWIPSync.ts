import { useCallback } from "react";
import type { ExcelData } from "../types";
import { xoroSkuToExcel } from "../helpers";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";

interface UsePOWIPSyncOpts {
  excelData: ExcelData | null;
  setExcelData: (v: ExcelData | null | ((p: ExcelData | null) => ExcelData | null)) => void;
  setUploadingFile: (v: boolean | ((p: boolean) => boolean)) => void;
  setUploadSuccess: (v: string | null) => void;
}

// Store inference mirrors the logic in api/parse-excel.js — kept inline so
// the hook is self-contained and testable.
function inferStore(poNum: string, brandName: string): string {
  const pn = poNum.toUpperCase();
  const bn = brandName.toUpperCase();
  if (pn.includes("ECOM")) return "ROF ECOM";
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

// Fetch tanda_pos from Supabase and fold the rows into an ExcelData blob.
// Pure: returns a new ExcelData; never mutates the input. The work is done
// against a sku lookup map so we don't rescan the skus array per item.
export async function applyPOWIPDataToExcel(data: ExcelData): Promise<ExcelData> {
  const poRes = await fetch(`${SB_URL}/rest/v1/tanda_pos?select=data`, { headers: SB_HEADERS });
  if (!poRes.ok) return data;
  const poRows = await poRes.json();

  // Work on a fresh copy of each sku entry so we can safely mutate inside
  // this function without touching the caller's data.
  const nextSkus = data.skus.map(s => ({ ...s }));
  const nextPos = [...data.pos];
  const skuIndex = new Map<string, number>();
  nextSkus.forEach((s, i) => skuIndex.set(s.sku, i));

  for (const row of poRows) {
    const po = row.data;
    if (!po || po._archived) continue;
    const poNum = po.PoNumber ?? "";
    const vendor = po.VendorName ?? "";
    const expDate = po.DateExpectedDelivery ?? "";
    const brandName = po.BrandName ?? "";
    const items = po.Items ?? po.PoLineArr ?? [];
    for (const item of items) {
      const rawItemSku = item.ItemNumber ?? "";
      if (!rawItemSku) continue;
      const sku = xoroSkuToExcel(rawItemSku);
      const qty = item.QtyRemaining != null
        ? item.QtyRemaining
        : (item.QtyOrder ?? 0) - (item.QtyReceived ?? 0);
      const unitCost = item.UnitPrice ?? 0;
      if (qty <= 0) continue;
      let date = "";
      if (expDate) {
        const d = new Date(expDate);
        if (!isNaN(d.getTime())) date = d.toISOString().split("T")[0];
      }
      const store = inferStore(poNum, brandName);

      const existingIdx = skuIndex.get(sku);
      if (existingIdx === undefined) {
        skuIndex.set(sku, nextSkus.length);
        nextSkus.push({
          sku,
          description: item.Description ?? "",
          category: brandName || undefined,
          store,
          onHand: 0,
          onOrder: qty,
          onCommitted: 0,
        });
      } else {
        const prev = nextSkus[existingIdx];
        nextSkus[existingIdx] = { ...prev, onOrder: (prev.onOrder || 0) + qty };
      }
      if (date) nextPos.push({ sku, date, qty, poNumber: poNum, vendor, store, unitCost });
    }
  }

  return { ...data, skus: nextSkus, pos: nextPos };
}

// Hook wrapping applyPOWIPDataToExcel with a stable reference and the
// refresh-current-excelData flow (used by the "Refresh POs" button).
export function usePOWIPSync(opts: UsePOWIPSyncOpts) {
  const { excelData, setExcelData, setUploadingFile, setUploadSuccess } = opts;

  const applyPOWIPData = useCallback((data: ExcelData) => applyPOWIPDataToExcel(data), []);

  const refreshPOsFromWIP = useCallback(async () => {
    if (!excelData) return;
    setUploadingFile(true);
    try {
      const base: ExcelData = {
        ...excelData,
        pos: [],
        skus: excelData.skus.map(s => ({ ...s, onOrder: 0 })),
      };
      const updated = await applyPOWIPData(base);
      setExcelData(updated);
      setUploadSuccess("PO data refreshed from PO WIP");
    } catch (e) {
      console.warn("Failed to refresh PO WIP data:", e);
    } finally {
      setUploadingFile(false);
    }
  }, [excelData, setExcelData, setUploadingFile, setUploadSuccess, applyPOWIPData]);

  return { applyPOWIPData, refreshPOsFromWIP };
}
