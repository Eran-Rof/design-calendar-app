import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import type { ScaleSizeRatio } from "../types";
import { KNOWN_SCALE_CODES } from "../types";
import type { BomCheckResult } from "../services/bomBuilderService";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

interface RatioRow { size: string; qty: string }

function emptyRatioRows(): RatioRow[] {
  return Array.from({ length: 10 }, () => ({ size: "", qty: "" }));
}

function EditModal({ code, existing, onSave, onClose }: {
  code: string; existing: ScaleSizeRatio[]; onSave: (ratios: Array<{ size: string; qty: number }>, desc: string) => void; onClose: () => void;
}) {
  const { scales } = useGS1Store();
  const scale = scales.find(s => s.scale_code === code);
  const [desc, setDesc]     = useState(scale?.description ?? "");
  const [rows, setRows]     = useState<RatioRow[]>(() => {
    if (existing.length > 0) return existing.map(r => ({ size: r.size, qty: String(r.qty) }));
    return emptyRatioRows();
  });

  function setRow(i: number, field: "size" | "qty", val: string) {
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  }

  function handleSave() {
    const ratios = rows
      .filter(r => r.size.trim() && r.qty.trim())
      .map(r => ({ size: r.size.trim(), qty: parseInt(r.qty) }))
      .filter(r => !isNaN(r.qty) && r.qty > 0);
    onSave(ratios, desc);
  }

  const totalUnits = rows.reduce((s, r) => s + (parseInt(r.qty) || 0), 0);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 420, maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.22)" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Scale: {code}</h3>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: TH.textSub2 }}>Description</label>
          <input value={desc} onChange={e => setDesc(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }} />
        </div>
        <p style={{ fontSize: 12, fontWeight: 600, color: TH.textSub2, margin: "0 0 6px" }}>Size Ratios (leave blank to skip)</p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...TH_STYLE, width: "45%" }}>Size</th>
              <th style={{ ...TH_STYLE, width: "45%" }}>Qty per Pack</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={TD_STYLE}><input value={r.size} onChange={e => setRow(i, "size", e.target.value)} style={{ width: "90%", padding: "4px 6px", border: `1px solid ${TH.border}`, borderRadius: 4, fontSize: 12 }} /></td>
                <td style={TD_STYLE}><input type="number" value={r.qty} onChange={e => setRow(i, "qty", e.target.value)} min={0} style={{ width: "70px", padding: "4px 6px", border: `1px solid ${TH.border}`, borderRadius: 4, fontSize: 12 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>Total units per pack: <strong>{totalUnits || "—"}</strong></p>
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={handleSave} style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Save</button>
          <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 7, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function ScaleMasterPanel() {
  const { scales, scaleRatios, scaleLoading, scaleError, loadScales, saveScale, deleteScale, checkUpcCoverageForStyleColor } = useGS1Store();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding,  setAdding]  = useState(false);
  const [newCode, setNewCode] = useState("");
  const [saved,   setSaved]   = useState(false);

  // UPC coverage check state
  const [coverageStyle,  setCoverageStyle]  = useState("");
  const [coverageColor,  setCoverageColor]  = useState("");
  const [coverageScale,  setCoverageScale]  = useState("");
  const [coverageResult, setCoverageResult] = useState<BomCheckResult | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError,  setCoverageError]  = useState("");

  useEffect(() => { loadScales(); }, []);

  const ratiosFor = (code: string) => scaleRatios.filter(r => r.scale_code === code);

  async function handleSave(code: string, ratios: Array<{ size: string; qty: number }>, desc: string) {
    await saveScale({ scale_code: code, description: desc, ratios });
    setEditing(null);
    setAdding(false);
    setNewCode("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleDelete(code: string) {
    if (!confirm(`Delete scale ${code}? This cannot be undone if GTINs reference it.`)) return;
    await deleteScale(code);
  }

  async function handleCheckCoverage(e: React.FormEvent) {
    e.preventDefault();
    if (!coverageStyle.trim() || !coverageColor.trim() || !coverageScale.trim()) return;
    setCoverageLoading(true); setCoverageResult(null); setCoverageError("");
    try {
      const result = await checkUpcCoverageForStyleColor(
        coverageStyle.trim().toUpperCase(),
        coverageColor.trim().toUpperCase(),
        coverageScale.trim().toUpperCase()
      );
      setCoverageResult(result);
    } catch (err) {
      setCoverageError((err as Error).message);
    } finally { setCoverageLoading(false); }
  }

  const knownCodes = Array.from(KNOWN_SCALE_CODES).sort();

  return (
    <div style={{ padding: "24px 16px", maxWidth: 900, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Scale Master</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Manage pack scale codes and their size/qty ratios. Scale codes match what appears in packing lists.
      </p>

      {scaleError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {scaleError}
        </div>
      )}

      {/* Add scale */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>Add Scale Code</h3>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={newCode} onChange={e => setNewCode(e.target.value)}
            style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
            <option value="">— select code —</option>
            {knownCodes.filter(c => !scales.find(s => s.scale_code === c)).map(c => <option key={c}>{c}</option>)}
          </select>
          <input value={newCode} onChange={e => setNewCode(e.target.value.toUpperCase().slice(0, 4))}
            placeholder="or type custom" maxLength={4}
            style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 120 }} />
          <button onClick={() => { if (newCode.trim()) setAdding(true); }}
            disabled={!newCode.trim() || scaleLoading}
            style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Add &amp; Configure
          </button>
          {saved && <span style={{ color: "#276749", fontWeight: 600, fontSize: 13 }}>✓ Saved</span>}
        </div>
      </div>

      {/* Scale list */}
      <div style={{ background: TH.surface, borderRadius: 10, boxShadow: `0 1px 4px ${TH.shadow}` }}>
        {scaleLoading
          ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : scales.length === 0
            ? <p style={{ padding: 20, color: TH.textMuted, fontSize: 13 }}>No scale codes yet. Add one above.</p>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Scale Code", "Description", "Total Units", "Size Ratios", ""].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {scales.map(sc => {
                    const ratios = ratiosFor(sc.scale_code);
                    return (
                      <tr key={sc.id}>
                        <td style={{ ...TD_STYLE, fontWeight: 700, fontFamily: "monospace" }}>{sc.scale_code}</td>
                        <td style={{ ...TD_STYLE, color: TH.textMuted }}>{sc.description || "—"}</td>
                        <td style={TD_STYLE}>{sc.total_units ?? "—"}</td>
                        <td style={{ ...TD_STYLE, maxWidth: 300 }}>
                          {ratios.length === 0
                            ? <span style={{ color: TH.textMuted, fontSize: 12 }}>No ratios</span>
                            : <span style={{ fontSize: 12, color: TH.textSub2 }}>{ratios.map(r => `${r.size}×${r.qty}`).join(", ")}</span>
                          }
                        </td>
                        <td style={TD_STYLE}>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => setEditing(sc.scale_code)}
                              style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 5, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>
                              Edit
                            </button>
                            <button onClick={() => handleDelete(sc.scale_code)}
                              style={{ background: "transparent", border: `1px solid ${TH.accentBdr}`, borderRadius: 5, padding: "3px 10px", fontSize: 12, cursor: "pointer", color: TH.primary }}>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
        }
      </div>

      {/* UPC Coverage Check */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}`, marginTop: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, color: TH.textSub }}>UPC Coverage Check</h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, color: TH.textMuted }}>
          Check whether UPC Master has a matching UPC for every size in a scale, for a given style and color.
        </p>
        <form onSubmit={handleCheckCoverage} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 16 }}>
          {[
            { label: "Style No", value: coverageStyle, set: setCoverageStyle, placeholder: "e.g. 100227091BK" },
            { label: "Color",    value: coverageColor, set: setCoverageColor, placeholder: "e.g. DRESS BLUES" },
          ].map(f => (
            <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>{f.label}</label>
              <input value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.placeholder}
                style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 180 }} />
            </div>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>Scale Code</label>
            <select value={coverageScale} onChange={e => setCoverageScale(e.target.value)}
              style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
              <option value="">— select —</option>
              {scales.map(s => <option key={s.scale_code}>{s.scale_code}</option>)}
            </select>
          </div>
          <button type="submit" disabled={coverageLoading || !coverageStyle.trim() || !coverageColor.trim() || !coverageScale.trim()}
            style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {coverageLoading ? "Checking…" : "Check Coverage"}
          </button>
        </form>

        {coverageError && (
          <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 6, padding: "8px 12px", fontSize: 13, color: TH.primary, marginBottom: 12 }}>
            {coverageError}
          </div>
        )}

        {coverageResult && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: TH.textSub }}>
                {coverageResult.complete
                  ? "✓ Complete — all sizes have matching UPCs"
                  : `⚠ Incomplete — ${coverageResult.missing_sizes.length} size(s) missing UPCs`}
              </span>
              <span style={{ fontSize: 12, color: TH.textMuted }}>Scale {coverageResult.scale_code}</span>
            </div>
            <table style={{ borderCollapse: "collapse", minWidth: 320 }}>
              <thead>
                <tr>
                  {["Size", "Qty/Pack", "UPC", "Status"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {coverageResult.sizes.map(row => (
                  <tr key={row.size} style={{ background: row.found ? "transparent" : "#FFF5F5" }}>
                    <td style={{ ...TD_STYLE, fontWeight: 700 }}>{row.size}</td>
                    <td style={TD_STYLE}>{row.qty_in_scale}</td>
                    <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 12 }}>{row.upc ?? "—"}</td>
                    <td style={TD_STYLE}>
                      <span style={{ color: row.found ? "#276749" : TH.primary, fontWeight: 600, fontSize: 12 }}>
                        {row.found ? "✓ found" : "✗ missing"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EditModal code={editing} existing={ratiosFor(editing)}
          onSave={(ratios, desc) => handleSave(editing, ratios, desc)}
          onClose={() => setEditing(null)} />
      )}
      {adding && newCode && (
        <EditModal code={newCode} existing={[]}
          onSave={(ratios, desc) => handleSave(newCode, ratios, desc)}
          onClose={() => setAdding(false)} />
      )}
    </div>
  );
}
