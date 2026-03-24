import React, { useState, useRef } from "react";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { uid } from "../utils/dates";
import { ROLES } from "../utils/constants";
import { fileToDataURL } from "../utils/helpers";
import Avatar from "./Avatar";

function TeamManager({ team, setTeam, users, setUsers, isAdmin, roles = ROLES, setRoles }: {
  team: any[];
  setTeam: (fn: any) => void;
  users?: any[];
  setUsers?: (fn: any) => void;
  isAdmin: boolean;
  roles?: string[];
  setRoles?: (fn: any) => void;
}) {
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [availableRoles, setAvailableRoles] = useState([...ROLES]);
  const [newRoleInput, setNewRoleInput] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const COLORS = ["#E74C3C","#3498DB","#2ECC71","#9B59B6","#F39C12","#1ABC9C","#E67E22","#E91E63","#00BCD4","#8BC34A"];

  function openNew() { setForm({ id: uid(), name: "", role: availableRoles[0] || ROLES[0], initials: "", color: "#E74C3C", avatar: null }); setEditing("new"); }
  function openEdit(m: any) { setForm({ ...m }); setEditing(m.id); }
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function handleAvatar(e: React.ChangeEvent<HTMLInputElement>) { const f = e.target.files?.[0]; if (!f) return; set("avatar", await fileToDataURL(f)); }
  function save() {
    if (editing === "new") {
      setTeam((t: any[]) => [...t, form]);
    } else {
      setTeam((t: any[]) => t.map((m: any) => (m.id === editing ? form : m)));
      // Sync linked user: update name, initials, avatar, color
      if (setUsers) {
        setUsers((us: any[]) => us.map((u: any) => {
          if (u.teamMemberId !== editing) return u;
          return { ...u, name: form.name, initials: form.initials, avatar: form.avatar ?? u.avatar, color: form.color };
        }));
      }
    }
    setEditing(null); setForm(null); setNewRoleInput("");
  }
  function addRoleOnTheFly() {
    const trimmed = newRoleInput.trim();
    if (!trimmed || availableRoles.includes(trimmed)) return;
    setAvailableRoles((r: string[]) => [...r, trimmed]);
    set("role", trimmed);
    setNewRoleInput("");
  }

  if (!isAdmin) return (
    <div style={{ padding: 32, textAlign: "center", color: TH.textMuted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub }}>Admin access required</div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Only admins can manage team members.</div>
    </div>
  );

  if (editing) return (
    <div>
      <label style={S.lbl}>Name</label>
      <input style={S.inp} value={form.name} onChange={(e) => { set("name", e.target.value); set("initials", e.target.value.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2)); }} placeholder="Full name" />
      <label style={S.lbl}>Role</label>
      <select style={S.inp} value={form.role} onChange={(e) => set("role", e.target.value)}>
        {availableRoles.map((r) => <option key={r}>{r}</option>)}
      </select>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input style={{ ...S.inp, marginBottom: 0, flex: 1 }} value={newRoleInput} onChange={(e) => setNewRoleInput(e.target.value)} placeholder="Add new role…" onKeyDown={(e) => e.key === "Enter" && addRoleOnTheFly()} />
        <button onClick={addRoleOnTheFly} disabled={!newRoleInput.trim()} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: TH.primary, color: "#fff", cursor: newRoleInput.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: 12, fontWeight: 700, opacity: newRoleInput.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}>+ Add Role</button>
      </div>
      <label style={S.lbl}>Avatar</label>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <Avatar member={form} size={52} />
        <div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatar} />
          <button onClick={() => fileRef.current?.click()} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginBottom: 8, display: "block" }}>Upload Photo</button>
          {form.avatar && <button onClick={() => set("avatar", null)} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>Remove</button>}
        </div>
      </div>
      <label style={S.lbl}>Color</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {COLORS.map((c) => <div key={c} onClick={() => set("color", c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${form.color === c ? "#1A202C" : "transparent"}` }} />)}
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={() => { setEditing(null); setForm(null); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!form.name} onClick={save} style={{ ...S.btn, opacity: form.name ? 1 : 0.4 }}>Save</button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Team Members ({team.length})</span>
        <button onClick={openNew} style={S.btn}>+ Add Member</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {team.map((m: any) => (
          <div key={m.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <Avatar member={m} size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{m.name}</div>
              <div style={{ fontSize: 12, color: m.color }}>{m.role}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => openEdit(m)} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => appConfirm("You are about to remove this team member. This action cannot be undone.", "Remove", () => setTeam((t: any[]) => t.filter((x: any) => x.id !== m.id)))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default TeamManager;
