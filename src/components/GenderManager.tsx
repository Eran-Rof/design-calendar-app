import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { DEFAULT_SIZES } from "../utils/constants";

function GenderManager({ genders, setGenders, genderSizes, setGenderSizes, sizes = [], setSizes, isAdmin = false }: {
  genders: string[];
  setGenders: (fn: any) => void;
  genderSizes: Record<string, string[]>;
  setGenderSizes: (fn: any) => void;
  sizes?: string[];
  setSizes?: (fn: any) => void;
  isAdmin?: boolean;
}) {
  const [editing, setEditing] = useState<any>(null); // null | "new" | index
  const [form, setForm] = useState("");
  const [selSizes, setSelSizes] = useState<string[]>([]);
  const [newSizeInput, setNewSizeInput] = useState("");

  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );

  // All available sizes: sizeLibrary if populated, else DEFAULT_SIZES
  const allSizes = sizes && sizes.length > 0 ? sizes : DEFAULT_SIZES;

  function openNew() { setForm(""); setSelSizes([]); setNewSizeInput(""); setEditing("new"); }
  function openEdit(i: number) {
    const g = genders[i];
    setForm(g);
    setSelSizes(genderSizes[g] || []);
    setNewSizeInput("");
    setEditing(i);
  }

  function save() {
    const val = form.trim();
    if (!val) return;
    if (editing === "new") {
      if (genders.includes(val)) return;
      setGenders((s: string[]) => [...s, val]);
    } else {
      const oldLabel = genders[editing];
      setGenders((s: string[]) => s.map((x: string, i: number) => (i === editing ? val : x)));
      // If label changed, migrate sizes key
      if (oldLabel !== val) {
        setGenderSizes((gs: Record<string, string[]>) => {
          const updated = { ...gs, [val]: selSizes };
          delete updated[oldLabel];
          return updated;
        });
        setEditing(null); setForm(""); setSelSizes([]); setNewSizeInput("");
        return;
      }
    }
    setGenderSizes((gs: Record<string, string[]>) => ({ ...gs, [val]: selSizes }));
    setEditing(null); setForm(""); setSelSizes([]); setNewSizeInput("");
  }

  function toggleSize(sz: string) {
    setSelSizes((s: string[]) => s.includes(sz) ? s.filter(x => x !== sz) : [...s, sz]);
  }

  function addNewSize() {
    const s = newSizeInput.trim().toUpperCase();
    if (!s) return;
    // Add to global size library if not already there
    if (setSizes && !allSizes.includes(s)) {
      setSizes((prev: string[]) => [...prev, s]);
    }
    // Auto-select it for this gender
    if (!selSizes.includes(s)) setSelSizes(prev => [...prev, s]);
    setNewSizeInput("");
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Gender" : "Edit Gender"}
        </div>
        <label style={S.lbl}>Gender Label</label>
        <input
          style={S.inp}
          value={form}
          onChange={(e) => setForm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="e.g. Men's"
          autoFocus
        />
        <label style={{ ...S.lbl, marginTop: 12 }}>Default Sizes for this Gender</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {allSizes.map(sz => (
            <button key={sz} onClick={() => toggleSize(sz)}
              style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${selSizes.includes(sz) ? TH.primary : TH.border}`, background: selSizes.includes(sz) ? TH.primary : "none", color: selSizes.includes(sz) ? "#fff" : TH.textSub, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600 }}>
              {sz}
            </button>
          ))}
        </div>
        {/* Add a new size — syncs to Size Library */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <input
            style={{ ...S.inp, marginBottom: 0, flex: 1 }}
            placeholder="Add new size (e.g. 4XL)"
            value={newSizeInput}
            onChange={(e) => setNewSizeInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addNewSize()}
          />
          <button onClick={addNewSize} style={{ ...S.btn, whiteSpace: "nowrap" }}>+ Add Size</button>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm(""); setSelSizes([]); setNewSizeInput(""); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={!form.trim()} onClick={save} style={{ ...S.btn, opacity: form.trim() ? 1 : 0.5 }}>Save Gender</button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Genders ({genders.length})</span>
        <button onClick={openNew} style={S.btn}>+ Add Gender</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {genders.map((g: string, i: number) => {
          const gSizes = genderSizes[g] || [];
          return (
            <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: TH.text, marginBottom: 4 }}>⚧ {g}</div>
                {gSizes.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {gSizes.map(sz => (
                      <span key={sz} style={{ fontSize: 10, padding: "1px 6px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 4, color: TH.textMuted }}>{sz}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => openEdit(i)} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
                <button onClick={() => appConfirm("Delete this gender option?", "Delete", () => { setGenders((arr: string[]) => arr.filter((_: any, j: number) => j !== i)); setGenderSizes((gs: Record<string, string[]>) => { const u = { ...gs }; delete u[g]; return u; }); })} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>
      {genders.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No genders defined.</div>}
    </div>
  );
}

export default GenderManager;
