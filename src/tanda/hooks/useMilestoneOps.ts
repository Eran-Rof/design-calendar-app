import { useRef } from "react";
import { type XoroPO, type Milestone, type WipTemplate, WIP_CATEGORIES, DEFAULT_WIP_TEMPLATES } from "../../utils/tandaTypes";
import { generateMilestones as _generateMilestones, mergeMilestones } from "../milestones";
import { useTandaStore } from "../store/index";

type SB = {
  from: (table: string) => {
    select: (cols?: string, filter?: string) => Promise<{ data: any; error: any }>;
    insert: (rows: any) => Promise<{ data: any; error: any }>;
    upsert: (rows: any, opts?: { onConflict?: string }) => Promise<{ data: any; error: any }>;
    delete: (filter: string) => Promise<{ error: any }>;
    single: (cols?: string, filter?: string) => Promise<{ data: any; error: any }>;
  };
};

type ConfirmModal = {
  title: string; message: string; icon: string; confirmText: string; confirmColor: string;
  cancelText?: string; listItems?: string[]; onConfirm: () => void; onCancel?: () => void;
} | null;

interface MilestoneOpsDeps {
  sb: SB;
  addHistory: (poNumber: string, description: string) => void;
  setConfirmModal: (v: ConfirmModal) => void;
  setCollapsedCats: (v: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  acceptedBlocked: Set<string>;
}

export function useMilestoneOps(deps: MilestoneOpsDeps) {
  const { sb, addHistory, setConfirmModal, setCollapsedCats, acceptedBlocked } = deps;
  const generatingRef = useRef<Set<string>>(new Set());
  const conflictPendingRef = useRef<Set<string>>(new Set());

  const getState = () => useTandaStore.getState();
  const store = getState();

  function getVendorTemplates(vendorName?: string): WipTemplate[] {
    const { wipTemplates } = getState();
    if (vendorName && wipTemplates[vendorName]) return wipTemplates[vendorName];
    return wipTemplates.__default__ || DEFAULT_WIP_TEMPLATES;
  }

  function vendorHasTemplate(vendorName: string): boolean {
    const { wipTemplates } = getState();
    return !!(vendorName && wipTemplates[vendorName]);
  }

  async function loadAllMilestones() {
    try {
      const { data } = await sb.from("tanda_milestones").select("id,data");
      if (data && Array.isArray(data)) {
        const grouped: Record<string, Milestone[]> = {};
        data.forEach((row: any) => {
          const m = row.data as Milestone;
          if (!m || !m.po_number) return;
          if (!grouped[m.po_number]) grouped[m.po_number] = [];
          grouped[m.po_number].push(m);
        });
        // Sort each group by sort_order
        Object.values(grouped).forEach(arr => arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
        const coreSet = getState().setCoreField;
        coreSet("milestones", grouped);
      }
    } catch (e) { console.error("[MS] loadAll error:", e); }
  }

  async function loadMilestones(poNumber: string): Promise<Milestone[]> {
    try {
      const { data } = await sb.from("tanda_milestones").select("id,data");
      if (!data) return [];
      return (data as any[])
        .map(row => row.data as Milestone)
        .filter(m => m.po_number === poNumber)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    } catch { return []; }
  }

  async function saveMilestone(m: Milestone, skipHistory = false) {
    const state = getState();
    const milestones = state.milestones;
    const user = state.user;
    // Ensure updated_at is always set
    if (!m.updated_at || m.updated_at === (milestones[m.po_number] || []).find(x => x.id === m.id)?.updated_at) {
      m = { ...m, updated_at: new Date().toISOString(), updated_by: m.updated_by || user?.name || "" };
    }
    const existing = (milestones[m.po_number] || []).find(x => x.id === m.id);
    // When status changes, store date per status in status_dates map
    if (existing && existing.status !== m.status) {
      const today = new Date().toISOString().split("T")[0];
      const dates = { ...(m.status_dates || existing.status_dates || {}) };
      // Record today for the new status (if it doesn't already have a date)
      if (!dates[m.status]) dates[m.status] = today;
      m.status_dates = dates;
      // Set status_date to the date for the current status
      m.status_date = dates[m.status] || today;
    }
    // Track changes for history
    if (!skipHistory && existing) {
      const changes: string[] = [];
      if (existing.status !== m.status) changes.push(`Status: ${existing.status} → ${m.status} (${m.status_date || "today"})`);
      if (existing.status !== m.status && existing.status_date !== m.status_date) {} // already logged above
      else if (existing.status_date !== m.status_date) changes.push(`Status Date: ${existing.status_date || "—"} → ${m.status_date || "—"}`);
      if (existing.notes !== m.notes) changes.push(`Notes updated`);
      if (changes.length > 0) {
        addHistory(m.po_number, `${m.phase}: ${changes.join(", ")}`);
      }
    }
    // Conflict detection: check if another user modified this milestone since we loaded it.
    // If a conflict modal is already pending for this milestone, skip — the previous
    // save is waiting on user input and we don't want to stack multiple modals.
    if (conflictPendingRef.current.has(m.id)) return;
    if (existing) {
      const { data: currentRow } = await sb.from("tanda_milestones").single("id,data", `id=eq.${encodeURIComponent(m.id)}`);
      const serverData = (currentRow as any)?.data as Milestone | undefined;
      if (serverData && serverData.updated_at && serverData.updated_at !== existing.updated_at && serverData.updated_by !== (user?.name || "")) {
        // Conflict detected — let user decide (skip if we're the one who made the change)
        conflictPendingRef.current.add(m.id);
        setConfirmModal({
          title: "Conflict Detected",
          message: `"${m.phase}" was modified by ${serverData.updated_by || "another user"}.\n\nTheir status: ${serverData.status} · Your status: ${m.status}\n\nOverwrite with your changes?`,
          icon: "⚠️",
          confirmText: "Use Mine",
          cancelText: "Keep Theirs",
          confirmColor: "#3B82F6",
          onConfirm: async () => {
            try {
              await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
              store.updateMilestone(m.po_number, m.id, m);
            } finally {
              conflictPendingRef.current.delete(m.id);
            }
          },
          onCancel: async () => {
            try { await loadAllMilestones(); }
            finally { conflictPendingRef.current.delete(m.id); }
          },
        });
        return; // Don't save yet — modal callbacks handle it
      }
    }
    await sb.from("tanda_milestones").upsert({ id: m.id, data: m }, { onConflict: "id" });
    store.updateMilestone(m.po_number, m.id, m);
    // Clear collapsed overrides for this PO so auto-collapse/expand recalculates
    if (!skipHistory) {
      // Check if this milestone completing finishes its entire category
      const updatedMs = [...(milestones[m.po_number] || [])];
      const idx2 = updatedMs.findIndex(x => x.id === m.id);
      if (idx2 >= 0) updatedMs[idx2] = m;
      const catMs = updatedMs.filter(x => x.category === m.category);
      const catJustCompleted = m.status === "Complete" && catMs.every(x => x.status === "Complete" || x.status === "N/A");

      if (catJustCompleted) {
        // Keep the completed category open immediately (override auto-collapse)
        const completedKey = m.category + m.po_number;
        setCollapsedCats(prev => {
          const next = { ...prev };
          // Clear other categories so they recalculate
          WIP_CATEGORIES.forEach(cat => {
            const key = cat + m.po_number;
            if (key === completedKey) { next[key] = false; } // force open
            else if (!acceptedBlocked.has(key)) { delete next[key]; }
          });
          return next;
        });
        // After 4 seconds, release the override so it collapses naturally
        setTimeout(() => {
          setCollapsedCats(prev => {
            const next = { ...prev };
            delete next[completedKey];
            return next;
          });
        }, 2000);
      } else {
        setCollapsedCats(prev => {
          const next = { ...prev };
          WIP_CATEGORIES.forEach(cat => {
            const key = cat + m.po_number;
            if (!acceptedBlocked.has(key)) delete next[key];
          });
          return next;
        });
      }
    }
  }

  async function saveMilestones(ms: Milestone[]) {
    if (!ms.length) return;
    await sb.from("tanda_milestones").upsert(
      ms.map(m => ({ id: m.id, data: m })),
      { onConflict: "id" }
    );
    ms.forEach(m => store.updateMilestone(m.po_number, m.id, m));
  }

  async function deleteMilestonesForPO(poNumber: string) {
    // Load all milestone IDs for this PO, then delete them
    const milestones = getState().milestones;
    const existing = milestones[poNumber] || [];
    for (const m of existing) {
      await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
    }
    store.deleteMilestonesForPo(poNumber);
  }

  function generateMilestones(poNumber: string, ddpDate: string, vendorName?: string): Milestone[] {
    const user = getState().user;
    return _generateMilestones(poNumber, ddpDate, getVendorTemplates(vendorName), user?.name || "");
  }

  async function ensureMilestones(po: XoroPO): Promise<Milestone[] | "needs_template"> {
    const poNum = po.PoNumber ?? "";
    if (!poNum) return [];
    // Prevent concurrent generation for the same PO
    if (generatingRef.current.has(poNum)) return [];
    // Check state first
    const milestones = getState().milestones;
    const existing = milestones[poNum];
    if (existing && existing.length > 0) return existing;
    generatingRef.current.add(poNum);
    try {
      // Double-check DB to prevent duplicates
      const dbExisting = await loadMilestones(poNum);
      if (dbExisting.length > 0) {
        store.setMilestonesForPo(poNum, dbExisting);
        return dbExisting;
      }
      const ddp = po.DateExpectedDelivery;
      if (!ddp) return [];
      const vendor = po.VendorName ?? "";
      if (vendor && !vendorHasTemplate(vendor)) {
        return "needs_template";
      }
      const ms = generateMilestones(poNum, ddp, vendor);
      if (ms.length > 0) {
        await saveMilestones(ms);
        addHistory(poNum, `Milestones generated (${ms.length} phases) using ${vendor || "default"} template`);
      }
      return ms;
    } finally {
      generatingRef.current.delete(poNum);
    }
  }

  async function regenerateMilestones(po: XoroPO) {
    const poNum = po.PoNumber ?? "";
    const ddp = po.DateExpectedDelivery;
    if (!poNum || !ddp) return;
    // Guard against detailPanel's lazy-generate race: it triggers ensureMilestones
    // whenever milestones[poNum] is empty during render. Holding generatingRef blocks it.
    if (generatingRef.current.has(poNum)) return;
    generatingRef.current.add(poNum);
    try {
      const milestones = getState().milestones;
      const existing = milestones[poNum] || [];
      const fresh = generateMilestones(poNum, ddp, po.VendorName);
      const merged = mergeMilestones(existing, fresh);
      // 1. Upsert merged FIRST so the PO is never in a zero-milestones state.
      //    If we crash or disconnect after this, the PO still has a valid set
      //    (the new merged set) — only orphaned old rows would remain, which
      //    the next regenerate or load can clean up.
      if (merged.length > 0) {
        const { error: upErr } = await sb.from("tanda_milestones").upsert(
          merged.map(m => ({ id: m.id, data: m })),
          { onConflict: "id" }
        );
        if (upErr) {
          throw new Error(`Failed to write merged milestones: ${(upErr as any)?.message || JSON.stringify(upErr)}`);
        }
      }
      // 2. Delete only the old rows whose ids are not in the merged set.
      //    Preserved-progress milestones keep their old ids (mergeMilestones
      //    sets id: old.id), so they won't be deleted here.
      const mergedIds = new Set(merged.map(m => m.id));
      const stragglers = existing.filter(m => !mergedIds.has(m.id));
      for (const m of stragglers) {
        await sb.from("tanda_milestones").delete(`id=eq.${encodeURIComponent(m.id)}`);
      }
      // 3. Atomically replace in state — never leave milestones[poNum] empty
      store.setMilestonesForPo(poNum, merged);
      addHistory(poNum, `Milestones regenerated (${merged.length} phases)`);
    } finally {
      generatingRef.current.delete(poNum);
    }
  }

  return {
    loadAllMilestones,
    loadMilestones,
    saveMilestone,
    saveMilestones,
    deleteMilestonesForPO,
    generateMilestones,
    ensureMilestones,
    regenerateMilestones,
    getVendorTemplates,
    vendorHasTemplate,
  };
}
