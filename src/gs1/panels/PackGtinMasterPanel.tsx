import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import { formatGtin14Display, validateGtin14 } from "../services/gtinService";
import { KNOWN_SCALE_CODES } from "../types";

const TH_STYLE: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: TH.textSub2, background: TH.surfaceHi,
  borderBottom: `1px solid ${TH.border}`, textTransform: "uppercase", letterSpacing: "0.04em",
};
const TD_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13, color: TH.text, borderBottom: `1px solid ${TH.border}` };

export default function PackGtinMasterPanel() {
  const {
    packGtins, gtinLoading, gtinError, companySettings,
    loadPackGtins, loadCompanySettings, generateGtin,
  } = useGS1Store();

  const [searchStyle, setSearchStyle] = useState("");
  const [searchColor, setSearchColor] = useState("");
  const [searchScale, setSearchScale] = useState("");

  // Manual create form
  const [manualStyle, setManualStyle]   = useState("");
  const [manualColor, setManualColor]   = useState("");
  const [manualScale, setManualScale]   = useState("");
  const [manualMsg,   setManualMsg]     = useState("");
  const [creating,    setCreating]      = useState(false);

  useEffect(() => {
    loadPackGtins();
    if (!companySettings) loadCompanySettings();
  }, []);

  async function handleSearch() {
    await loadPackGtins({
      style_no: searchStyle.trim() || undefined,
      color:    searchColor.trim() || undefined,
      scale_code: searchScale.trim() || undefined,
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!manualStyle.trim() || !manualColor.trim() || !manualScale.trim()) return;
    setCreating(true);
    setManualMsg("");
    try {
      const g = await generateGtin(manualStyle.trim().toUpperCase(), manualColor.trim().toUpperCase(), manualScale.trim().toUpperCase());
      setManualMsg(`✓ GTIN ready: ${g.pack_gtin}`);
      setManualStyle(""); setManualColor(""); setManualScale("");
    } catch (err) {
      setManualMsg(`Error: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  const filtered = packGtins; // server-side filtering already applied via loadPackGtins

  return (
    <div style={{ padding: "24px 16px", maxWidth: 1100, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Pack GTIN Master</h2>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        One GTIN per unique Style + Color + Scale combination. GTINs are auto-generated — no manual entry of numbers.
      </p>

      {!companySettings && (
        <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400E" }}>
          Company Setup must be saved before generating GTINs. <button onClick={() => useGS1Store.getState().setActiveTab("company")} style={{ border: "none", background: "none", color: "#C8210A", cursor: "pointer", fontWeight: 600 }}>Go to Company Setup →</button>
        </div>
      )}

      {gtinError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {gtinError}
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
          <div style={{ marginTop: 10, padding: "8px 12px", background: manualMsg.startsWith("Error") ? "#FFF5F5" : "#F0FFF4", borderRadius: 6, fontSize: 13, fontFamily: manualMsg.startsWith("✓") ? "monospace" : "inherit", color: manualMsg.startsWith("Error") ? TH.primary : "#276749", fontWeight: 600 }}>
            {manualMsg}
          </div>
        )}
      </div>

      {/* Search + list */}
      <div style={{ background: TH.surface, borderRadius: 10, padding: "16px 20px", boxShadow: `0 1px 4px ${TH.shadow}` }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, fontSize: 15, color: TH.textSub, flex: 1 }}>GTIN Records ({filtered.length})</h3>
          {[
            { label: "Style", value: searchStyle, set: setSearchStyle },
            { label: "Color", value: searchColor, set: setSearchColor },
            { label: "Scale", value: searchScale, set: setSearchScale },
          ].map(f => (
            <input key={f.label} value={f.value} onChange={e => f.set(e.target.value)} placeholder={`Filter by ${f.label}…`}
              style={{ padding: "6px 10px", border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 12, width: 150 }} />
          ))}
          <button onClick={handleSearch} disabled={gtinLoading}
            style={{ background: TH.header, color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 12, cursor: "pointer" }}>
            {gtinLoading ? "…" : "Search"}
          </button>
        </div>

        {gtinLoading
          ? <p style={{ color: TH.textMuted, fontSize: 13 }}>Loading…</p>
          : filtered.length === 0
            ? <p style={{ color: TH.textMuted, fontSize: 13 }}>No GTIN records. Upload a packing list or create manually above.</p>
            : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Style No", "Color", "Scale", "Pack GTIN", "GTIN Display", "Item Ref", "Units/Pack", "Valid?", "Status"].map(h => <th key={h} style={TH_STYLE}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(g => {
                      const valid = validateGtin14(g.pack_gtin);
                      return (
                        <tr key={g.id}>
                          <td style={TD_STYLE}>{g.style_no}</td>
                          <td style={TD_STYLE}>{g.color}</td>
                          <td style={{ ...TD_STYLE, fontWeight: 700 }}>{g.scale_code}</td>
                          <td style={{ ...TD_STYLE, fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.05em" }}>{g.pack_gtin}</td>
                          <td style={{ ...TD_STYLE, fontFamily: "monospace", fontSize: 12, color: TH.textMuted }}>{formatGtin14Display(g.pack_gtin)}</td>
                          <td style={{ ...TD_STYLE, color: TH.textMuted }}>{g.item_reference}</td>
                          <td style={TD_STYLE}>{g.units_per_pack ?? "—"}</td>
                          <td style={TD_STYLE}>
                            <span style={{ color: valid ? "#276749" : TH.primary, fontWeight: 600, fontSize: 12 }}>
                              {valid ? "✓" : "✗ Invalid"}
                            </span>
                          </td>
                          <td style={{ ...TD_STYLE, color: g.status === "active" ? "#276749" : TH.textMuted, fontSize: 12 }}>
                            {g.status}
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
    </div>
  );
}
