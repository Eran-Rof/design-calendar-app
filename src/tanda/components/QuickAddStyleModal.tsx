// QuickAddStyleModal — add a style on the fly from the Build Order screen
// (operator item 1). A build's finished item is a specific VARIANT SKU
// (style + colour + size), so this creates the Style Master record — assigning a
// proper SIZE SCALE — plus a finished-goods SKU (ip_item_master, via resolve-sku)
// for the size you'll build, then hands the SKU back. The style still needs an
// active BOM before it can be Released (Master Data → BOM).
//
// Admin-only: the caller gates opening this; it also expects to be opened by an admin.

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "./SearchableSelect";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const lbl: React.CSSProperties = { fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 };

type SizeScale = { id: string; code: string; name: string; sizes: string[] };

export interface QuickAddStyleModalProps {
  onClose: () => void;
  /** Called with the newly-minted finished-goods SKU id + a display label, plus
   *  the new style's id and code (so callers that key on the STYLE, e.g. the
   *  manufacturing build/BOM, can use it directly). */
  onCreated: (skuId: string, label: string, styleId?: string, styleCode?: string) => void;
}

export default function QuickAddStyleModal({ onClose, onCreated }: QuickAddStyleModalProps) {
  const [styleCode, setStyleCode] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [scales, setScales] = useState<SizeScale[]>([]);
  const [scaleId, setScaleId] = useState("");
  const [buildSize, setBuildSize] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/size-scales").then((r) => (r.ok ? r.json() : []))
      .then((a) => { if (Array.isArray(a)) setScales(a as SizeScale[]); })
      .catch(() => {});
  }, []);

  const scale = useMemo(() => scales.find((s) => s.id === scaleId) || null, [scales, scaleId]);
  // When the scale changes, default the build-size to the scale's first size.
  useEffect(() => { setBuildSize(scale?.sizes?.[0] || ""); }, [scaleId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const code = styleCode.trim();
    if (!code) { setErr("Style code is required."); return; }
    if (!scaleId) { setErr("Pick a size scale."); return; }
    if (!buildSize.trim()) { setErr("Pick which size to build."); return; }
    setSaving(true); setErr(null);
    try {
      // 1) Create the Style Master record with its size scale.
      const sr = await fetch("/api/internal/style-master", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style_code: code, description: description.trim() || undefined, size_scale_id: scaleId }),
      });
      const sj = await sr.json().catch(() => ({}));
      if (!sr.ok) throw new Error(sj.error || `Style create failed (HTTP ${sr.status})`);
      const styleId = sj.id as string;

      // 2) Mint the finished-goods SKU for the size you'll build (from the scale).
      const kr = await fetch("/api/internal/style-matrix/resolve-sku", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style_id: styleId, style_code: code, color: color.trim() || null, size: buildSize.trim() }),
      });
      const kj = await kr.json().catch(() => ({}));
      if (!kr.ok || !kj.id) throw new Error(kj.error || `SKU create failed (HTTP ${kr.status})`);

      const label = `${code}${color.trim() ? `-${color.trim()}` : ""}-${buildSize.trim()}${description.trim() ? ` — ${description.trim()}` : ""}`;
      onCreated(kj.id as string, label, styleId, code);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div onClick={(e) => { e.stopPropagation(); if (!saving) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(540px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <div style={{ padding: 20, paddingBottom: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Add a style to build</h3>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
            Creates the Style Master record (with its size scale) + a finished-goods SKU for the size you'll build. The style still needs an active <b>BOM</b> (Master Data → BOM) before you can Release.
          </div>

          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={lbl}>Style code *</div>
            <input autoFocus value={styleCode} onChange={(e) => setStyleCode(e.target.value)} disabled={saving} style={{ ...inputStyle, borderColor: !styleCode.trim() ? C.danger : C.cardBdr }} placeholder="e.g. RYB0999" />
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={lbl}>Description</div>
            <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
          </label>

          <div style={{ marginBottom: 12 }}>
            <div style={lbl}>Size scale *</div>
            <SearchableSelect
              value={scaleId || null}
              onChange={(v) => setScaleId(v || "")}
              options={scales.map((s) => ({ value: s.id, label: `${s.name} (${s.sizes.length} sizes)`, searchHaystack: `${s.code} ${s.name} ${s.sizes.join(" ")}` }))}
              placeholder="Search size scale…"
              emptyText="No size scales — add some in Master Data → Size Scales"
              inputStyle={inputStyle}
            />
            {scale && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Sizes: {scale.sizes.join(", ")}</div>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              <div style={lbl}>Colour</div>
              <input value={color} onChange={(e) => setColor(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
            </label>
            <div>
              <div style={lbl}>Size to build *</div>
              <SearchableSelect
                value={buildSize || null}
                onChange={(v) => setBuildSize(v || "")}
                options={(scale?.sizes || []).map((s) => ({ value: s, label: s }))}
                placeholder={scale ? "Pick a size" : "Pick a scale first"}
                emptyText="Pick a size scale first"
                inputStyle={inputStyle}
              />
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>The scale is set on the style; only the chosen size's SKU is minted now — build other sizes later from the scale.</div>

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </div>

        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving || !styleCode.trim() || !scaleId || !buildSize.trim()} style={{ ...btnPrimary, opacity: saving || !styleCode.trim() || !scaleId || !buildSize.trim() ? 0.6 : 1 }}>
            {saving ? "Creating…" : "Create & select"}
          </button>
        </div>
      </div>
    </div>
  );
}
