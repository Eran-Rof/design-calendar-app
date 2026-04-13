import React, { useState, useEffect } from "react";
import { type XoroPO, type SyncFilters, STATUS_COLORS, STATUS_OPTIONS, fmtDate } from "../../utils/tandaTypes";
import type { SyncLogEntry } from "../state/sync/syncTypes";
import S from "../styles";

// ════════════════════════════════════════════════════════════════════════════
// Props
// ════════════════════════════════════════════════════════════════════════════

export interface SyncModalsProps {
  // Visibility
  showSyncModal: boolean;
  syncing: boolean;
  syncDone: { added: number; changed: number; deleted: number } | null;
  showSyncLog: boolean;

  // Sync filters & search
  syncFilters: SyncFilters;
  setSyncFilters: (v: SyncFilters | ((prev: SyncFilters) => SyncFilters)) => void;
  poSearch: string;
  setPoSearch: (v: string) => void;
  poDropdownOpen: boolean;
  setPoDropdownOpen: (v: boolean) => void;

  // Vendors
  xoroVendors: string[];
  manualVendors: string[];
  vendorSearch: string;
  setVendorSearch: (v: string) => void;
  loadingVendors: boolean;
  newManualVendor: string;
  setNewManualVendor: (v: string) => void;
  saveManualVendor: () => void;
  removeManualVendor: (v: string) => void;

  // Progress
  syncProgress: number;
  syncProgressMsg: string;
  syncErr: string;

  // Log
  syncLog: SyncLogEntry[];

  // POs (for search dropdown)
  pos: XoroPO[];

  // Actions
  setShowSyncModal: (v: boolean) => void;
  setShowSyncLog: (v: boolean) => void;
  setSyncDone: (v: { added: number; changed: number; deleted: number } | null) => void;
  cancelSync: () => void;
  syncFromXoro: (filters: SyncFilters) => void;
  syncVendorsToDC: (replace: boolean, vendors: string[]) => void;
  setConfirmModal: (v: any) => void;
}

// ════════════════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════════════════

export function SyncModals(props: SyncModalsProps) {
  const {
    showSyncModal, syncing, syncDone, showSyncLog,
    syncFilters, setSyncFilters,
    poSearch, setPoSearch, poDropdownOpen, setPoDropdownOpen,
    xoroVendors, manualVendors, vendorSearch, setVendorSearch,
    loadingVendors, newManualVendor, setNewManualVendor,
    saveManualVendor, removeManualVendor,
    syncProgress, syncProgressMsg, syncErr,
    syncLog, pos,
    setShowSyncModal, setShowSyncLog, setSyncDone,
    cancelSync, syncFromXoro, syncVendorsToDC, setConfirmModal,
  } = props;

  // ── Derived vendor lists ──
  const allVendors = Array.from(new Set([...xoroVendors, ...manualVendors, ...pos.map(p => p.VendorName ?? "").filter(Boolean)])).sort();
  const filteredVendorList = allVendors.filter(v =>
    !vendorSearch || v.toLowerCase().includes(vendorSearch.toLowerCase())
  );

  return (
    <>
      {showSyncModal && (
        <SyncConfigModal
          syncFilters={syncFilters} setSyncFilters={setSyncFilters}
          poSearch={poSearch} setPoSearch={setPoSearch}
          poDropdownOpen={poDropdownOpen} setPoDropdownOpen={setPoDropdownOpen}
          vendorSearch={vendorSearch} setVendorSearch={setVendorSearch}
          loadingVendors={loadingVendors}
          newManualVendor={newManualVendor} setNewManualVendor={setNewManualVendor}
          saveManualVendor={saveManualVendor} removeManualVendor={removeManualVendor}
          manualVendors={manualVendors}
          allVendors={allVendors} filteredVendorList={filteredVendorList}
          pos={pos} syncLog={syncLog}
          setShowSyncModal={setShowSyncModal} setShowSyncLog={setShowSyncLog}
          syncFromXoro={syncFromXoro} syncVendorsToDC={syncVendorsToDC}
          setConfirmModal={setConfirmModal}
        />
      )}
      {syncing && (
        <SyncProgressModal
          syncProgress={syncProgress} syncProgressMsg={syncProgressMsg}
          syncErr={syncErr} cancelSync={cancelSync}
        />
      )}
      <SyncDoneModal syncDone={syncDone} setSyncDone={setSyncDone} />
      {showSyncLog && (
        <SyncLogModal syncLog={syncLog} setShowSyncLog={setShowSyncLog} />
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC CONFIG MODAL
// ════════════════════════════════════════════════════════════════════════════

function SyncConfigModal({
  syncFilters, setSyncFilters,
  poSearch, setPoSearch, poDropdownOpen, setPoDropdownOpen,
  vendorSearch, setVendorSearch, loadingVendors,
  newManualVendor, setNewManualVendor,
  saveManualVendor, removeManualVendor,
  manualVendors, allVendors, filteredVendorList,
  pos, syncLog,
  setShowSyncModal, setShowSyncLog,
  syncFromXoro, syncVendorsToDC, setConfirmModal,
}: {
  syncFilters: SyncFilters;
  setSyncFilters: (v: SyncFilters | ((prev: SyncFilters) => SyncFilters)) => void;
  poSearch: string;
  setPoSearch: (v: string) => void;
  poDropdownOpen: boolean;
  setPoDropdownOpen: (v: boolean) => void;
  vendorSearch: string;
  setVendorSearch: (v: string) => void;
  loadingVendors: boolean;
  newManualVendor: string;
  setNewManualVendor: (v: string) => void;
  saveManualVendor: () => void;
  removeManualVendor: (v: string) => void;
  manualVendors: string[];
  allVendors: string[];
  filteredVendorList: string[];
  pos: XoroPO[];
  syncLog: SyncLogEntry[];
  setShowSyncModal: (v: boolean) => void;
  setShowSyncLog: (v: boolean) => void;
  syncFromXoro: (filters: SyncFilters) => void;
  syncVendorsToDC: (replace: boolean, vendors: string[]) => void;
  setConfirmModal: (v: any) => void;
}) {
  const closeSyncModal = () => { setShowSyncModal(false); setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] }); };

  return (
    <div style={S.modalOverlay} onClick={closeSyncModal}>
      <div style={{ ...S.modal, width: 540 }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>🔄 Sync from Xoro</h2>
          <button style={S.closeBtn} onClick={closeSyncModal}>✕</button>
        </div>
        <div style={S.modalBody}>
          <p style={{ color: "#9CA3AF", fontSize: 13, marginTop: 0, marginBottom: 20 }}>
            Filter which POs to pull from Xoro. Leave all blank to sync everything. New POs will be added; existing ones updated.
          </p>

          {/* PO Number multi-select */}
          <label style={S.label}>PO Number (search & select one or more, or leave blank for all)</label>
          {/* Selected PO chips */}
          {syncFilters.poNumbers.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {syncFilters.poNumbers.map(pn => (
                <span key={pn} style={{ display: "flex", alignItems: "center", gap: 4, background: "#3B82F622", border: "1px solid #3B82F6", borderRadius: 20, padding: "3px 10px", fontSize: 13, color: "#60A5FA", fontFamily: "monospace" }}>
                  {pn}
                  <button onClick={() => setSyncFilters(p => ({ ...p, poNumbers: p.poNumbers.filter(x => x !== pn) }))}
                    style={{ background: "none", border: "none", color: "#60A5FA", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 0 0 2px" }}>✕</button>
                </span>
              ))}
            </div>
          )}
          {/* Search input */}
          <div style={{ position: "relative", marginBottom: 16 }}>
            <input style={{ ...S.input, marginBottom: 0 }}
              placeholder="Type to search PO numbers…"
              value={poSearch}
              onChange={e => { setPoSearch(e.target.value); setPoDropdownOpen(true); }}
              onFocus={() => setPoDropdownOpen(true)}
              onBlur={() => setTimeout(() => setPoDropdownOpen(false), 200)}
            />
            {poDropdownOpen && poSearch && (() => {
              const matches = pos.filter(p =>
                (p.PoNumber ?? "").toLowerCase().includes(poSearch.toLowerCase()) &&
                !syncFilters.poNumbers.includes(p.PoNumber ?? "")
              ).slice(0, 10);
              if (!matches.length) return null;
              return (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, maxHeight: 200, overflowY: "auto" }}>
                  {matches.map(p => (
                    <div key={p.PoNumber} onMouseDown={() => {
                      setSyncFilters(prev => ({ ...prev, poNumbers: [...prev.poNumbers, p.PoNumber ?? ""] }));
                      setPoSearch("");
                      setPoDropdownOpen(false);
                    }} style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 10 }}
                      onMouseEnter={e => e.currentTarget.style.background = "#334155"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 13 }}>{p.PoNumber}</span>
                      <span style={{ color: "#9CA3AF", fontSize: 12 }}>{p.VendorName}</span>
                      <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{fmtDate(p.DateExpectedDelivery)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Date range */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={S.label}>Date Created — From</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...S.input, paddingRight: syncFilters.dateFrom ? 58 : 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateFrom}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateFrom: v }));
                  }} />
                {syncFilters.dateFrom && (
                  <button onClick={() => setSyncFilters(p => ({ ...p, dateFrom: "" }))}
                    style={{ position: "absolute", right: 34, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
                )}
                <input type="date" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", opacity: 0, width: 24, height: 24, cursor: "pointer" }}
                  onChange={e => {
                    if (e.target.value) {
                      const [y, m, d] = e.target.value.split("-");
                      setSyncFilters(p => ({ ...p, dateFrom: `${m}/${d}/${y}` }));
                    }
                  }} />
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, pointerEvents: "none" }}>📅</span>
              </div>
            </div>
            <div>
              <label style={S.label}>Date Created — To</label>
              <div style={{ position: "relative" }}>
                <input style={{ ...S.input, paddingRight: syncFilters.dateTo ? 58 : 36 }}
                  placeholder="MM/DD/YYYY"
                  value={syncFilters.dateTo}
                  onChange={e => {
                    let v = e.target.value.replace(/[^\d/]/g, "");
                    setSyncFilters(p => ({ ...p, dateTo: v }));
                  }} />
                {syncFilters.dateTo && (
                  <button onClick={() => setSyncFilters(p => ({ ...p, dateTo: "" }))}
                    style={{ position: "absolute", right: 34, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
                )}
                <input type="date" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", opacity: 0, width: 24, height: 24, cursor: "pointer" }}
                  onChange={e => {
                    if (e.target.value) {
                      const [y, m, d] = e.target.value.split("-");
                      setSyncFilters(p => ({ ...p, dateTo: `${m}/${d}/${y}` }));
                    }
                  }} />
                <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 16, pointerEvents: "none" }}>📅</span>
              </div>
            </div>
          </div>

          {/* Status multi-select */}
          <label style={S.label}>Status (select one or more, or leave blank for all)</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {STATUS_OPTIONS.map(s => {
              const active = syncFilters.statuses.includes(s);
              const color  = STATUS_COLORS[s] ?? "#6B7280";
              return (
                <button key={s} onClick={() => setSyncFilters(p => ({
                  ...p,
                  statuses: active ? p.statuses.filter(x => x !== s) : [...p.statuses, s]
                }))} style={{
                  background: active ? color + "33" : "#0F172A",
                  border: `1px solid ${active ? color : "#334155"}`,
                  color: active ? color : "#9CA3AF",
                  borderRadius: 20, padding: "5px 14px", fontSize: 13,
                  cursor: "pointer", fontWeight: active ? 600 : 400,
                }}>{s}</button>
              );
            })}
          </div>

          {/* Vendor multi-select */}
          <label style={S.label}>
            Vendor (select one or more, or leave blank for all)
            {loadingVendors && <span style={{ color: "#6B7280", fontWeight: 400, marginLeft: 8 }}>Loading…</span>}
          </label>
          <input style={{ ...S.input, marginBottom: 8 }}
            placeholder="🔍 Type to search vendors…"
            value={vendorSearch}
            onChange={e => setVendorSearch(e.target.value)} />
          <div style={{ maxHeight: 160, overflowY: "auto", background: "#0F172A", borderRadius: 8, marginBottom: 8 }}>
            {!vendorSearch && filteredVendorList.length === 0 && (
              <div style={{ padding: 12, color: "#6B7280", fontSize: 13 }}>
                {allVendors.length === 0 ? "No vendors loaded yet — sync will fetch all." : "Type to search vendors."}
              </div>
            )}
            {vendorSearch && filteredVendorList.length === 0 && (
              <div style={{ padding: 12, color: "#6B7280", fontSize: 13 }}>No vendors match your search.</div>
            )}
            {(vendorSearch ? filteredVendorList : []).map(v => {
              const active = syncFilters.vendors.includes(v);
              const isManual = manualVendors.includes(v);
              return (
                <div key={v} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #1E293B", cursor: "pointer",
                  background: active ? "#3B82F620" : "transparent" }}
                  onClick={() => setSyncFilters(p => ({
                    ...p,
                    vendors: active ? p.vendors.filter(x => x !== v) : [...p.vendors, v]
                  }))}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${active ? "#3B82F6" : "#334155"}`,
                      background: active ? "#3B82F6" : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {active && <span style={{ color: "#fff", fontSize: 10 }}>✓</span>}
                    </div>
                    <span style={{ color: "#D1D5DB", fontSize: 13 }}>{v}</span>
                    {isManual && <span style={{ fontSize: 10, color: "#6B7280", background: "#1E293B", borderRadius: 4, padding: "1px 5px" }}>manual</span>}
                  </div>
                  {isManual && (
                    <button style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 12 }}
                      onClick={e => { e.stopPropagation(); setConfirmModal({ title: "Remove Vendor", message: `Are you sure you want to remove vendor "${v}"?`, icon: "🗑", confirmText: "Remove", confirmColor: "#EF4444", onConfirm: () => removeManualVendor(v) }); }}>✕</button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add manual vendor */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input style={{ ...S.input, marginBottom: 0 }} placeholder="Add vendor manually…"
              value={newManualVendor} onChange={e => setNewManualVendor(e.target.value)}
              onKeyDown={e => e.key === "Enter" && saveManualVendor()} />
            <button style={{ ...S.btnSecondary, whiteSpace: "nowrap" }} onClick={saveManualVendor}>+ Add</button>
          </div>

          {/* Sync vendors to Design Calendar */}
          <button
            style={{ ...S.btnSecondary, width: "100%", marginBottom: 16, color: "#34D399", borderColor: "#34D39944", fontSize: 12 }}
            onClick={() => setConfirmModal({
              title: "Sync Vendors → Design Calendar",
              message: `Replace all Design Calendar vendors with the ${allVendors.length} vendor${allVendors.length !== 1 ? "s" : ""} currently in PO WIP? Any existing DC vendor settings (country, lead times, etc.) will be preserved where names match. Vendors not in PO WIP will be removed.`,
              icon: "🔄",
              confirmText: "Replace",
              confirmColor: "#10B981",
              onConfirm: () => syncVendorsToDC(true, allVendors),
            })}
          >
            🔄 Sync All Vendors → Design Calendar
          </button>

          {/* Selected summary */}
          {(syncFilters.vendors.length > 0 || syncFilters.statuses.length > 0 || syncFilters.poNumbers.length > 0 || syncFilters.dateFrom || syncFilters.dateTo) && (
            <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#9CA3AF" }}>
              <strong style={{ color: "#60A5FA" }}>Will sync:</strong>
              {syncFilters.poNumbers.length > 0 && <span style={{ marginLeft: 8 }}>PO#s: <b style={{ color: "#F1F5F9" }}>{syncFilters.poNumbers.join(", ")}</b></span>}
              {syncFilters.dateFrom && <span style={{ marginLeft: 8 }}>From <b style={{ color: "#F1F5F9" }}>{syncFilters.dateFrom}</b></span>}
              {syncFilters.dateTo   && <span style={{ marginLeft: 8 }}>To <b style={{ color: "#F1F5F9" }}>{syncFilters.dateTo}</b></span>}
              {syncFilters.statuses.length > 0 && <span style={{ marginLeft: 8 }}>Status: <b style={{ color: "#F1F5F9" }}>{syncFilters.statuses.join(", ")}</b></span>}
              {syncFilters.vendors.length  > 0 && <span style={{ marginLeft: 8 }}>Vendors: <b style={{ color: "#F1F5F9" }}>{syncFilters.vendors.join(", ")}</b></span>}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button style={{ ...S.btnSecondary, flex: 1 }} onClick={() => { setSyncFilters({ poNumbers: [], dateFrom: "", dateTo: "", vendors: [], statuses: [] }); setPoSearch(""); }}>
              Clear Filters
            </button>
            <button style={{ ...S.btnSecondary }} onClick={() => { setShowSyncModal(false); setShowSyncLog(true); }}
              title={`${syncLog.length} sync${syncLog.length !== 1 ? "s" : ""} logged`}>
              📋 Log{syncLog.length > 0 ? ` (${syncLog.length})` : ""}
            </button>
            <button style={{ ...S.btnPrimary, flex: 2 }} onClick={() => syncFromXoro(syncFilters)}>
              🔄 {syncFilters.vendors.length === 0 && syncFilters.statuses.length === 0 && syncFilters.poNumbers.length === 0 && !syncFilters.dateFrom ? "Sync All POs" : "Sync Filtered POs"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC PROGRESS MODAL
// ════════════════════════════════════════════════════════════════════════════

function SyncProgressModal({ syncProgress, syncProgressMsg, syncErr, cancelSync }: {
  syncProgress: number;
  syncProgressMsg: string;
  syncErr: string;
  cancelSync: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 }}>
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 16, padding: 32, width: 420, boxShadow: "0 32px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#F1F5F9", marginBottom: 8 }}>🔄 Syncing from Xoro…</div>
        <div style={{ fontSize: 13, color: "#9CA3AF", marginBottom: 20 }}>{syncProgressMsg || "Please wait…"}</div>
        <div style={{ background: "#0F172A", borderRadius: 8, overflow: "hidden", height: 10, marginBottom: 12 }}>
          <div style={{ height: "100%", width: `${syncProgress}%`, background: "linear-gradient(90deg,#3B82F6,#8B5CF6)", borderRadius: 8, transition: "width 0.4s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6B7280" }}>
          <span>{syncProgress}%</span>
          <button onClick={cancelSync} style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>✕ Cancel</button>
        </div>
        {syncErr && <div style={{ color: "#EF4444", fontSize: 13, marginTop: 12 }}>{syncErr}</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC DONE MODAL
// ════════════════════════════════════════════════════════════════════════════

function SyncDoneModal({ syncDone, setSyncDone }: {
  syncDone: { added: number; changed: number; deleted: number } | null;
  setSyncDone: (v: { added: number; changed: number; deleted: number } | null) => void;
}) {
  const [countdown, setCountdown] = useState(4);
  useEffect(() => {
    if (!syncDone) return;
    setCountdown(4);
    const t = setInterval(() => setCountdown(c => c - 1), 1000);
    const close = setTimeout(() => setSyncDone(null), 4000);
    return () => { clearInterval(t); clearTimeout(close); };
  }, [syncDone, setSyncDone]);
  if (!syncDone) return null;
  const { added, changed, deleted } = syncDone;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 }}>
      <div style={{ background: "#1E293B", border: "1px solid #10B981", borderRadius: 16, padding: 32, width: 380, boxShadow: "0 32px 80px rgba(0,0,0,0.5)", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#10B981", marginBottom: 16 }}>Sync Complete!</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
          {[["Added", added, "#10B981"], ["Updated", changed, "#60A5FA"], ["Removed", deleted, "#F87171"]].map(([label, count, color]) => (
            <div key={String(label)} style={{ background: "#0F172A", borderRadius: 10, padding: "12px 8px" }}>
              <div style={{ fontSize: 26, fontWeight: 800, color: color as string }}>{count as number}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 2 }}>{label as string}</div>
            </div>
          ))}
        </div>
        <button onClick={() => setSyncDone(null)} style={{ ...S.btnPrimary, width: "100%" }}>
          OK{countdown > 0 ? ` (${countdown})` : ""}
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC LOG MODAL
// ════════════════════════════════════════════════════════════════════════════

function SyncLogModal({ syncLog, setShowSyncLog }: {
  syncLog: SyncLogEntry[];
  setShowSyncLog: (v: boolean) => void;
}) {
  return (
    <div style={S.modalOverlay} onClick={() => setShowSyncLog(false)}>
      <div style={{ ...S.modal, width: 620, maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={S.modalTitle}>📋 Sync Log</h2>
          <button style={S.closeBtn} onClick={() => setShowSyncLog(false)}>✕</button>
        </div>
        <div style={{ ...S.modalBody, overflowY: "auto", flex: 1 }}>
          {syncLog.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#6B7280", fontSize: 14 }}>No sync history yet</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {syncLog.map((entry, i) => {
                const hasFilters = entry.filters && Object.values(entry.filters).some(v => v && (Array.isArray(v) ? v.length > 0 : true));
                const posUpdated = entry.added + entry.changed + entry.deleted;
                return (
                  <div key={i} style={{ background: "#0F172A", border: `1px solid ${entry.success ? "#1E3A5F" : "#7F1D1D"}`, borderRadius: 10, padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 15 }}>{entry.success ? "✅" : "❌"}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: entry.success ? "#34D399" : "#F87171" }}>
                        {entry.success ? "Sync successful" : "Sync failed"}
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "#6B7280" }}>
                        {new Date(entry.ts).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "#9CA3AF" }}>
                      <span>👤 <b style={{ color: "#CBD5E1" }}>{entry.user}</b></span>
                      {entry.success ? (
                        <>
                          <span style={{ color: posUpdated > 0 ? "#F1F5F9" : "#6B7280" }}>
                            POs updated: <b style={{ color: posUpdated > 0 ? "#60A5FA" : "#6B7280" }}>{posUpdated > 0 ? posUpdated : "none"}</b>
                          </span>
                          {entry.added > 0   && <span>➕ Added <b style={{ color: "#10B981" }}>{entry.added}</b></span>}
                          {entry.changed > 0 && <span>✏️ Changed <b style={{ color: "#60A5FA" }}>{entry.changed}</b></span>}
                          {entry.deleted > 0 && <span>🗑 Removed <b style={{ color: "#F87171" }}>{entry.deleted}</b></span>}
                        </>
                      ) : (
                        <span style={{ color: "#FCA5A5" }}>Error: {entry.error}</span>
                      )}
                    </div>
                    {hasFilters && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#475569" }}>
                        Filters: {[
                          entry.filters?.vendors?.length ? `Vendors: ${entry.filters.vendors.join(", ")}` : null,
                          entry.filters?.statuses?.length ? `Status: ${entry.filters.statuses.join(", ")}` : null,
                          entry.filters?.poNumbers?.length ? `PO#: ${entry.filters.poNumbers.join(", ")}` : null,
                          entry.filters?.dateFrom ? `From ${entry.filters.dateFrom}` : null,
                          entry.filters?.dateTo   ? `To ${entry.filters.dateTo}` : null,
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
