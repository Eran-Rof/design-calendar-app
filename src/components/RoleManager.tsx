import React, { useState } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";

function RoleManager({ roles, setRoles, isAdmin = false }: {
  roles: string[];
  setRoles: (fn: any) => void;
  isAdmin?: boolean;
}) {
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState("");
  if (!isAdmin) return (
    <div style={{ padding: "20px", textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 600, color: TH.text, marginBottom: 4 }}>Admin Only</div>
      <div>Only admins can manage this section.</div>
    </div>
  );

  function save() {
    const val = form.trim();
    if (!val) return;
    if (editing === "new") {
      if (roles.includes(val)) return;
      setRoles((s: string[]) => [...s, val]);
    } else {
      setRoles((s: string[]) => s.map((x: string, i: number) => (i === editing ? val : x)));
    }
    setEditing(null);
    setForm("");
  }

  if (editing !== null)
    return (
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: TH.text, marginBottom: 20 }}>
          {editing === "new" ? "Add Role" : "Edit Role"}
        </div>
        <label style={S.lbl}>Role Name</label>
        <input
          style={S.inp}
          value={form}
          onChange={(e) => setForm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="e.g. Product Developer"
          autoFocus
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => { setEditing(null); setForm(""); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button disabled={!form.trim()} onClick={save} style={{ ...S.btn, opacity: form.trim() ? 1 : 0.5 }}>Save Role</button>
        </div>
      </div>
    );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Roles ({roles.length})</span>
        <button onClick={() => { setForm(""); setEditing("new"); }} style={S.btn}>+ Add Role</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {roles.map((role: string, i: number) => (
          <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: TH.text }}>🎭 {role}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm(role); setEditing(i); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => appConfirm("You are about to delete this role. This action cannot be undone.", "Delete", () => setRoles((arr: string[]) => arr.filter((_: any, j: number) => j !== i)))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {roles.length === 0 && <div style={{ textAlign: "center", color: TH.textMuted, padding: "24px", fontSize: 13, border: `1px dashed ${TH.border}`, borderRadius: 10 }}>No roles yet.</div>}
    </div>
  );
}

export default RoleManager;
