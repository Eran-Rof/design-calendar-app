import { useCallback, useRef } from "react";
import type { ATSRow, ExcelData, UploadWarning } from "../types";
import type { NormChange } from "../normalize";
import { detectNormChanges } from "../normalize";
import { dedupeExcelData } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import type { MergeOp } from "./useMergeHistory";

interface UseExcelUploadOpts {
  // External dependencies (from other hooks / state)
  applyPOWIPData: (data: ExcelData) => Promise<ExcelData>;
  saveMergeHistory: (history: MergeOp[]) => Promise<void>;
  saveBaseData: (data: ExcelData) => Promise<void>;
  dates: string[];
  // State setters for upload UI
  setUploadingFile: (v: boolean) => void;
  setShowUpload: (v: boolean) => void;
  setUploadProgress: (v: { step: string; pct: number } | null) => void;
  setUploadError: (v: string | null) => void;
  setUploadSuccess: (v: string | null) => void;
  setUploadWarnings: (v: UploadWarning[] | null) => void;
  setPendingUploadData: (v: ExcelData | null) => void;
  // State setters for main data
  setExcelData: (v: ExcelData | null) => void;
  setRows: (v: ATSRow[]) => void;
  setLastSync: (v: string) => void;
  setMockMode: (v: boolean) => void;
  setMergeHistory: (v: MergeOp[]) => void;
  // File input resets
  setInvFile: (v: File | null) => void;
  setPurFile: (v: File | null) => void;
  setOrdFile: (v: File | null) => void;
  // Normalization review flow
  setNormChanges: (v: NormChange[] | null) => void;
  setNormPendingData: (v: ExcelData | null) => void;
  setNormSource: (v: "upload" | "load") => void;
}

// Encapsulates the entire Excel upload flow: parse API call, PO WIP merge,
// warnings gate, normalization review, persistence, and computing ATS rows.
// Also owns the cancel/abort refs so the parent doesn't need to thread them.
export function useExcelUpload(opts: UseExcelUploadOpts) {
  const cancelRef = useRef(false);
  const abortRef  = useRef<AbortController | null>(null);

  const saveUploadData = useCallback(async (rawData: ExcelData) => {
    // Collapse any duplicate sku+store rows BEFORE persistence so the
    // stored blob is clean — compute.ts still has a safety net but this
    // means Supabase, base snapshot, and merge replays all work with
    // clean data instead of relying on the render pass to fix it.
    const data = dedupeExcelData(rawData);
    opts.setUploadingFile(true);
    opts.setUploadWarnings(null);
    opts.setPendingUploadData(null);
    try {
      opts.setUploadProgress({ step: `Saving ${data.skus.length.toLocaleString()} SKUs…`, pct: 80 });
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
      });
      if (!saveRes.ok) throw new Error("Failed to save data to database");
      // Also overwrite the pre-merge base snapshot so undo-merge replays
      // against the freshly uploaded data, not last week's stale base.
      // Clear merge history too — the old ops don't apply to new SKUs.
      await opts.saveBaseData(data);
      await opts.saveMergeHistory([]);
      opts.setMergeHistory([]);
      opts.setUploadProgress({ step: `Checking ${data.skus.length.toLocaleString()} SKUs for normalization…`, pct: 88 });
      await new Promise(r => setTimeout(r, 400));
      const changes = detectNormChanges(data);
      if (changes.length > 0) {
        opts.setUploadProgress({ step: `Found ${changes.length} SKU${changes.length !== 1 ? "s" : ""} to normalize — review required`, pct: 93 });
        await new Promise(r => setTimeout(r, 800));
        opts.setNormPendingData(data);
        opts.setNormChanges(changes);
        opts.setNormSource("upload");
        opts.setUploadProgress(null);
        opts.setUploadingFile(false);
        return;
      }
      opts.setUploadProgress({ step: "SKU normalization: all clean — no changes needed", pct: 93 });
      await new Promise(r => setTimeout(r, 600));
      opts.setUploadProgress({ step: "Computing ATS…", pct: 95 });
      opts.setExcelData(data);
      opts.setRows(computeRowsFromExcelData(data, opts.dates));
      opts.setLastSync(data.syncedAt);
      opts.setMockMode(false);
      opts.setInvFile(null);
      opts.setPurFile(null);
      opts.setOrdFile(null);
      opts.setUploadProgress(null);
      opts.setUploadSuccess(`${data.skus.length.toLocaleString()} SKUs uploaded — no normalization needed`);
      setTimeout(() => opts.setUploadSuccess(null), 6000);
    } catch (e) {
      console.error(e);
      opts.setUploadError((e as Error).message);
    } finally {
      opts.setUploadingFile(false);
      opts.setUploadProgress(null);
    }
  }, [opts]);

  const handleFileUpload = useCallback(async (inv: File, pur: File | null, ord: File) => {
    if (abortRef.current) abortRef.current.abort();
    opts.setUploadingFile(true);
    opts.setShowUpload(false);
    cancelRef.current = false;
    abortRef.current = new AbortController();
    try {
      opts.setUploadProgress({ step: "Parsing files…", pct: 15 });
      const formData = new FormData();
      formData.append("inventory", inv);
      if (pur) formData.append("purchases", pur);
      formData.append("orders", ord);
      const res = await fetch("/api/parse-excel", {
        method: "POST",
        body: formData,
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(err.error ?? "Parse failed");
      }
      if (cancelRef.current) return;
      opts.setUploadProgress({ step: "Processing data…", pct: 50 });
      let data: ExcelData = await res.json();
      if (cancelRef.current) return;

      // Always pull PO data from PO WIP (tanda_pos) — single source of truth.
      opts.setUploadProgress({ step: "Fetching PO data from PO WIP…", pct: 60 });
      try { data = await opts.applyPOWIPData(data); }
      catch (e) { console.warn("Failed to fetch PO WIP data:", e); }

      opts.setUploadProgress({ step: "Checking data…", pct: 70 });

      // If the API found any data quality issues, pause and ask user before saving.
      if (data.warnings && data.warnings.length > 0) {
        opts.setUploadProgress(null);
        opts.setUploadingFile(false);
        opts.setPendingUploadData(data);
        opts.setUploadWarnings(data.warnings);
        return;
      }

      await saveUploadData(data);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(e);
      opts.setUploadError((e as Error).message);
    } finally {
      opts.setUploadingFile(false);
      opts.setUploadProgress(null);
      cancelRef.current = false;
      abortRef.current = null;
    }
  }, [opts, saveUploadData]);

  const cancelUpload = useCallback(() => {
    cancelRef.current = true;
    abortRef.current?.abort();
    opts.setUploadingFile(false);
    opts.setUploadProgress(null);
  }, [opts]);

  return {
    handleFileUpload,
    saveUploadData,
    cancelUpload,
    cancelRef,
    abortRef,
  };
}
