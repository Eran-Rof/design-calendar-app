// Spec sheets grid (cards) extracted from TechPack.tsx. Search +
// Templates dropdown + Add/Import dropdown + per-card download/edit/
// delete affordances.
//
// The Import-from-Excel handler is owned by the parent (uses
// detectSpecSheetHeader + extractStyleInfoFromAoa + saveSpecSheets
// + setSelectedSpecSheet + showToast). View receives it as
// `onImportFile: (file: File) => void`.

import { useState } from "react";
import type { SpecSheet } from "../types";
import { filterSpecSheets } from "../listLogic";
import { EMPTY_SPEC_SHEET_FORM, type SpecSheetFormValues } from "../factories";
import S from "../styles";

export interface SpecSheetsViewProps {
  specSheets: SpecSheet[];
  ssSearch: string;
  setSsSearch: (s: string) => void;
  setShowTemplatesModal: (b: boolean) => void;
  setSsForm: (f: SpecSheetFormValues) => void;
  setEditingSpecSheet: (ss: SpecSheet | null) => void;
  setShowSpecSheetModal: (b: boolean) => void;
  setSelectedSpecSheet: (ss: SpecSheet | null) => void;
  downloadSpecSheetExcel: (ss: SpecSheet) => void;
  saveSpecSheets: (sheets: SpecSheet[]) => Promise<void> | void;
  setConfirmDialog: (d: { title: string; message: string; onConfirm: () => void } | null) => void;
  /** Parent-owned XLSX import handler. */
  onImportFile: (file: File) => Promise<void> | void;
}

export function SpecSheetsView({
  specSheets,
  ssSearch,
  setSsSearch,
  setShowTemplatesModal,
  setSsForm,
  setEditingSpecSheet,
  setShowSpecSheetModal,
  setSelectedSpecSheet,
  downloadSpecSheetExcel,
  saveSpecSheets,
  setConfirmDialog,
  onImportFile,
}: SpecSheetsViewProps) {
  const filteredSS = filterSpecSheets(specSheets, ssSearch);
  // Local UI-only state for the Add/Import popover. Doesn't need to
  // round-trip through the parent.
  const [showAddImportMenu, setShowAddImportMenu] = useState(false);

  const openCreateModal = () => {
    setShowAddImportMenu(false);
    setSsForm(EMPTY_SPEC_SHEET_FORM);
    setEditingSpecSheet(null);
    setShowSpecSheetModal(true);
  };

  const handleImportSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowAddImportMenu(false);
    await onImportFile(file);
    e.target.value = "";
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flex: 1 }}>
          <input
            style={{ ...S.input, maxWidth: 300 }}
            placeholder="Search spec sheets..."
            value={ssSearch}
            onChange={e => setSsSearch(e.target.value)}
          />
          <span style={{ color: "#6B7280", fontSize: 13 }}>{filteredSS.length} spec sheets</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setShowTemplatesModal(true)}
            style={{ background: "#334155", border: "1px solid #475569", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#F1F5F9", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = "#475569"}
            onMouseLeave={e => e.currentTarget.style.background = "#334155"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke="#F1F5F9" strokeWidth="1.7"/></svg>
            Templates ▾
          </button>
          <div style={{ position: "relative" }}>
            <button style={S.btnPrimarySmall} onClick={() => setShowAddImportMenu(v => !v)}>
              + Add / Import ▾
            </button>
            {showAddImportMenu && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 299 }} onClick={() => setShowAddImportMenu(false)} />
                <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#1E293B", border: "1px solid #334155", borderRadius: 10, padding: 6, zIndex: 300, minWidth: 200, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                  <button
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#F1F5F9", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 6, fontFamily: "inherit", textAlign: "left" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#334155"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}
                    onClick={openCreateModal}
                  >
                    <div>
                      <div>Add New Spec Sheet</div>
                      <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 400 }}>Create from scratch</div>
                    </div>
                  </button>
                  <div style={{ height: 1, background: "#334155", margin: "4px 0" }} />
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px", background: "none", border: "none", color: "#F1F5F9", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 6, fontFamily: "inherit" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#334155")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    <div>
                      <div>Import from Excel</div>
                      <div style={{ fontSize: 11, color: "#6B7280", fontWeight: 400 }}>Upload .xlsx file</div>
                    </div>
                    <input type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={handleImportSelected} />
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {filteredSS.length === 0 ? (
        <div style={S.emptyState}>
          <p>No spec sheets yet. Create your first one or upload from Excel.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {filteredSS.map(ss => (
            <div
              key={ss.id}
              style={{ ...S.tpCard, cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "#3B82F6")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}
              onClick={() => setSelectedSpecSheet(ss)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, fontSize: 15 }}>{ss.styleNumber || "—"}</span>
                <span style={{ color: "#6B7280", fontSize: 11 }}>{ss.rows.length} measurements</span>
              </div>
              <div style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{ss.styleName}</div>
              <div style={{ color: "#94A3B8", fontSize: 13, marginBottom: 8 }}>{ss.brand}{ss.season ? ` · ${ss.season}` : ""}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "#6B7280", fontSize: 12 }}>{ss.category}</span>
                <div style={{ display: "flex", gap: 4 }} onClick={e => e.stopPropagation()}>
                  <button
                    title="Download Excel"
                    onClick={() => downloadSpecSheetExcel(ss)}
                    style={{ background: "#1D6F42", border: "none", borderRadius: 5, padding: "3px 7px", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, color: "#fff", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#155734"}
                    onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </button>
                  <button style={S.iconBtnTiny} title="Edit" onClick={() => setSelectedSpecSheet(ss)}>Edit</button>
                  <button
                    style={{ ...S.iconBtnTiny, color: "#EF4444" }}
                    title="Delete"
                    onClick={() => setConfirmDialog({
                      title: "Delete Spec Sheet",
                      message: `Delete "${ss.styleName || ss.styleNumber || "this spec sheet"}"? This cannot be undone.`,
                      onConfirm: () => { void saveSpecSheets(specSheets.filter(x => x.id !== ss.id)); },
                    })}
                  >Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
