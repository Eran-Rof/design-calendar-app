import React, { useState, useRef } from "react";
import { sha256, isHashed } from "../utils/hash";
import { TH } from "../utils/theme";
import { appConfirm } from "../utils/theme";
import { S } from "../utils/styles";
import { uid } from "../utils/dates";
import { ROLES } from "../utils/constants";
import { fileToDataURL } from "../utils/helpers";
import Avatar from "./Avatar";

function UserManager({ users, setUsers, team, setTeam, isAdmin, currentUser, roles = ROLES, setRoles }: {
  users: any[];
  setUsers: (fn: any) => void;
  team: any[];
  setTeam: (fn: any) => void;
  isAdmin: boolean;
  currentUser: any;
  roles?: string[];
  setRoles?: (fn: any) => void;
}) {
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [createTeamMember, setCreateTeamMember] = useState(false);
  const [tmRole, setTmRole] = useState((roles || ROLES)[0]);
  const [tmColor, setTmColor] = useState("#3498DB");
  const [newRoleInput, setNewRoleInput] = useState("");
  const availableRoles = roles || ROLES;
  const setAvailableRoles = setRoles || (() => {});
  const TEAM_COLORS = ["#E74C3C","#3498DB","#2ECC71","#9B59B6","#F39C12","#1ABC9C","#E67E22","#E91E63","#00BCD4","#8BC34A"];
  const BLANK = () => ({ id: uid(), username: "", password: "", name: "", role: "user", color: "#3498DB", initials: "", avatar: null, teamMemberId: null, teamsEmail: "", permissions: { view_all: false, edit_all: false, view_own: true, edit_own: true } });
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const setPerm = (k: string, v: any) => setForm((f: any) => ({ ...f, permissions: { ...f.permissions, [k]: v } }));
  const userAvatarRef = useRef<HTMLInputElement>(null);
  async function handleUserAvatar(e: React.ChangeEvent<HTMLInputElement>) { const f = e.target.files?.[0]; if (!f) return; set("avatar", await fileToDataURL(f)); }

  async function save() {
    const initials = form.name.split(" ").map((w: string) => w[0] || "").join("").toUpperCase().slice(0, 2);
    let teamMemberId = form.teamMemberId;
    if (editing === "new" && createTeamMember) {
      const newMember = { id: uid(), name: form.name, role: tmRole, initials, color: tmColor, avatar: form.avatar || null };
      setTeam((t: any[]) => [...t, newMember]);
      teamMemberId = newMember.id;
    } else if (teamMemberId) {
      // Sync linked team member: update name, initials, avatar, color
      setTeam((t: any[]) => t.map((m: any) => {
        if (m.id !== teamMemberId) return m;
        return { ...m, name: form.name, initials, avatar: form.avatar ?? m.avatar, color: form.color };
      }));
    }
    // Hash password: if blank on edit keep existing; if new/changed and not already hashed, hash it
    let password = form.password;
    if (!password && editing !== "new") {
      const existing = users.find((u: any) => u.id === editing);
      password = existing?.password ?? "";
    } else if (password && !isHashed(password)) {
      password = await sha256(password);
    }
    const u = { ...form, password, initials, teamMemberId };
    if (editing === "new") setUsers((us: any[]) => [...us, u]);
    else setUsers((us: any[]) => us.map((x: any) => (x.id === editing ? u : x)));
    setEditing(null); setForm(null); setCreateTeamMember(false); setTmRole(ROLES[0]); setTmColor("#3498DB");
  }

  function addRoleOnTheFly() {
    const trimmed = newRoleInput.trim();
    if (!trimmed || availableRoles.includes(trimmed)) return;
    setAvailableRoles((r: string[]) => [...r, trimmed]);
    setTmRole(trimmed);
    setNewRoleInput("");
  }

  if (!isAdmin) return (
    <div style={{ padding: 32, textAlign: "center", color: TH.textMuted }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: TH.textSub }}>Admin access required</div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Only admins can manage users.</div>
    </div>
  );

  if (editing) return (
    <div>
      <label style={S.lbl}>Full Name</label>
      <input style={S.inp} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Full name" />
      <label style={S.lbl}>Avatar</label>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 14 }}>
        <Avatar member={form} size={52} />
        <div>
          <input ref={userAvatarRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleUserAvatar} />
          <button onClick={() => userAvatarRef.current?.click()} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12, marginBottom: 6, display: "block" }}>Upload Photo</button>
          {form.avatar && <button onClick={() => set("avatar", null)} style={{ padding: "4px 10px", borderRadius: 6, border: "none", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>Remove</button>}
        </div>
      </div>
      <label style={S.lbl}>Color</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {TEAM_COLORS.map((c) => <div key={c} onClick={() => set("color", c)} style={{ width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${form.color === c ? "#1A202C" : "transparent"}` }} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <label style={S.lbl}>Username</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="username" />
        </div>
        <div>
          <label style={S.lbl}>Password</label>
          <input style={{ ...S.inp, marginBottom: 0 }} value={form.password} onChange={(e) => set("password", e.target.value)} placeholder={editing === "new" ? "password" : "Leave blank to keep current"} />
        </div>
      </div>
      <div style={{ height: 14 }} />
      <label style={S.lbl}>Microsoft Teams Email</label>
      <input style={S.inp} value={form.teamsEmail || ""} onChange={(e) => set("teamsEmail", e.target.value)} placeholder="user@ringoffireclothing.com (optional — enables auto Teams login)" />
      <label style={S.lbl}>System Role</label>
      <select style={S.inp} value={form.role} onChange={(e) => set("role", e.target.value)}>
        <option value="admin">Admin (full access)</option>
        <option value="user">User (restricted)</option>
      </select>
      {editing === "new" && (
        <div style={{ border: `1px solid ${createTeamMember ? TH.primary : TH.border}`, borderRadius: 10, padding: "12px 14px", marginBottom: 14, background: createTeamMember ? TH.accent : TH.surfaceHi, transition: "all 0.15s" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: createTeamMember ? 14 : 0 }}>
            <input type="checkbox" checked={createTeamMember} onChange={(e) => setCreateTeamMember(e.target.checked)} style={{ accentColor: TH.primary, width: 16, height: 16 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: TH.textSub }}>Also create as Team Member</span>
          </label>
          {createTeamMember && (
            <div>
              <label style={S.lbl}>Team Role</label>
              <select style={{ ...S.inp, marginBottom: 12 }} value={tmRole} onChange={(e) => setTmRole(e.target.value)}>
                {availableRoles.map((r) => <option key={r}>{r}</option>)}
              </select>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <input style={{ ...S.inp, marginBottom: 0, flex: 1 }} value={newRoleInput} onChange={(e) => setNewRoleInput(e.target.value)} placeholder="Add new role…" onKeyDown={(e) => e.key === "Enter" && addRoleOnTheFly()} />
                <button onClick={addRoleOnTheFly} disabled={!newRoleInput.trim()} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${TH.border}`, background: TH.primary, color: "#fff", cursor: newRoleInput.trim() ? "pointer" : "not-allowed", fontFamily: "inherit", fontSize: 12, fontWeight: 700, opacity: newRoleInput.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}>+ Add Role</button>
              </div>
              <label style={S.lbl}>Member Color</label>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 4 }}>
                {TEAM_COLORS.map((c) => <div key={c} onClick={() => setTmColor(c)} style={{ width: 26, height: 26, borderRadius: "50%", background: c, cursor: "pointer", border: `3px solid ${tmColor === c ? "#1A202C" : "transparent"}` }} />)}
              </div>
            </div>
          )}
        </div>
      )}
      {!(editing === "new" && createTeamMember) && (
        <>
          <label style={S.lbl}>Link to Team Member</label>
          <select style={S.inp} value={form.teamMemberId || ""} onChange={(e) => set("teamMemberId", e.target.value || null)}>
            <option value="">-- None --</option>
            {team.map((m: any) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
          </select>
        </>
      )}
      {form.role === "user" && (
        <>
          <label style={S.lbl}>Permissions</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {([["view_all","View All Collections"],["edit_all","Edit All Tasks"],["view_own","View Own Tasks Only"],["edit_own","Edit Own Tasks"],["view_all_activity","View All Activity"]] as [string, string][]).map(([k, label]) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: TH.surfaceHi, borderRadius: 8, cursor: "pointer", border: `1px solid ${form.permissions?.[k] ? TH.primary : TH.border}` }}>
                <input type="checkbox" checked={!!form.permissions?.[k]} onChange={(e) => setPerm(k, e.target.checked)} style={{ accentColor: TH.primary }} />
                <span style={{ fontSize: 12, color: TH.textSub }}>{label}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button onClick={() => { setEditing(null); setForm(null); setCreateTeamMember(false); }} style={{ padding: "9px 18px", borderRadius: 8, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        <button disabled={!form.name || !form.username} onClick={save} style={{ ...S.btn, opacity: form.name && form.username ? 1 : 0.5 }}>Save User</button>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={S.sec}>Users ({users.length})</span>
        <button onClick={() => { setForm(BLANK()); setEditing("new"); setCreateTeamMember(false); }} style={S.btn}>+ Add User</button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {users.map((u: any) => (
          <div key={u.id} style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
            <Avatar member={{ ...u, initials: u.initials || u.name?.[0]?.toUpperCase() }} size={40} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: TH.text }}>{u.name}</div>
              <div style={{ fontSize: 12, color: TH.textMuted }}>
                @{u.username} · <span style={{ color: u.role === "admin" ? TH.primary : "#6D28D9", fontWeight: 600 }}>{u.role}</span>
                {u.teamMemberId && <span style={{ color: "#059669", marginLeft: 6 }}>· 👥 team member</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setForm({ ...u, password: "", permissions: u.permissions || { view_own: true, edit_own: true } }); setEditing(u.id); }} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Edit</button>
              <button onClick={() => appConfirm("You are about to remove this user. This action cannot be undone.", "Remove", () => setUsers((us: any[]) => us.filter((x: any) => x.id !== u.id)))} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid #FCA5A5", background: "none", color: "#B91C1C", cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default UserManager;
