// QuickAddStyleModal — add a style on the fly from the Build Order screen
// (operator item 1). A build's finished item is a specific VARIANT SKU
// (style + colour + size), so to produce something the build can actually select
// this creates BOTH the Style Master record AND a finished-goods SKU
// (ip_item_master, via resolve-sku) and hands the SKU back. The style still needs
// an active BOM before it can be Released — that's set up in Master Data → BOM.
//
// Admin-only: the caller gates opening this; it also expects to be opened by an admin.

import { useState } from "react";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const lbl: React.CSSProperties = { fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 };

export interface QuickAddStyleModalProps {
  onClose: () => void;
  /** Called with the newly-minted finished-goods SKU id + a display label. */
  onCreated: (skuId: string, label: string) => void;
}

export default function QuickAddStyleModal({ onClose, onCreated }: QuickAddStyleModalProps) {
  const [styleCode, setStyleCode] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("");
  const [size, setSize] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    const code = styleCode.trim();
    if (!code) { setErr("Style code is required."); return; }
    if (!size.trim()) { setErr("Size is required — a buildable finished good is a sized SKU."); return; }
    setSaving(true); setErr(null);
    try {
      // 1) Create the Style Master record.
      const sr = await fetch("/api/internal/style-master", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style_code: code, description: description.trim() || undefined }),
      });
      const sj = await sr.json().catch(() => ({}));
      if (!sr.ok) throw new Error(sj.error || `Style create failed (HTTP ${sr.status})`);
      const styleId = sj.id as string;

      // 2) Mint the finished-goods SKU (ip_item_master) so the build can select it.
      const kr = await fetch("/api/internal/style-matrix/resolve-sku", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style_id: styleId, style_code: code, color: color.trim() || null, size: size.trim() }),
      });
      const kj = await kr.json().catch(() => ({}));
      if (!kr.ok || !kj.id) throw new Error(kj.error || `SKU create failed (HTTP ${kr.status})`);

      const label = `${code}${color.trim() ? `-${color.trim()}` : ""}-${size.trim()}${description.trim() ? ` — ${description.trim()}` : ""}`;
      onCreated(kj.id as string, label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div onClick={(e) => { e.stopPropagation(); if (!saving) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <div style={{ padding: 20, paddingBottom: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Add a style to build</h3>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
            Creates the Style Master record + a finished-goods SKU you can build. The style still needs an active <b>BOM</b> (Master Data → BOM) before you can Release the build.
          </div>

          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={lbl}>Style code *</div>
            <input autoFocus value={styleCode} onChange={(e) => setStyleCode(e.target.value)} disabled={saving} style={{ ...inputStyle, borderColor: !styleCode.trim() ? C.danger : C.cardBdr }} placeholder="e.g. RYB0999" />
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <div style={lbl}>Description</div>
            <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              <div style={lbl}>Colour</div>
              <input value={color} onChange={(e) => setColor(e.target.value)} disabled={saving} style={inputStyle} placeholder="optional" />
            </label>
            <label>
              <div style={lbl}>Size *</div>
              <input value={size} onChange={(e) => setSize(e.target.value)} disabled={saving} style={{ ...inputStyle, borderColor: !size.trim() ? C.danger : C.cardBdr }} placeholder="e.g. SML / M / OS" />
            </label>
          </div>

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </div>

        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving || !styleCode.trim() || !size.trim()} style={{ ...btnPrimary, opacity: saving || !styleCode.trim() || !size.trim() ? 0.6 : 1 }}>
            {saving ? "Creating…" : "Create & select"}
          </button>
        </div>
      </div>
    </div>
  );
}
