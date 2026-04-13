import React from "react";
import { type XoroPO, STATUS_COLORS } from "../../utils/tandaTypes";
import S from "../styles";

export interface ArchiveViewProps {
  archivedPos: XoroPO[];
  archiveSearch: string;
  setArchiveSearch: (v: string) => void;
  archiveFilterVendor: string;
  setArchiveFilterVendor: (v: string) => void;
  archiveFilterStatus: string;
  setArchiveFilterStatus: (v: string) => void;
  archiveSelected: Set<string>;
  setArchiveSelected: (v: Set<string>) => void;
  archiveLoading: boolean;
  unarchivePO: (poNumber: string) => void;
  permanentDeleteArchived: (poNumbers: string[]) => Promise<void>;
  setConfirmModal: (v: any) => void;
}

export function ArchiveView({
  archivedPos, archiveSearch, setArchiveSearch,
  archiveFilterVendor, setArchiveFilterVendor,
  archiveFilterStatus, setArchiveFilterStatus,
  archiveSelected, setArchiveSelected,
  archiveLoading, unarchivePO, permanentDeleteArchived, setConfirmModal,
}: ArchiveViewProps) {
  const s = archiveSearch.toLowerCase();
  const filtered = archivedPos.filter(po => {
    if (s && !(po.PoNumber ?? "").toLowerCase().includes(s) && !(po.VendorName ?? "").toLowerCase().includes(s)) return false;
    if (archiveFilterVendor !== "All" && (po.VendorName ?? "") !== archiveFilterVendor) return false;
    if (archiveFilterStatus !== "All" && (po.StatusName ?? "") !== archiveFilterStatus) return false;
    return true;
  });
  const vendors = ["All", ...new Set(archivedPos.map(p => p.VendorName ?? "").filter(Boolean))].sort();
  const statuses = ["All", ...new Set(archivedPos.map(p => p.StatusName ?? "").filter(Boolean))];
  const allSelected = filtered.length > 0 && filtered.every(p => archiveSelected.has(p.PoNumber ?? ""));

  return (
    <div style={{ maxWidth: "85%", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: "0 0 2px", color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Archived Purchase Orders</h2>
          <div style={{ color: "#6B7280", fontSize: 12 }}>{archivedPos.length} archived POs · milestones and notes preserved</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {archiveSelected.size > 0 && (<>
            <button onClick={() => { archiveSelected.forEach(pn => unarchivePO(pn)); setArchiveSelected(new Set()); }}
              style={{ ...S.navBtn, color: "#10B981", borderColor: "#10B98144" }}>↩ Restore {archiveSelected.size} Selected</button>
            <button onClick={() => {
              setConfirmModal({
                title: "Permanently Delete",
                message: `Permanently delete ${archiveSelected.size} PO${archiveSelected.size > 1 ? "s" : ""}?\n\nThis will remove all data including milestones, notes, and attachments. This cannot be undone.`,
                icon: "🗑️", confirmText: "Delete Forever", confirmColor: "#EF4444",
                onConfirm: async () => { await permanentDeleteArchived([...archiveSelected]); setArchiveSelected(new Set()); },
              });
            }} style={{ ...S.navBtnDanger }}>🗑 Delete {archiveSelected.size} Selected</button>
          </>)}
          {archivedPos.length > 0 && (
            <button onClick={() => {
              setConfirmModal({
                title: "Restore All Archived",
                message: `Restore all ${archivedPos.length} archived PO${archivedPos.length > 1 ? "s" : ""} back to All POs?\n\nPOs that should stay archived (Closed, Received, Cancelled) will be re-archived on your next sync.`,
                icon: "↩", confirmText: "Restore All", confirmColor: "#10B981",
                onConfirm: async () => {
                  for (const po of archivedPos) await unarchivePO(po.PoNumber ?? "");
                  setArchiveSelected(new Set());
                },
              });
            }} style={{ ...S.navBtn, color: "#10B981", borderColor: "#10B98144" }}>↩ Restore All ({archivedPos.length})</button>
          )}
        </div>
      </div>
      <div style={S.filters}>
        <input value={archiveSearch} onChange={e => setArchiveSearch(e.target.value)} placeholder="🔍 Search PO#, vendor…" style={{ ...S.input, width: 240, marginBottom: 0 }} />
        <select value={archiveFilterVendor} onChange={e => setArchiveFilterVendor(e.target.value)} style={S.select}>
          {vendors.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={archiveFilterStatus} onChange={e => setArchiveFilterStatus(e.target.value)} style={S.select}>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {filtered.length > 0 && (
          <button onClick={() => {
            setConfirmModal({
              title: "Delete All Filtered",
              message: `Permanently delete all ${filtered.length} filtered PO${filtered.length > 1 ? "s" : ""}? This cannot be undone.`,
              icon: "🗑️", confirmText: "Delete All", confirmColor: "#EF4444",
              onConfirm: async () => { await permanentDeleteArchived(filtered.map(p => p.PoNumber ?? "").filter(Boolean)); setArchiveSelected(new Set()); },
            });
          }} style={S.navBtnDanger}>🗑 Delete All Filtered ({filtered.length})</button>
        )}
      </div>
      {archiveLoading ? (
        <div style={S.emptyState}>Loading archived POs…</div>
      ) : filtered.length === 0 ? (
        <div style={S.emptyState}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📦</div>
          <p style={{ color: "#6B7280", margin: 0 }}>{archivedPos.length === 0 ? "No archived POs yet" : "No POs match your filters"}</p>
        </div>
      ) : (
        <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 120px 140px 100px", padding: "10px 16px", background: "#0F172A", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #334155" }}>
            <div><input type="checkbox" checked={allSelected} onChange={() => {
              if (allSelected) setArchiveSelected(new Set());
              else setArchiveSelected(new Set(filtered.map(p => p.PoNumber ?? "")));
            }} style={{ accentColor: "#3B82F6" }} /></div>
            <div>PO#</div><div>Vendor</div><div>Status</div><div>Archived</div><div>Actions</div>
          </div>
          {filtered.map((po, i) => {
            const poNum = po.PoNumber ?? "";
            const isChecked = archiveSelected.has(poNum);
            const statusColor = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
            return (
              <div key={poNum} style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 120px 140px 100px", padding: "12px 16px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", alignItems: "center" }}>
                <div><input type="checkbox" checked={isChecked} onChange={() => {
                  const next = new Set(archiveSelected);
                  if (isChecked) next.delete(poNum); else next.add(poNum);
                  setArchiveSelected(next);
                }} style={{ accentColor: "#3B82F6" }} /></div>
                <div style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 14 }}>{poNum}</div>
                <div style={{ color: "#D1D5DB", fontSize: 13 }}>{po.VendorName ?? ""}</div>
                <div><span style={{ ...S.badge, background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}44` }}>{po.StatusName ?? ""}</span></div>
                <div style={{ color: "#6B7280", fontSize: 12, fontFamily: "monospace" }}>{(po as any)._archivedAt ? new Date((po as any)._archivedAt).toLocaleDateString() : "—"}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => unarchivePO(poNum)} title="Restore" style={{ background: "none", border: "1px solid #10B98144", color: "#10B981", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>↩</button>
                  <button onClick={() => {
                    setConfirmModal({
                      title: "Permanently Delete", message: `Delete PO ${poNum} permanently? All data will be lost.`,
                      icon: "🗑️", confirmText: "Delete", confirmColor: "#EF4444",
                      onConfirm: () => permanentDeleteArchived([poNum]),
                    });
                  }} title="Delete permanently" style={{ background: "none", border: "1px solid #EF444444", color: "#EF4444", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>🗑</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
