// BOM tab extracted from TechPack.tsx. Renders the Bill of Materials
// table — fixed-position metadata columns on the left + a variable
// number of colorway columns on the right (each adds 2 sub-cells:
// color/pantone + trial size).
//
// Mutation helpers (addColorway, removeColorway, createBOMItem,
// recomputeBomItemTotal, updateColorSpecOnBOM) live in
// ../calc.ts + ../bomOps.ts and are pinned by unit tests.
//
// NOTE: this file recovers content that was inadvertently deleted in
// PR #183 before being properly extracted. Once this PR lands, the
// BOM tab works again.

import type { TechPack, BOMItem, BOMColorSpec, Colorway, Material } from "../types";
import { fmtCurrency } from "../utils";
import { bomTotal, recomputeBomItemTotal } from "../calc";
import {
  createColorway,
  addColorwayToBOM,
  removeColorwayFromBOM,
  createBOMItem,
  updateColorSpecOnBOM,
} from "../bomOps";
import { CW_COLORS } from "../constants";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import S from "../styles";

const FIXED_COLS = 10; // image, mat no, material, placement, content, weight, qty, uom, unit$, total
const CW_COL_W = 260;  // px per colorway

export interface BOMTabProps {
  tp: TechPack;
  updateSelected: (changes: Partial<TechPack>) => void;
  uploadImage: (file: File, path: string) => Promise<string | null>;
  setLightboxImg: (url: string | null) => void;
  showToast: (msg: string) => void;
  materials: Material[];
  setConfirmDialog: (dialog: { title: string; message: string; onConfirm: () => void } | null) => void;
}

export function BOMTab({
  tp,
  updateSelected,
  uploadImage,
  setLightboxImg,
  showToast,
  materials,
  setConfirmDialog,
}: BOMTabProps) {
  const total = bomTotal(tp.bom);
  const colorways: Colorway[] = tp.colorways || [];

  const addColorway = () => {
    const name = prompt("Colorway name (e.g. BLACKSANDS):");
    if (!name?.trim()) return;
    const cw = createColorway(name);
    updateSelected({ colorways: [...colorways, cw], bom: addColorwayToBOM(tp.bom, cw.id) });
  };

  const removeColorway = (cwId: string) => {
    updateSelected({
      colorways: colorways.filter(cw => cw.id !== cwId),
      bom: removeColorwayFromBOM(tp.bom, cwId),
    });
  };

  const addBOMItem = () => {
    updateSelected({ bom: [...tp.bom, createBOMItem(colorways)] });
  };

  const updateBOMItem = (idx: number, changes: Partial<BOMItem>) => {
    const updated = [...tp.bom];
    updated[idx] = recomputeBomItemTotal(updated[idx], changes);
    updateSelected({ bom: updated });
  };

  const updateColorSpec = (bomIdx: number, cwId: string, changes: Partial<BOMColorSpec>) => {
    updateSelected({ bom: updateColorSpecOnBOM(tp.bom, bomIdx, cwId, changes) });
  };

  return (
    <>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ margin: 0, color: "#F1F5F9", fontSize: 16 }}>Bill of Materials</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.btnSmall} onClick={addColorway}>+ Colorway</button>
          <button style={S.btnSmall} onClick={addBOMItem}>+ Add Item</button>
        </div>
      </div>

      {/* Colorway chips */}
      {colorways.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" as any }}>
          {colorways.map((cw, i) => (
            <div key={cw.id} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 20, padding: "4px 10px 4px 14px", display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: CW_COLORS[i % CW_COLORS.length] }} />
              <span style={{ color: "#D1D5DB", fontSize: 12, fontWeight: 600 }}>{cw.name}</span>
              <button
                style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}
                onClick={() => setConfirmDialog({ title: "Remove Colorway", message: `Remove colorway "${cw.name}"?`, onConfirm: () => removeColorway(cw.id) })}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      {tp.bom.length === 0 ? (
        <div style={{ ...S.emptyState, padding: 30 }}><p style={{ color: "#6B7280" }}>No BOM items yet. Add a colorway and items to get started.</p></div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ ...S.table, minWidth: 780 + colorways.length * CW_COL_W }}>
            <thead>
              {/* Row 1: fixed col headers + colorway group headers */}
              <tr>
                <th style={{ ...S.th, width: 52 }}>Image</th>
                <th style={{ ...S.th, width: 80 }}>Mat No</th>
                <th style={{ ...S.th, width: 140 }}>Material</th>
                <th style={{ ...S.th, width: 180 }}>Placement</th>
                <th style={{ ...S.th, width: 110 }}>Content</th>
                <th style={{ ...S.th, width: 68 }}>Weight</th>
                <th style={{ ...S.th, width: 54 }}>Qty</th>
                <th style={{ ...S.th, width: 50 }}>UOM</th>
                <th style={{ ...S.th, width: 68 }}>Unit $</th>
                <th style={{ ...S.th, width: 70 }}>Total</th>
                {colorways.map((cw, i) => (
                  <th key={cw.id} colSpan={2} style={{ ...S.th, textAlign: "center", borderLeft: "2px solid #334155", color: CW_COLORS[i % CW_COLORS.length], background: "#0A1628", width: CW_COL_W }}>
                    {cw.name}
                  </th>
                ))}
                <th style={{ ...S.th, width: 32 }}></th>
              </tr>
              {/* Row 2: sub-headers for colorway columns */}
              {colorways.length > 0 && (
                <tr>
                  <th colSpan={FIXED_COLS} style={{ ...S.th, background: "#0F172A", padding: 0 }} />
                  {colorways.map(cw => [
                    <th key={cw.id + "-a"} style={{ ...S.th, borderLeft: "2px solid #334155", background: "#0A1628", width: 170, fontSize: 10 }}>Color / Pantone</th>,
                    <th key={cw.id + "-b"} style={{ ...S.th, background: "#0A1628", width: 90, fontSize: 10 }}>Trl / Sz</th>,
                  ])}
                  <th style={{ ...S.th, background: "#0F172A" }} />
                </tr>
              )}
            </thead>
            <tbody>
              {tp.bom.map((b, idx) => {
                const rowBg = idx % 2 === 0 ? "#0F172A" : "#1A2332";
                const cwBg  = idx % 2 === 0 ? "#0A1628" : "#0F1E35";
                return (
                  <tr key={b.id} style={{ background: rowBg }}>
                    <td style={{ ...S.td, width: 52 }}>
                      <label style={{ cursor: "pointer", display: "block" }}>
                        <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                          const file = e.target.files?.[0]; if (!file) return;
                          const url = await uploadImage(file, `/techpacks/${tp.id}/bom/${b.id}/${file.name}`);
                          if (url) updateBOMItem(idx, { image: url }); else showToast("Upload failed");
                        }} />
                        {b.image ? (
                          <img src={b.image} alt="" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 6, border: "1px solid #334155", display: "block" }} onClick={e => { e.preventDefault(); setLightboxImg(b.image!); }} />
                        ) : (
                          <div style={{ width: 44, height: 44, border: "2px dashed #334155", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#4B5563", fontSize: 18 }}>+</div>
                        )}
                      </label>
                      {b.image && (
                        <button
                          style={{ ...S.iconBtnTiny, display: "block", margin: "2px auto 0", color: "#EF4444" }}
                          onClick={() => updateBOMItem(idx, { image: null })}
                        >✕</button>
                      )}
                    </td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 72 }} value={b.materialNo || ""} onChange={e => updateBOMItem(idx, { materialNo: e.target.value })} placeholder="TRM001" /></td>
                    <td style={S.td}>
                      <SearchableSelect
                        value={b.material || null}
                        onChange={v => {
                          const mat = materials.find(m => m.name === v);
                          updateBOMItem(idx, {
                            material: v,
                            supplier: mat?.supplier || b.supplier,
                            unitCost: mat?.unitPrice || b.unitCost,
                            content: mat?.composition || b.content,
                            weight: mat?.weight || b.weight,
                          });
                        }}
                        options={[
                          ...materials.map(m => ({ value: m.name, label: m.name })),
                          ...(b.material && !materials.find(m => m.name === b.material) ? [{ value: b.material, label: b.material }] : []),
                        ]}
                        placeholder="Select..."
                        inputStyle={{ ...S.cellInput, width: "100%" }}
                      />
                      <input style={{ ...S.cellInput, fontSize: 11, marginTop: 3, color: "#94A3B8" }} value={b.material} onChange={e => updateBOMItem(idx, { material: e.target.value })} placeholder="or type name..." />
                    </td>
                    <td style={S.td}><textarea style={{ ...S.cellInput, minHeight: 48, resize: "vertical" as any, fontSize: 12, lineHeight: 1.4 }} value={b.placement} onChange={e => updateBOMItem(idx, { placement: e.target.value })} placeholder="Placement details..." /></td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 104 }} value={b.content || ""} onChange={e => updateBOMItem(idx, { content: e.target.value })} placeholder="100% Cotton" /></td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 62 }} value={b.weight || ""} onChange={e => updateBOMItem(idx, { weight: e.target.value })} placeholder="180g" /></td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 48, textAlign: "center" }} value={b.quantity} onChange={e => updateBOMItem(idx, { quantity: e.target.value })} /></td>
                    <td style={S.td}>
                      <SearchableSelect
                        value={b.uom || "YDS"}
                        onChange={v => updateBOMItem(idx, { uom: v })}
                        options={["YDS", "MTR", "PCS", "KG", "LB", "DOZ", "SET"].map(u => ({ value: u, label: u }))}
                        inputStyle={{ ...S.cellInput, width: 48 }}
                      />
                    </td>
                    <td style={S.td}><input style={{ ...S.cellInput, width: 62, textAlign: "right" }} type="number" step="0.01" value={b.unitCost || ""} onChange={e => updateBOMItem(idx, { unitCost: parseFloat(e.target.value) || 0 })} /></td>
                    <td style={{ ...S.td, color: "#10B981", fontWeight: 600, fontFamily: "monospace", whiteSpace: "nowrap" as any }}>{fmtCurrency(b.totalCost)}</td>
                    {colorways.flatMap(cw => {
                      const spec = (b.colorSpecs || []).find(cs => cs.colorwayId === cw.id) || { colorwayId: cw.id, color: "", pantone: "", trialSize: "" };
                      return [
                        <td key={cw.id + "-c"} style={{ ...S.td, borderLeft: "2px solid #1E3A5F", background: cwBg }}>
                          <input style={{ ...S.cellInput, width: "100%", marginBottom: 3 }} value={spec.color} onChange={e => updateColorSpec(idx, cw.id, { color: e.target.value })} placeholder="Color name" />
                          <input style={{ ...S.cellInput, fontSize: 11, color: "#94A3B8" }} value={spec.pantone} onChange={e => updateColorSpec(idx, cw.id, { pantone: e.target.value })} placeholder="Pantone / code" />
                        </td>,
                        <td key={cw.id + "-d"} style={{ ...S.td, background: cwBg }}>
                          <input style={{ ...S.cellInput, width: 80, textAlign: "center" }} value={spec.trialSize} onChange={e => updateColorSpec(idx, cw.id, { trialSize: e.target.value })} placeholder="32" />
                        </td>,
                      ];
                    })}
                    <td style={S.td}>
                      <button style={S.iconBtnTiny} onClick={() => updateSelected({ bom: tp.bom.filter(x => x.id !== b.id) })}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: "#1A2332", borderTop: "2px solid #334155" }}>
                <td colSpan={9} style={{ ...S.td, textAlign: "right", fontWeight: 700, color: "#F1F5F9" }}>Total BOM Cost:</td>
                <td style={{ ...S.td, color: "#10B981", fontWeight: 700, fontFamily: "monospace", fontSize: 15 }}>{fmtCurrency(total)}</td>
                <td colSpan={colorways.length * 2 + 1} style={S.td} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
