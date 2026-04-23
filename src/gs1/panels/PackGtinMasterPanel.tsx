import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { formatGtin14Display, validateGtin14 } from "../services/gtinService";
import { KNOWN_SCALE_CODES } from "../types";
import type { PackGtin, PackGtinBom, PackGtinBomIssue, BomStatus } from "../types";
import * as db from "../services/supabaseGs1";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

const BOM_STATUS_STYLE: Record<BomStatus, { bg: string; color: string; label: string }> = {
  not_built:  { bg: TH.surfaceHi,  color: TH.textMuted, label: "not built" },
  complete:   { bg: "#F0FFF4",     color: "#276749",     label: "complete" },
  incomplete: { bg: "#FFFBEB",     color: "#92400E",     label: "incomplete" },
  error:      { bg: "#FFF5F5",     color: TH.primary,    label: "error" },
};

function BomStatusBadge({ status }: { status: BomStatus }) {
  const s = BOM_STATUS_STYLE[status];
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

// ── BOM detail drawer ─────────────────────────────────────────────────────────

function BomDrawer({ gtin, onClose }: { gtin: PackGtin; onClose: () => void }) {
  const [lines, setLines]     = useState<PackGtinBom[]>([]);
  const [issues, setIssues]   = useState<PackGtinBomIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [l, i] = await Promise.all([
        db.loadPackGtinBomRows(gtin.pack_gtin),
        db.loadPackGtinBomIssues(gtin.pack_gtin),
      ]);
      setLines(l); setIssues(i); setLoading(false);
    })();
  }, [gtin.pack_gtin]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 560, maxHeight: "80vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.22)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: "0 0 4px", fontSize: 16, fontFamily: "monospace" }}>{gtin.pack_gtin}</h3>
            <p style={{ margin: 0, fontSize: 13, color: TH.textMuted }}>{gtin.style_no} / {gtin.color} / {gtin.scale_code}</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <BomStatusBadge status={gtin.bom_status} />
            <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 6, padding: "4px 12px", fontSize: 12, cursor: "pointer" }}>Close</button>
          </div>
        </div>

        {loading ? (
          <p style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <>
            {/* BOM lines */}
            <div style={{ marginBottom: 20 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 13, color: TH.textSub }}>
                Child UPCs ({lines.length}) &nbsp;·&nbsp; {gtin.units_per_pack ?? "?"} units/pack
              </h4>
              {lines.length === 0 ? (
                <p style={{ fontSize: 13, color: TH.textMuted }}>No BOM rows — build BOM first.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Size", "Child UPC", "Qty/Pack"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map(l => (
                      <tr key={l.id}>
                        <td style={{ ...TD_STYLE, fontWeight: 700 }}>{l.size}</td>
                        <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 12 }}>{l.child_upc}</td>
                        <td style={{ ...TD_STYLE, fontWeight: 600 }}>{l.qty_in_pack}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Issues */}
            {issues.length > 0 && (
              <div>
                <h4 style={{ margin: "0 0 8px", fontSize: 13, color: TH.textSub }}>Build Issues ({issues.length})</h4>
                <div style={{ border: `1px solid ${TH.border}`, borderRadius: 6, overflow: "hidden" }}>
                  {issues.map(iss => (
                    <div key={iss.id} style={{
                      padding: "8px 12px", borderBottom: `1px solid ${TH.border}`, fontSize: 12,
                      background: iss.severity === "error" ? "#FFF5F5" : iss.severity === "warning" ? "#FFFBEB" : "#EBF8FF",
                    }}>
                      <span style={{ fontWeight: 700, marginRight: 6, color: iss.severity === "error" ? TH.primary : iss.severity === "warning" ? "#92400E" : "#2B6CB0" }}>
                        [{iss.severity.toUpperCase()}]
                      </span>
                      {iss.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function PackGtinMasterPanel() {
  const {
    packGtins, gtinLoading, gtinError, companySettings,
    loadPackGtins, loadCompanySettings, generateGtin,
    bomBuilding, bomBuildError, buildBomForGtin, buildBomForAllMissing,
  } = useGS1Store();

  const [searchStyle, setSearchStyle] = useState("");
  const [searchColor, setSearchColor] = useState("");
  const [searchScale, setSearchScale] = useState("");

  const [manualStyle, setManualStyle] = useState("");
  const [manualColor, setManualColor] = useState("");
  const [manualScale, setManualScale] = useState("");
  const [manualMsg,   setManualMsg]   = useState("");
  const [creating,    setCreating]    = useState(false);

  const [drawerGtin, setDrawerGtin]   = useState<PackGtin | null>(null);
  const [buildingId, setBuildingId]   = useState<string | null>(null);
  const [buildMsg,   setBuildMsg]     = useState("");
  const [allBuildMsg, setAllBuildMsg] = useState("");

  useEffect(() => {
    loadPackGtins();
    if (!companySettings) loadCompanySettings();
  }, []);

  async function handleSearch() {
    await loadPackGtins({
      style_no:   searchStyle.trim() || undefined,
      color:      searchColor.trim() || undefined,
      scale_code: searchScale.trim() || undefined,
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!manualStyle.trim() || !manualColor.trim() || !manualScale.trim()) return;
    setCreating(true); setManualMsg("");
    try {
      const g = await generateGtin(manualStyle.trim().toUpperCase(), manualColor.trim().toUpperCase(), manualScale.trim().toUpperCase());
      setManualMsg(`✓ GTIN ready: ${g.pack_gtin}`);
      setManualStyle(""); setManualColor(""); setManualScale("");
    } catch (err) {
      setManualMsg(`Error: ${(err as Error).message}`);
    } finally { setCreating(false); }
  }

  async function handleBuildBom(g: PackGtin) {
    setBuildingId(g.id); setBuildMsg("");
    try {
      const r = await buildBomForGtin(g);
      setBuildMsg(`✓ BOM built for ${g.pack_gtin}: ${r.status} (${r.units_per_pack} units/pack, ${r.issues.length} issues)`);
    } catch (err) {
      setBuildMsg(`Error: ${(err as Error).message}`);
    } finally { setBuildingId(null); }
  }

  async function handleBuildAllMissing() {
    setAllBuildMsg("Building…");
    try {
      const s = await buildBomForAllMissing();
      setAllBuildMsg(`✓ Built ${s.built}: ${s.complete} complete, ${s.incomplete} incomplete, ${s.errors} errors`);
    } catch (err) {
      setAllBuildMsg(`Error: ${(err as Error).message}`);
    }
  }

  const notBuiltCount = packGtins.filter(g => g.bom_status === "not_built" || g.bom_status === "error").length;

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Pack GTIN Master</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        One GTIN per unique Style + Color + Scale. BOMs map each pack GTIN to child UPCs via Scale Master ratios.
      </p>

      {!companySettings && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          Company Setup must be saved before generating GTINs.{" "}
          <button onClick={() => useGS1Store.getState().setActiveTab("company")} style={{ border: "none", background: "none", color: "#C8210A", cursor: "pointer", fontWeight: 600 }}>
            Go to Company Setup →
          </button>
        </div>
      )}

      {(gtinError || bomBuildError) && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {gtinError || bomBuildError}
        </div>
      )}

      {/* Manual create */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "20px 24px", boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 15, color: TH.textSub }}>Create / Look Up GTIN Manually</h3>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {[
            { label: "Style No", value: manualStyle, set: setManualStyle, placeholder: "e.g. 100227091BK" },
            { label: "Color",    value: manualColor, set: setManualColor, placeholder: "e.g. DRESS BLUES" },
          ].map(f => (
            <div key={f.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>{f.label}</label>
              <input value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.placeholder}
                style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 180 }} required />
            </div>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase" }}>Scale Code</label>
            <div style={{ display: "flex", gap: 6 }}>
              <select value={manualScale} onChange={e => setManualScale(e.target.value)}
                style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
                <option value="">— select —</option>
                {Array.from(KNOWN_SCALE_CODES).sort().map(c => <option key={c}>{c}</option>)}
              </select>
              <input value={manualScale} onChange={e => setManualScale(e.target.value.toUpperCase())} placeholder="custom"
                style={{ padding: "7px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, width: 80 }} />
            </div>
          </div>
          <button type="submit" disabled={creating || !companySettings}
            style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 7, padding: "8px 20px", fontSize: 13, fontWeight: 600, cursor: "pointer", alignSelf: "flex-end" }}>
            {creating ? "Working…" : "Get or Create GTIN"}
          </button>
        </form>
        {manualMsg && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: manualMsg.startsWith("Error") ? "#FFF5F5" : "#F0FFF4", borderRadius: 6, fontSize: 13, color: manualMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>
            {manualMsg}
          </div>
        )}
      </div>

      {/* Search + list */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}` }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 15, color: TH.textSub, flex: 1 }}>GTIN Records ({packGtins.length})</h3>
          {[
            { label: "Style", value: searchStyle, set: setSearchStyle },
            { label: "Color", value: searchColor, set: setSearchColor },
            { label: "Scale", value: searchScale, set: setSearchScale },
          ].map(f => (
            <input key={f.label} value={f.value} onChange={e => f.set(e.target.value)} placeholder={`Filter by ${f.label}…`}
              style={{ padding: "6px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 12, width: 140 }} />
          ))}
          <button onClick={handleSearch} disabled={gtinLoading}
            style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 12, cursor: "pointer" }}>
            {gtinLoading ? "…" : "Search"}
          </button>
          {notBuiltCount > 0 && (
            <button onClick={handleBuildAllMissing} disabled={bomBuilding}
              style={{ background: "#276749", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {bomBuilding ? "Building…" : `Build All Missing BOMs (${notBuiltCount})`}
            </button>
          )}
        </div>

        {allBuildMsg && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: allBuildMsg.startsWith("Error") ? "#FFF5F5" : "#F0FFF4", borderRadius: 6, fontSize: 13, color: allBuildMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>
            {allBuildMsg}
          </div>
        )}
        {buildMsg && (
          <div style={{ marginBottom: 12, padding: "8px 12px", background: buildMsg.startsWith("Error") ? "#FFF5F5" : "#F0FFF4", borderRadius: 6, fontSize: 13, color: buildMsg.startsWith("Error") ? TH.primary : "#276749" }}>
            {buildMsg}
          </div>
        )}

        {gtinLoading
          ? <p style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : packGtins.length === 0
            ? <p style={{ color: TH.textMuted, fontSize: 13 }}>No GTIN records. Upload a packing list or create manually above.</p>
            : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Style No", "Color", "Scale", "Pack GTIN", "Units/Pack", "BOM Status", "Missing UPCs", "Last Built", "Status", "Actions"].map(h => (
                        <th key={h} style={TH_STYLE}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {packGtins.map(g => {
                      const isBuilding = buildingId === g.id;
                      const missingUpcs = (g.bom_issue_summary?.missing_upcs as number | undefined) ?? 0;
                      const lastBuilt = g.bom_last_built_at
                        ? new Date(g.bom_last_built_at).toLocaleDateString()
                        : "—";
                      const hasExistingBom = g.bom_status !== "not_built";
                      return (
                        <tr key={g.id}>
                          <td style={TD_STYLE}>{g.style_no}</td>
                          <td style={TD_STYLE}>{g.color}</td>
                          <td style={{ ...TD_STYLE, fontWeight: 700 }}>{g.scale_code}</td>
                          <td style={{ ...TD_STYLE, fontFamily: "monospace", fontWeight: 600, fontSize: 12, letterSpacing: "0.04em" }}>{g.pack_gtin}</td>
                          <td style={{ ...TD_STYLE, fontWeight: 600 }}>{g.units_per_pack ?? "—"}</td>
                          <td style={TD_STYLE}><BomStatusBadge status={g.bom_status} /></td>
                          <td style={{ ...TD_STYLE, color: missingUpcs > 0 ? TH.primary : TH.textMuted, fontWeight: missingUpcs > 0 ? 700 : 400 }}>
                            {missingUpcs > 0 ? missingUpcs : "—"}
                          </td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted, fontSize: 12 }}>{lastBuilt}</td>
                          <td style={{ ...TD_STYLE, color: g.status === "active" ? "#276749" : TH.textMuted, fontSize: 12 }}>
                            {validateGtin14(g.pack_gtin) ? g.status : "✗ invalid GTIN"}
                          </td>
                          <td style={TD_STYLE}>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                onClick={() => handleBuildBom(g)}
                                disabled={isBuilding || bomBuilding}
                                style={{ background: TH.primary, color: "#fff", border: "none", borderRadius: 5, padding: "3px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                {isBuilding ? "…" : hasExistingBom ? "Rebuild" : "Build BOM"}
                              </button>
                              <button
                                onClick={() => setDrawerGtin(g)}
                                style={{ background: "transparent", border: `1px solid ${TH.border}`, borderRadius: 5, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
                                View
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>

      {drawerGtin && (
        <BomDrawer gtin={drawerGtin} onClose={() => setDrawerGtin(null)} />
      )}
    </div>
  );
}
