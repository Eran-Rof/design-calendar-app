// QuickAddPrepackMatrix — on-the-fly "add the size breakdown for this prepack"
// popup (operator item 10). Opens from the SO/PO line matrix when a PPK style has
// no Prepack Matrix yet ("No size breakdown is defined…"). The operator enters the
// per-size composition (size → units per pack), saves, and the caller reloads the
// style so the pack now explodes — all without leaving the order window.
//
// POSTs /api/internal/prepack-matrices { name, ppk_style_code, sizes:[{size,qty_per_pack}] }.

import { useState } from "react";

const C = {
  card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };

export interface QuickAddPrepackMatrixProps {
  /** The PPK style_code this matrix is for (links the composition to the style). */
  ppkStyleCode: string;
  /** The pack token (e.g. "PPK24"); its digits are the target pack total, shown as a hint. */
  packToken?: string;
  onClose: () => void;
  onSaved: () => void;
}

type Row = { key: number; size: string; qty: string };

export default function QuickAddPrepackMatrix({ ppkStyleCode, packToken, onClose, onSaved }: QuickAddPrepackMatrixProps) {
  const targetTotal = packToken ? parseInt(packToken.match(/\d+/)?.[0] || "0", 10) || 0 : 0;
  const [name, setName] = useState(`${ppkStyleCode} pack`);
  const [rows, setRows] = useState<Row[]>([{ key: 1, size: "", qty: "" }, { key: 2, size: "", qty: "" }, { key: 3, size: "", qty: "" }]);
  const nextKey = (() => { let k = 4; return () => k++; })();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filled = rows.filter((r) => r.size.trim() && Number(r.qty) > 0);
  const total = filled.reduce((s, r) => s + (Number(r.qty) || 0), 0);

  function setRow(key: number, patch: Partial<Row>) { setRows((p) => p.map((r) => (r.key === key ? { ...r, ...patch } : r))); }
  function addRow() { setRows((p) => [...p, { key: nextKey(), size: "", qty: "" }]); }
  function removeRow(key: number) { setRows((p) => (p.length > 1 ? p.filter((r) => r.key !== key) : p)); }

  async function save() {
    if (!name.trim()) { setErr("Name is required."); return; }
    if (filled.length === 0) { setErr("Add at least one size with a quantity per pack."); return; }
    // Guard against duplicate sizes (the server keys the composition by size).
    const seen = new Set<string>();
    for (const r of filled) { const sz = r.size.trim().toUpperCase(); if (seen.has(sz)) { setErr(`Size "${r.size.trim()}" is listed twice.`); return; } seen.add(sz); }
    setSaving(true); setErr(null);
    try {
      const body = {
        name: name.trim(),
        ppk_style_code: ppkStyleCode,
        sizes: filled.map((r) => ({ size: r.size.trim(), qty_per_pack: Number(r.qty) })),
      };
      const r = await fetch("/api/internal/prepack-matrices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { e.stopPropagation(); if (!saving) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <div style={{ padding: 20, paddingBottom: 12 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>Add prepack matrix</h3>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
            Size breakdown for <b style={{ color: C.textSub }}>{ppkStyleCode}</b> — units per pack by size. The pack then explodes into eaches everywhere (inventory, allocation, reporting).
            {targetTotal > 0 && <> One <b>{packToken}</b> pack should total <b>{targetTotal}</b> units.</>}
          </div>

          <label style={{ display: "block", marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Name *</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={saving} style={{ ...inputStyle, borderColor: !name.trim() ? C.danger : C.cardBdr }} />
          </label>

          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Composition (size → units / pack)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((r) => (
              <div key={r.key} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
                <input value={r.size} onChange={(e) => setRow(r.key, { size: e.target.value })} disabled={saving} style={inputStyle} placeholder="size (e.g. S, 32)" />
                <input type="text" inputMode="numeric" value={r.qty} onChange={(e) => { if (/^\d*$/.test(e.target.value)) setRow(r.key, { qty: e.target.value }); }} disabled={saving} style={inputStyle} placeholder="units / pack" />
                <button type="button" onClick={() => removeRow(r.key)} disabled={saving || rows.length <= 1} style={{ ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "6px 10px" }} title="Remove size">✕</button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
            <button type="button" onClick={addRow} disabled={saving} style={{ ...btnSecondary, color: C.primary, borderColor: C.primary, padding: "6px 10px", fontSize: 12 }}>+ Add size</button>
            <span style={{ fontSize: 12, color: targetTotal > 0 && total !== targetTotal ? C.warn : C.textMuted }}>
              Pack total: <b style={{ color: targetTotal > 0 && total !== targetTotal ? C.warn : C.success }}>{total}</b>{targetTotal > 0 ? ` / ${targetTotal}` : ""}
            </span>
          </div>

          {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </div>

        <div style={{ position: "sticky", bottom: 0, background: C.card, borderTop: `1px solid ${C.cardBdr}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving || !name.trim() || filled.length === 0} style={{ ...btnPrimary, opacity: saving || !name.trim() || filled.length === 0 ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Add matrix"}
          </button>
        </div>
      </div>
    </div>
  );
}
