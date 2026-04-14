import { useCallback, useRef } from "react";
import type { ATSRow, ExcelData, UploadWarning } from "../types";
import type { NormChange, NormDecisions } from "../normalize";
import { detectNormChanges, partitionNormChanges, applyNormChanges } from "../normalize";
import { dedupeExcelData, mergeExcelDataSkus } from "../merge";
import { computeRowsFromExcelData } from "../compute";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import type { MergeOp } from "./useMergeHistory";

interface UseExcelUploadOpts {
  // External dependencies (from other hooks / state)
  applyPOWIPData: (data: ExcelData) => Promise<ExcelData>;
  saveMergeHistory: (history: MergeOp[]) => Promise<void>;
  saveBaseData: (data: ExcelData) => Promise<void>;
  mergeHistory: MergeOp[];
  loadNormDecisions: () => Promise<NormDecisions>;
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
    const baseData = dedupeExcelData(rawData);
    // Replay saved merges over the freshly uploaded data so row-level merges
    // (e.g. "Lt Grey" → "Grey") survive re-uploading. Ops whose skus no
    // longer exist no-op inside mergeExcelDataSkus, so stale entries are
    // harmless — the user can undo to remove them if desired.
    let data: ExcelData = baseData;
    for (const op of opts.mergeHistory) {
      data = mergeExcelDataSkus(data, op.fromSku, op.toSku);
    }
    opts.setUploadingFile(true);
    opts.setUploadWarnings(null);
    opts.setPendingUploadData(null);
    try {
      // Auto-apply normalization decisions the user previously approved. Only
      // never-seen-before SKUs surface in the review modal.
      opts.setUploadProgress({ step: `Checking ${data.skus.length.toLocaleString()} SKUs for normalization…`, pct: 82 });
      const allChanges = detectNormChanges(data);
      const decisions = await opts.loadNormDecisions();
      const { known, unknown } = partitionNormChanges(allChanges, decisions);
      console.info(`[norm] upload: ${allChanges.length} detected, ${known.length} known (${known.filter(c => c.accepted).length} accept / ${known.filter(c => !c.accepted).length} reject), ${unknown.length} unknown`);
      if (unknown.length > 0 && unknown.length <= 10) {
        console.info("[norm] unknown SKUs:", unknown.map(u => u.original));
      }
      // Apply the known-accepted ones silently so the data we save is already
      // in its post-normalization state. Known-rejected ones stay raw.
      if (known.length > 0) {
        data = applyNormChanges(data, known);
      }

      opts.setUploadProgress({ step: `Saving ${data.skus.length.toLocaleString()} SKUs…`, pct: 85 });
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
      });
      if (!saveRes.ok) throw new Error("Failed to save data to database");
      // Overwrite the pre-merge base snapshot with the fresh upload so
      // undo replays against current data, not last week's. Merge history
      // is preserved — already applied above via the replay loop.
      await opts.saveBaseData(baseData);

      if (unknown.length > 0) {
        opts.setUploadProgress({ step: `Found ${unknown.length} new SKU${unknown.length !== 1 ? "s" : ""} to normalize — review required`, pct: 93 });
        await new Promise(r => setTimeout(r, 600));
        opts.setNormPendingData(data);
        opts.setNormChanges(unknown);
        opts.setNormSource("upload");
        opts.setUploadProgress(null);
        opts.setUploadingFile(false);
        return;
      }
      const autoMsg = known.length > 0
        ? `SKU normalization: ${known.filter(c => c.accepted).length} auto-applied from saved decisions`
        : "SKU normalization: all clean — no changes needed";
      opts.setUploadProgress({ step: autoMsg, pct: 93 });
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
      opts.setUploadSuccess(`${data.skus.length.toLocaleString()} SKUs uploaded${known.filter(c => c.accepted).length > 0 ? ` — ${known.filter(c => c.accepted).length} normalizations auto-applied` : " — no normalization needed"}`);
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
