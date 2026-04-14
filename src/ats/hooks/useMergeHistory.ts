import { useState, useCallback } from "react";
import type { ATSRow, ExcelData } from "../types";
import { mergeExcelDataSkus, mergeRows } from "../merge";
import { skuSimilarity } from "../helpers";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";

export interface MergeOp {
  fromSku: string;
  toSku: string;
}

export interface PendingMerge {
  fromSku: string;
  toSku: string;
  similarity: number;
}

// Pure: rebuild the post-undo data set from the pre-merge base snapshot.
// Zeroes onOrder + clears pos so PO WIP can re-seed them (that's the source
// of truth for POs), then replays the remaining merge ops in original order.
// Extracted so the replay order can be verified in isolation.
export async function rebuildAfterUndo(
  newHistory: MergeOp[],
  baseData: ExcelData,
  applyPOWIPData: (d: ExcelData) => Promise<ExcelData>,
): Promise<ExcelData> {
  let freshBase = baseData;
  try {
    const base = { ...baseData, pos: [], skus: baseData.skus.map(s => ({ ...s, onOrder: 0 })) };
    freshBase = await applyPOWIPData(base);
  } catch { /* PO WIP fetch can fail offline — fall back to bare base */ }
  let rebuilt = freshBase;
  for (const op of newHistory) rebuilt = mergeExcelDataSkus(rebuilt, op.fromSku, op.toSku);
  return rebuilt;
}

interface UseMergeHistoryOpts {
  mergeHistory: MergeOp[];
  setMergeHistory: (v: MergeOp[] | ((p: MergeOp[]) => MergeOp[])) => void;
  excelData: ExcelData | null;
  setExcelData: (v: ExcelData | null | ((p: ExcelData | null) => ExcelData | null)) => void;
  rows: ATSRow[];
  setRows: (v: ATSRow[] | ((p: ATSRow[]) => ATSRow[])) => void;
  applyPOWIPData: (data: ExcelData) => Promise<ExcelData>;
  saveNormResult: (data: ExcelData) => Promise<void>;
  isAdmin: boolean;
}

// Encapsulates everything around merge history: the pending-merge UI state,
// persistence to Supabase, commit/undo flows, and the drag-drop handler.
// Extracted from ATS.tsx for testability and to keep the main component lean.
export function useMergeHistory(opts: UseMergeHistoryOpts) {
  const {
    mergeHistory, setMergeHistory,
    excelData, setExcelData,
    rows, setRows,
    applyPOWIPData, saveNormResult,
    isAdmin,
  } = opts;

  const [pendingMerge, setPendingMerge] = useState<PendingMerge | null>(null);

  const saveMergeHistory = useCallback(async (history: MergeOp[]) => {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_merge_history", value: JSON.stringify(history) }),
      });
      if (!res.ok) console.warn("Merge history save failed:", res.status);
    } catch (e) {
      console.error("Failed to save merge history", e);
    }
  }, []);

  const commitMerge = useCallback((fromSku: string, toSku: string) => {
    if (!fromSku || !toSku || fromSku === toSku) return;
    setPendingMerge(null);
    const newHistory = [...mergeHistory, { fromSku, toSku }];
    setMergeHistory(newHistory);
    saveMergeHistory(newHistory);
    if (excelData) {
      const merged = mergeExcelDataSkus(excelData, fromSku, toSku);
      setExcelData(merged);
      saveNormResult(merged);
    } else {
      const newRows = mergeRows(rows, fromSku, toSku);
      if (newRows !== rows) setRows(newRows);
    }
  }, [mergeHistory, setMergeHistory, excelData, setExcelData, rows, setRows, saveNormResult, saveMergeHistory]);

  const handleSkuDrop = useCallback((fromSku: string, toSku: string) => {
    if (!fromSku || !toSku || fromSku === toSku) return;
    const similarity = skuSimilarity(fromSku, toSku);
    // The modal uses `similarity` + isAdmin to decide whether to let the
    // user confirm; we surface it either way so the modal can render a
    // warning for low-similarity merges.
    setPendingMerge({ fromSku, toSku, similarity });
    void isAdmin; // referenced so future refactors don't drop the prop
  }, [isAdmin]);

  const undoLastMerge = useCallback(async () => {
    if (mergeHistory.length === 0) return;
    const newHistory = mergeHistory.slice(0, -1);
    let baseData: ExcelData | null = null;
    try {
      const baseRes = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.ats_base_data&select=value`, { headers: SB_HEADERS });
      if (!baseRes.ok) throw new Error(`Failed to load base data: ${baseRes.status}`);
      const baseRows = await baseRes.json();
      if (Array.isArray(baseRows) && baseRows[0]?.value) baseData = JSON.parse(baseRows[0].value);
    } catch {}
    if (!baseData) {
      alert("Cannot undo: no base snapshot found. Please re-upload your Excel files to reset merge history.");
      return;
    }
    const rebuilt = await rebuildAfterUndo(newHistory, baseData, applyPOWIPData);
    setMergeHistory(newHistory);
    saveMergeHistory(newHistory);
    setExcelData(rebuilt);
    saveNormResult(rebuilt);
  }, [mergeHistory, setMergeHistory, applyPOWIPData, saveNormResult, saveMergeHistory, setExcelData]);

  return {
    pendingMerge,
    setPendingMerge,
    saveMergeHistory,
    commitMerge,
    handleSkuDrop,
    undoLastMerge,
  };
}
