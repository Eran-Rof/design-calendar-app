import { useCallback } from "react";
import type { ExcelData } from "../types";
import { xoroSkuToExcel, normalizeSku } from "../helpers";
import { isLineClosed } from "../../utils/tandaTypes";
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

// Paginate the tanda_pos fetch — Supabase / PostgREST silently caps every
// response at `db-max-rows=1000` regardless of any `limit=N` we ask for,
// per the cap documented in project_postgrest_1000_row_cap.md. Operators
// who accumulate more than 1000 PO rows would silently lose every PO past
// row 1000 on each ATS load — symptom: grid rows render but their on-hand
// projections / new-receipt deltas under-count badly, and downstream filters
// can narrow the visible set to a single page worth of SKUs (no pagination
// shown, no way to navigate to the rows the operator expected).
//
// PAGE_SIZE 1000 matches Supabase's hard ceiling so each request is a full
// page; the loop exits as soon as a page returns less than that.
export const TANDA_POS_PAGE_SIZE = 1000;
export async function fetchAllTandaPos(): Promise<Array<{ data: any }>> {
  const out: Array<{ data: any }> = [];
  for (let offset = 0; ; offset += TANDA_POS_PAGE_SIZE) {
    const url = `${SB_URL}/rest/v1/tanda_pos?select=data&limit=${TANDA_POS_PAGE_SIZE}&offset=${offset}`;
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) {
      // Surface the failure so callers can fall back to cached data
      // instead of silently returning a partial set.
      throw new Error(`tanda_pos fetch failed at offset ${offset}: ${r.status}`);
    }
    const chunk = (await r.json()) as Array<{ data: any }>;
    out.push(...chunk);
    if (chunk.length < TANDA_POS_PAGE_SIZE) break;
    // Hard safety cap so an unexpected loop never hangs the browser.
    if (offset > 500_000) break;
  }
  return out;
}

// Fetch tanda_pos from Supabase and fold the rows into an ExcelData blob.
// Pure: returns a new ExcelData; never mutates the input. The work is done
// against a sku lookup map so we don't rescan the skus array per item.
export async function applyPOWIPDataToExcel(data: ExcelData): Promise<ExcelData> {
  let poRows: Array<{ data: any }>;
  try {
    poRows = await fetchAllTandaPos();
  } catch (e) {
    // Match the prior !poRes.ok behavior — return the input data
    // untouched rather than wiping POs and partial-applying. Caller's
    // try/catch in ATS.tsx loadFromSupabase logs this.
    console.warn("[ATS] tanda_pos fetch failed; keeping cached PO data:", e);
    return data;
  }

  // Work on a fresh copy of each sku entry so we can safely mutate inside
  // this function without touching the caller's data.
  const nextSkus = data.skus.map(s => ({ ...s }));
  const nextPos = [...data.pos];
  // Key by sku + store so PO events land on the correct store's row,
  // not just whichever sku row happens to be first in the array.
  const keyOf = (sku: string, store: string) => `${sku}::${store || "ROF"}`;
  const skuIndex = new Map<string, number>();
  nextSkus.forEach((s, i) => skuIndex.set(keyOf(s.sku, s.store ?? "ROF"), i));

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
      // Closed lines won't be received — exclude from onPO rollup even if
      // QtyRemaining is still nonzero on the Xoro payload.
      if (isLineClosed(item)) continue;
      // Normalize so case/spacing/abbreviation differences between PO WIP
      // data and the baked excelData (which was normalized on upload) don't
      // produce duplicate SKU entries or break merge replay.
      const sku = normalizeSku(xoroSkuToExcel(rawItemSku));
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

      // PO WIP items sometimes carry Description on the item row, sometimes on
      // a sibling field. Try a few spellings so new-from-PO rows get a human
      // name instead of showing up blank in the Description column.
      const itemDesc: string =
        item.Description ?? item.ItemDescription ?? item.ProductName ?? item.ItemName ?? "";

      const key = keyOf(sku, store);
      const existingIdx = skuIndex.get(key);
      if (existingIdx === undefined) {
        skuIndex.set(key, nextSkus.length);
        nextSkus.push({
          sku,
          description: itemDesc,
          category: brandName || undefined,
          store,
          onHand: 0,
          onPO: qty,
          onOrder: 0,
        });
      } else {
        const prev = nextSkus[existingIdx];
        // Backfill description when the existing row is blank — Excel inventory
        // may not have had this SKU yet, so the PO WIP name is the best we have.
        const nextDesc = prev.description || itemDesc;
        nextSkus[existingIdx] = { ...prev, onPO: (prev.onPO || 0) + qty, description: nextDesc };
      }
      // Always push the PO event, even when the vendor hasn't filled in a
      // delivery date. Empty-date events:
      //   - are EXCLUDED from time-period columns by getEventsInPeriod
      //     (date "" < any periodStart → never matches a period)
      //   - are INCLUDED in the $ on PO total at ATS.tsx:941 (sums by
      //     qty * unitCost, no date filter)
      // Mirrors the design intent documented in parseExcelClient.ts:332
      // "these POs ... are still counted in the On PO total." Without
      // this, undated POs (often Macy's EDI orders that arrive without
      // a DDP) silently dropped from $ on PO while still contributing
      // to the qty stat — confusing low-by-$X numbers.
      nextPos.push({ sku, date, qty, poNumber: poNum, vendor, store, unitCost });
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
        skus: excelData.skus.map(s => ({ ...s, onPO: 0 })),
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
