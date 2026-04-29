import { type XoroPO, type Milestone } from "../../utils/tandaTypes";
import { useTandaStore } from "../store/index";

// ── Supabase helpers (mirrors the module-level `sb` in TandA.tsx) ──
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
const sb = {
  from: (table: string) => ({
    select: async (cols = "*", filter = "") => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`, { headers: SB_HEADERS });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    upsert: async (rows: any, opts?: { onConflict?: string }) => {
      const body = Array.isArray(rows) ? rows : [rows];
      const url = `${SB_URL}/rest/v1/${table}${opts?.onConflict ? `?on_conflict=${opts.onConflict}` : ""}`;
      const res = await fetch(url, { method: "POST", headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(body) });
      const data = await res.json();
      return { data, error: res.ok ? null : data };
    },
    delete: async (filter: string) => {
      const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, { method: "DELETE", headers: SB_HEADERS });
      return { error: res.ok ? null : await res.json() };
    },
  }),
};

interface UseArchiveOpsOpts {
  addHistory: (poNumber: string, description: string) => Promise<void>;
  loadCachedPOs: () => Promise<void>;
  ensureMilestones: (po: XoroPO) => Promise<Milestone[] | "needs_template">;
  saveMilestone: (m: Milestone, skipHistory?: boolean) => Promise<void>;
  // local state
  getSelected: () => XoroPO | null;
  setSelected: (v: XoroPO | null) => void;
  setArchivedPos: (v: XoroPO[]) => void;
  setArchiveLoading: (v: boolean) => void;
  // bulk update local state
  getBulkState: () => {
    bulkVendor: string;
    bulkStatus: string;
    bulkPhases: string[];
    bulkCategory: string;
    bulkPOs: string[];
  };
  setBulkUpdating: (v: boolean) => void;
  setShowBulkUpdate: (v: boolean) => void;
  setBulkPhase: (v: string) => void;
  setBulkPhases: (v: string[]) => void;
  setBulkCategory: (v: string) => void;
  setBulkPOs: (v: string[]) => void;
  setBulkPOSearch: (v: string) => void;
  setConfirmModal: (v: any) => void;
}

export function useArchiveOps(opts: UseArchiveOpsOpts) {
  const {
    addHistory, loadCachedPOs, ensureMilestones, saveMilestone,
    getSelected, setSelected, setArchivedPos, setArchiveLoading,
    getBulkState, setBulkUpdating, setShowBulkUpdate,
    setBulkPhase, setBulkPhases, setBulkCategory, setBulkPOs, setBulkPOSearch,
    setConfirmModal,
  } = opts;

  async function archivePO(poNumber: string) {
    if (!poNumber) return;
    // Mark as archived in the data JSON — preserves all milestones, notes, attachments
    const { data: rows } = await sb.from("tanda_pos").select("data", `po_number=eq.${encodeURIComponent(poNumber)}`);
    if (rows?.[0]) {
      const poData = rows[0].data as XoroPO;
      const archived = { ...poData, _archived: true, _archivedAt: new Date().toISOString() };
      await sb.from("tanda_pos").upsert({ po_number: poNumber, data: archived }, { onConflict: "po_number" });
    }
    // Remove from active local state only
    useTandaStore.getState().removePo(poNumber);
    const selected = getSelected();
    if (selected?.PoNumber === poNumber) setSelected(null);
  }

  async function loadArchivedPOs() {
    setArchiveLoading(true);
    try {
      const { data } = await sb.from("tanda_pos").select("*");
      if (data) {
        const archived = data
          .filter((r: any) => (r.data as XoroPO)?._archived === true)
          .map((r: any) => r.data as XoroPO);
        setArchivedPos(archived);
      }
    } catch (e) { console.error("Load archived error:", e); }
    setArchiveLoading(false);
  }

  async function unarchivePO(poNumber: string) {
    if (!poNumber) return;
    const { data: rows } = await sb.from("tanda_pos").select("data", `po_number=eq.${encodeURIComponent(poNumber)}`);
    if (rows?.[0]) {
      const poData = rows[0].data as XoroPO;
      const restored = { ...poData, _archived: false, _archivedAt: undefined };
      delete (restored as any)._archived;
      delete (restored as any)._archivedAt;
      await sb.from("tanda_pos").upsert({ po_number: poNumber, data: restored }, { onConflict: "po_number" });
    }
    addHistory(poNumber, "PO restored from archive");
    await loadCachedPOs();
    await loadArchivedPOs();
  }

  async function permanentDeleteArchived(poNumbers: string[]) {
    // Surface failures rather than swallowing them. Previous version
    // ignored every Supabase error so the user saw "deleted" while rows
    // were still in the DB, leading to ghost entries on next refresh.
    const failures: Array<{ po: string; step: string; error: string }> = [];
    for (const poNumber of poNumbers) {
      const { error: poErr } = await sb.from("tanda_pos").delete(`po_number=eq.${encodeURIComponent(poNumber)}`);
      if (poErr) failures.push({ po: poNumber, step: "tanda_pos", error: String((poErr as { message?: string }).message ?? poErr) });

      const { data: msRows, error: msFetchErr } = await sb.from("tanda_milestones").select("id,data");
      if (msFetchErr) {
        failures.push({ po: poNumber, step: "milestones-fetch", error: String((msFetchErr as { message?: string }).message ?? msFetchErr) });
      } else if (msRows) {
        for (const r of msRows) {
          if ((r.data as { po_number?: string } | null)?.po_number !== poNumber) continue;
          const { error: msErr } = await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(r.id)}`);
          if (msErr) failures.push({ po: poNumber, step: "milestone-delete", error: String((msErr as { message?: string }).message ?? msErr) });
        }
      }

      const { data: noteRows, error: noteFetchErr } = await sb.from("tanda_notes").select("id", `po_number=eq.${encodeURIComponent(poNumber)}`);
      if (noteFetchErr) {
        failures.push({ po: poNumber, step: "notes-fetch", error: String((noteFetchErr as { message?: string }).message ?? noteFetchErr) });
      } else if (noteRows) {
        for (const n of noteRows) {
          const { error: nErr } = await sb.from("tanda_notes").delete(`id=eq.${encodeURIComponent(n.id)}`);
          if (nErr) failures.push({ po: poNumber, step: "note-delete", error: String((nErr as { message?: string }).message ?? nErr) });
        }
      }
    }
    await loadArchivedPOs();
    if (failures.length > 0) {
      console.error("[permanentDeleteArchived] partial failures", failures);
      throw new Error(`Permanent-delete failed for ${failures.length} record(s) — see console for detail`);
    }
  }

  async function bulkUpdateMilestones() {
    const { bulkVendor, bulkStatus, bulkPhases, bulkCategory, bulkPOs } = getBulkState();
    if (!bulkVendor || !bulkStatus) return;
    setBulkUpdating(true);
    const state = useTandaStore.getState();
    const pos = state.pos;
    const milestones = state.milestones;
    const user = state.user;
    const vendorPOs = pos.filter(p => (p.VendorName ?? "") === bulkVendor);
    const targetPOs = bulkPOs.length > 0 ? vendorPOs.filter(p => bulkPOs.includes(p.PoNumber ?? "")) : vendorPOs;
    const today = new Date().toISOString().split("T")[0];
    let count = 0;
    let generated = 0;
    // Auto-generate milestones for POs that don't have them
    for (const po of targetPOs) {
      const poNum = po.PoNumber ?? "";
      if (!(milestones[poNum]?.length) && po.DateExpectedDelivery) {
        const result = await ensureMilestones(po);
        if (result !== "needs_template" && Array.isArray(result) && result.length > 0) generated++;
      }
    }
    // Now update milestones — re-read milestones from store (ensureMilestones may have updated them)
    const updatedMilestones = useTandaStore.getState().milestones;
    for (const po of targetPOs) {
      const poNum = po.PoNumber ?? "";
      const poMs = updatedMilestones[poNum] || [];
      for (const m of poMs) {
        const matchPhase = bulkPhases.length === 0 || bulkPhases.includes(m.phase);
        const matchCat = !bulkCategory || m.category === bulkCategory;
        if (matchPhase && matchCat && m.status !== bulkStatus && m.status !== "N/A") {
          const dates = { ...(m.status_dates || {}) };
          if (bulkStatus !== "Not Started" && !dates[bulkStatus]) dates[bulkStatus] = today;
          await saveMilestone({
            ...m,
            status: bulkStatus,
            status_date: dates[bulkStatus] || today,
            status_dates: Object.keys(dates).length > 0 ? dates : null,
            updated_at: new Date().toISOString(),
            updated_by: user?.name || "",
          }, true);
          count++;
        }
      }
    }
    const poNums = targetPOs.map(p => p.PoNumber ?? "").filter(Boolean);
    if (count > 0) {
      addHistory(targetPOs[0]?.PoNumber ?? "", `Bulk update: ${count} milestones \u2192 ${bulkStatus} for ${bulkVendor} [${poNums.join(", ")}]${bulkCategory ? ` (${bulkCategory})` : ""}`);
    }
    setBulkUpdating(false);
    setShowBulkUpdate(false);
    setBulkPhase(""); setBulkPhases([]);
    setBulkCategory("");
    setBulkPOs([]); setBulkPOSearch("");
    const genMsg = generated > 0 ? ` (${generated} POs had milestones auto-generated)` : "";
    setConfirmModal({ title: "Bulk Update Complete", message: `Updated ${count} milestones to "${bulkStatus}" for ${bulkVendor} \u2014 POs: ${poNums.join(", ")}${genMsg}`, icon: "\u2705", confirmText: "OK", confirmColor: "#10B981", onConfirm: () => {} });
  }

  return {
    archivePO,
    loadArchivedPOs,
    unarchivePO,
    permanentDeleteArchived,
    bulkUpdateMilestones,
  };
}
