import React from "react";
import { type XoroPO, type Milestone, type View, STATUS_OPTIONS } from "../../utils/tandaTypes";
import S from "../styles";
import { PORow } from "../components/PORow";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ListViewProps {
  pos: XoroPO[];
  filtered: XoroPO[];
  search: string;
  setSearch: (v: string) => void;
  filterStatus: string;
  setFilterStatus: (v: string) => void;
  filterVendor: string;
  setFilterVendor: (v: string) => void;
  vendors: string[];
  sortBy: "ddp" | "po_date" | "status";
  setSortBy: (v: "ddp" | "po_date" | "status") => void;
  sortDir: "asc" | "desc";
  setSortDir: (fn: (d: "asc" | "desc") => "asc" | "desc") => void;
  loading: boolean;
  syncing: boolean;
  lastSync: string;
  setView: (v: View) => void;
  setDetailMode: (v: "header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all") => void;
  setNewNote: (v: string) => void;
  setSelected: (v: XoroPO | null) => void;
  setShowSyncModal: (v: boolean) => void;
  loadVendors: () => void;
  milestones: Record<string, Milestone[]>;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ListView({
  pos,
  filtered,
  search,
  setSearch,
  filterStatus,
  setFilterStatus,
  filterVendor,
  setFilterVendor,
  vendors,
  sortBy,
  setSortBy,
  sortDir,
  setSortDir,
  loading,
  syncing,
  lastSync,
  setView,
  setDetailMode,
  setNewNote,
  setSelected,
  setShowSyncModal,
  loadVendors,
  milestones,
}: ListViewProps) {
  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={S.filters}>
        <input style={{ ...S.input, flex: 1, marginBottom: 0 }} placeholder="🔍 Search PO#, vendor, brand, style #, memo…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select style={{ ...S.select, width: 160 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="All">All PO Statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
        </select>
        <select style={{ ...S.select, width: 180 }} value={filterVendor} onChange={e => setFilterVendor(e.target.value)}>
          {vendors.map(v => <option key={v} value={v}>{v === "All" ? "All Vendors" : v}</option>)}
        </select>
        <select
          style={{ ...S.select, width: 150 }}
          value={sortBy}
          onChange={e => setSortBy(e.target.value as "ddp" | "po_date" | "status")}
          title="Sort by"
        >
          <option value="ddp">Sort by DDP date</option>
          <option value="po_date">Sort by PO date</option>
          <option value="status">Sort by Status</option>
        </select>
        <button
          style={{ ...S.btnSecondary, minWidth: 130 }}
          onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}
          title="Toggle sort direction"
        >
          {sortBy === "status"
            ? (sortDir === "asc" ? "↓ Delayed first" : "↑ Completed first")
            : (sortDir === "asc" ? "↓ Oldest first" : "↑ Newest first")}
        </button>
        <button style={S.btnSecondary} onClick={() => { setSearch(""); setFilterStatus("All"); setFilterVendor("All"); setSortBy("ddp"); setSortDir(() => "asc"); }}>
          Clear
        </button>
      </div>
      <div style={S.card}>
        <div style={{ marginBottom: 12, color: "#9CA3AF", fontSize: 13 }}>
          Showing {filtered.length} of {pos.length} purchase orders
          {lastSync && <span style={{ marginLeft: 12 }}>· Last synced: {new Date(lastSync).toLocaleString()}</span>}
        </div>
        {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
        {!loading && filtered.length === 0 && (
          <div style={S.emptyState}>
            <p>{pos.length === 0 ? "No POs loaded. Click Sync to fetch from Xoro." : "No POs match your filters."}</p>
            {pos.length === 0 && <button style={S.btnPrimary} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing}>🔄 Sync from Xoro</button>}
          </div>
        )}
        {filtered.map((po, i) => <PORow key={po.PoNumber ?? i} po={po} milestones={milestones[po.PoNumber ?? ""] || []} today={today} weekFromNow={weekFromNow} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); }} detailed />)}
      </div>
    </div>
  );
}
