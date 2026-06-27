// Spec sheet detail panel extracted from TechPack.tsx. Full-screen
// overlay with style metadata form on top + a measurement grid below.
// The form uses Design Calendar dropdowns (brands/seasons/cats/etc.)
// passed in as props. Each save round-trips through onSave so the
// parent stays in control of persistence.

import { useState } from "react";
import type { SpecSheet, SpecSheetRow } from "../types";
import { today, uid } from "../utils";
import { SIZE_PRESETS } from "../constants";
import {
  createSpecSheetRow,
  addSizeToSpecSheet,
  removeSizeFromSpecSheet,
} from "../specOps";
import { subCategoriesFor, type CategoryLike } from "../listLogic";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

export interface SpecSheetDetailProps {
  ss: SpecSheet;
  /** Persist a new version of this sheet. Stamps updatedAt for you. */
  onSave: (updated: SpecSheet) => void;
  onClose: () => void;
  dcBrands: Array<{ name: string }>;
  dcSeasons: string[];
  dcCategories: CategoryLike[];
  dcGenders: string[];
  dcVendors: Array<{ name: string }>;
  downloadSpecSheetExcel: (ss: SpecSheet) => void;
  parseSpecSheetExcel: (file: File) => Promise<{ rows: SpecSheetRow[]; sizes: string[] }>;
  showToast: (msg: string) => void;
}

export function SpecSheetDetail({
  ss,
  onSave,
  onClose,
  dcBrands,
  dcSeasons,
  dcCategories,
  dcGenders,
  dcVendors,
  downloadSpecSheetExcel,
  parseSpecSheetExcel,
  showToast,
}: SpecSheetDetailProps) {
  const sizes = ss.sizes;
  const detSubCats = subCategoriesFor(dcCategories, ss.category);
  // Local UI state for the "+ Size Column" inline input.
  const [showNewSizeInput, setShowNewSizeInput] = useState(false);
  const [newSizeInput, setNewSizeInput] = useState("");
  const selStyle = { ...S.input, appearance: "none" as const };

  const updateSS = (changes: Partial<SpecSheet>) => {
    onSave({ ...ss, ...changes, updatedAt: today() });
  };

  const addRow = () => updateSS({ rows: [...ss.rows, createSpecSheetRow(sizes)] });

  const addSizeCol = (sizeName: string) => {
    const next = addSizeToSpecSheet(ss.rows, sizes, sizeName);
    if (next.sizes !== sizes) updateSS(next); // skip no-op
  };

  const removeSizeCol = (sizeName: string) => {
    updateSS(removeSizeFromSpecSheet(ss.rows, sizes, sizeName));
  };

  const updateRow = (idx: number, changes: Partial<SpecSheetRow>) => {
    const updated = [...ss.rows];
    updated[idx] = { ...updated[idx], ...changes };
    updateSS({ rows: updated });
  };

  return (
    <div style={S.detailOverlay} onClick={onClose}>
      <div style={S.detailPanel} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={S.detailHeader}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={S.detailPONum}>{ss.styleNumber || "—"}</span>
            </div>
            <div style={S.detailVendor}>{ss.styleName}</div>
            <div style={{ color: "#6B7280", fontSize: 13, marginTop: 4 }}>{ss.brand}{ss.season ? ` · ${ss.season}` : ""}{ss.category ? ` · ${ss.category}` : ""}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <button
              onClick={() => downloadSpecSheetExcel(ss)}
              style={{ background: "#1D6F42", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 12, fontWeight: 600, fontFamily: "inherit", transition: "background 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#155734"}
              onMouseLeave={e => e.currentTarget.style.background = "#1D6F42"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#fff" fillOpacity=".2" stroke="#fff" strokeWidth="1.5"/><path d="M14 2v6h6" stroke="#fff" strokeWidth="1.5"/><path d="M8 13l2.5 4M8 17l2.5-4M13 13v4M15.5 13v4M13 15h2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Excel
            </button>
            <label style={S.btnSmall} title="Upload from Excel">
              Upload Excel
              <input type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={async e => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  showToast("Parsing file...");
                  const result = await parseSpecSheetExcel(file);
                  updateSS({ rows: result.rows, sizes: result.sizes });
                  showToast("Spec sheet imported!");
                } catch (err) {
                  showToast("Failed to parse file");
                  console.error(err);
                }
              }} />
            </label>
            <button style={S.closeBtn} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: 24, flex: 1, overflowY: "auto" }}>
          {/* Style Info */}
          <div style={{ background: "#0F172A", borderRadius: 10, padding: 16, marginBottom: 20, border: "1px solid #334155" }}>
            <div style={{ color: "#94A3B8", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 12 }}>Style Info</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Style Name</label>
                <input style={S.input} value={ss.styleName} onChange={e => updateSS({ styleName: e.target.value })} />
              </div>
              <div>
                <label style={S.label}>Style Number</label>
                <input style={S.input} value={ss.styleNumber} onChange={e => updateSS({ styleNumber: e.target.value })} />
              </div>
              <div>
                <label style={S.label}>Brand</label>
                {dcBrands.length > 0 ? (
                  <SearchableSelect
                    value={ss.brand || null}
                    onChange={v => updateSS({ brand: v })}
                    options={dcBrands.map(b => ({ value: b.name, label: b.name }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                ) : (
                  <input style={S.input} value={ss.brand} onChange={e => updateSS({ brand: e.target.value })} />
                )}
              </div>
              <div>
                <label style={S.label}>Season</label>
                {dcSeasons.length > 0 ? (
                  <SearchableSelect
                    value={ss.season || null}
                    onChange={v => updateSS({ season: v })}
                    options={dcSeasons.map(s => ({ value: s, label: s }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                ) : (
                  <input style={S.input} value={ss.season} onChange={e => updateSS({ season: e.target.value })} />
                )}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={S.label}>Category</label>
                {dcCategories.length > 0 ? (
                  <SearchableSelect
                    value={ss.category || null}
                    onChange={v => updateSS({ category: v, subCategory: "" })}
                    options={dcCategories.map(c => ({ value: c.name, label: c.name }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                ) : (
                  <input style={S.input} value={ss.category} onChange={e => updateSS({ category: e.target.value })} />
                )}
              </div>
              {detSubCats.length > 0 && (
                <div>
                  <label style={S.label}>Sub-Category</label>
                  <SearchableSelect
                    value={ss.subCategory || null}
                    onChange={v => updateSS({ subCategory: v })}
                    options={detSubCats.map(sc => ({ value: sc, label: sc }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                </div>
              )}
              <div>
                <label style={S.label}>Gender</label>
                {dcGenders.length > 0 ? (
                  <SearchableSelect
                    value={ss.gender || null}
                    onChange={v => updateSS({ gender: v })}
                    options={dcGenders.map(g => ({ value: g, label: g }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                ) : (
                  <input style={S.input} value={ss.gender || ""} onChange={e => updateSS({ gender: e.target.value })} />
                )}
              </div>
              <div>
                <label style={S.label}>Vendor</label>
                {dcVendors.length > 0 ? (
                  <SearchableSelect
                    value={ss.vendor || null}
                    onChange={v => updateSS({ vendor: v })}
                    options={dcVendors.map(v => ({ value: v.name, label: v.name }))}
                    placeholder="— select —"
                    inputStyle={selStyle}
                  />
                ) : (
                  <input style={S.input} value={ss.vendor || ""} onChange={e => updateSS({ vendor: e.target.value })} />
                )}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>Description</label>
              <input style={S.input} value={ss.description} onChange={e => updateSS({ description: e.target.value })} />
            </div>
            <div>
              <label style={S.label}>Sizes</label>
              <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
                {SIZE_PRESETS.map(p => (
                  <button key={p.label} style={{ ...S.btnSmall, fontSize: 11 }} onClick={() => {
                    // Apply preset: keep existing values for sizes that
                    // overlap, blank for any new sizes the preset adds.
                    const newRows = ss.rows.map(r => {
                      const v: Record<string, string> = {};
                      p.sizes.forEach(s => { v[s] = r.values[s] || ""; });
                      return { ...r, values: v };
                    });
                    updateSS({ sizes: p.sizes, rows: newRows });
                  }}>{p.label}</button>
                ))}
              </div>
              <input style={S.input} value={ss.sizes.join(", ")} onChange={e => {
                const newSizes = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                const newRows = ss.rows.map(r => {
                  const v: Record<string, string> = {};
                  newSizes.forEach(s => { v[s] = r.values[s] || ""; });
                  return { ...r, values: v };
                });
                updateSS({ sizes: newSizes, rows: newRows });
              }} />
            </div>
          </div>

          {/* Measurements Table */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Measurements</h3>
            <div style={{ display: "flex", gap: 8 }}>
              {showNewSizeInput ? (
                <>
                  <input
                    style={{ ...S.input, width: 80, padding: "4px 8px", fontSize: 12 }}
                    placeholder="Size"
                    value={newSizeInput}
                    onChange={e => setNewSizeInput(e.target.value)}
                  />
                  <button style={S.btnSmall} onClick={() => { addSizeCol(newSizeInput); setNewSizeInput(""); setShowNewSizeInput(false); }}>Add</button>
                  <button
                    style={{ ...S.btnSmall, background: "none", color: "#6B7280" }}
                    onClick={() => setShowNewSizeInput(false)}
                  >Cancel</button>
                </>
              ) : (
                <button style={S.btnSmall} onClick={() => setShowNewSizeInput(true)}>+ Size Column</button>
              )}
              <button
                style={{ ...S.btnSmall, background: "#1E3A5F", color: "#93C5FD", border: "1px solid #2D5A8E" }}
                onClick={() => updateSS({
                  rows: [...ss.rows, { id: uid(), pointOfMeasure: "New Section", tolerance: "", values: {}, isSection: true }],
                })}
              >+ Section</button>
              <button style={S.btnSmall} onClick={addRow}>+ Measurement</button>
            </div>
          </div>

          {ss.rows.length === 0 ? (
            <div style={{ ...S.emptyState, padding: 30 }}>
              <p style={{ color: "#6B7280", fontSize: 13 }}>No measurements yet. Add rows or upload from Excel.</p>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Point of Measure</th>
                    <th style={S.th}>Tolerance</th>
                    {sizes.map(s => (
                      <th key={s} style={S.th}>
                        {s}
                        <button style={{ ...S.iconBtnTiny, marginLeft: 4 }} onClick={() => removeSizeCol(s)}>✕</button>
                      </th>
                    ))}
                    <th style={S.th}>Del</th>
                  </tr>
                </thead>
                <tbody>
                  {ss.rows.map((row, idx) => (
                    row.isSection ? (
                      <tr key={row.id}>
                        <td colSpan={3 + sizes.length} style={{ background: "#1E3A5F", color: "#93C5FD", fontWeight: 700, fontSize: 12, padding: "6px 10px", letterSpacing: 0.5, borderTop: "1px solid #334155", borderBottom: "1px solid #334155" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <input
                              style={{ background: "none", border: "none", color: "#93C5FD", fontWeight: 700, fontSize: 12, width: "100%", fontFamily: "inherit", cursor: "text", letterSpacing: 0.5 }}
                              value={row.pointOfMeasure}
                              onChange={e => updateRow(idx, { pointOfMeasure: e.target.value })}
                            />
                            <button
                              style={{ ...S.iconBtnTiny, flexShrink: 0, marginLeft: 4 }}
                              onClick={() => updateSS({ rows: ss.rows.filter(x => x.id !== row.id) })}
                            >Delete</button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id} style={{ background: idx % 2 === 0 ? "#0F172A" : "#1A2332" }}>
                        <td style={S.td}>
                          <input
                            style={S.cellInput}
                            value={row.pointOfMeasure}
                            onChange={e => updateRow(idx, { pointOfMeasure: e.target.value })}
                            placeholder="e.g. Chest"
                          />
                        </td>
                        <td style={S.td}>
                          <input
                            style={{ ...S.cellInput, width: 70 }}
                            value={row.tolerance}
                            onChange={e => updateRow(idx, { tolerance: e.target.value })}
                          />
                        </td>
                        {sizes.map(s => (
                          <td key={s} style={S.td}>
                            <input
                              style={{ ...S.cellInput, width: 60, textAlign: "center" }}
                              value={row.values[s] || ""}
                              onChange={e => updateRow(idx, { values: { ...row.values, [s]: e.target.value } })}
                            />
                          </td>
                        ))}
                        <td style={S.td}>
                          <button
                            style={S.iconBtnTiny}
                            onClick={() => updateSS({ rows: ss.rows.filter(x => x.id !== row.id) })}
                          >Delete</button>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
