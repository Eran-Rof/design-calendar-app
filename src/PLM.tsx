import { useState, useEffect } from "react";

// ── Supabase ──────────────────────────────────────────────────────────────────
const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";
const SB_HEADERS = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

// ── Session storage key ───────────────────────────────────────────────────────
const SESSION_KEY = "plm_user";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AppPermission {
  access: boolean;        // can access the app at all
  readOnly: boolean;      // true = read only, false = read/write
  seeOthersData: boolean; // can see other users' data
}

interface User {
  id: string;
  username: string;
  name?: string;
  password: string;
  role: "admin" | "user";
  color?: string;
  initials?: string;
  permissions?: {
    design?: AppPermission;
    tanda?: AppPermission;
    techpack?: AppPermission;
  };
}

const DEFAULT_PERMISSION: AppPermission = { access: true, readOnly: false, seeOthersData: false };
const ADMIN_PERMISSION: AppPermission   = { access: true, readOnly: false, seeOthersData: true  };

function getPermission(user: User, app: "design" | "tanda" | "techpack"): AppPermission {
  if (user.role === "admin") return ADMIN_PERMISSION;
  return user.permissions?.[app] ?? DEFAULT_PERMISSION;
}

// ── Load users from Supabase app_data ─────────────────────────────────────────
async function loadUsers(): Promise<User[]> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.users&select=value`, { headers: SB_HEADERS });
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
      return JSON.parse(rows[0].value);
    }
  } catch {}
  return [];
}

// ── App definitions ───────────────────────────────────────────────────────────
const APPS = [
  {
    id: "design" as const,
    name: "Design Calendar",
    description: "Seasonal design workflow, task tracking and vendor milestones",
    icon: "🎨",
    color: "#CC2200",
    path: "/design",
  },
  {
    id: "tanda" as const,
    name: "Purchase Orders",
    description: "PO tracking, Xoro sync and delivery management",
    icon: "📋",
    color: "#3B82F6",
    path: "/tanda",
  },
  {
    id: "techpack" as const,
    name: "Tech Packs",
    description: "Coming soon — technical specifications and garment details",
    icon: "📐",
    color: "#8B5CF6",
    path: "/techpack",
    comingSoon: true,
  },
];

// ── Main PLM Launcher ─────────────────────────────────────────────────────────
export default function PLMApp() {
  const [user, setUser]           = useState<User | null>(null);
  const [loginName, setLoginName] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [showPass, setShowPass]   = useState(false);
  const [loginErr, setLoginErr]   = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  // Restore session
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) setUser(JSON.parse(saved));
    } catch {}
  }, []);

  async function handleLogin() {
    setLoginErr("");
    setLoggingIn(true);
    try {
      const users = await loadUsers();
      if (!users.length) {
        setLoginErr("No users found. Please contact your admin.");
        return;
      }
      const match = users.find(u =>
        u.username?.toLowerCase() === loginName.trim().toLowerCase() &&
        (u.password === loginPass || (u as any).pin === loginPass)
      );
      if (match) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(match));
        setUser(match);
      } else {
        setLoginErr("Invalid username or password.");
      }
    } catch {
      setLoginErr("Could not connect. Please try again.");
    } finally {
      setLoggingIn(false);
    }
  }

  function handleSignOut() {
    sessionStorage.removeItem(SESSION_KEY);
    setUser(null);
    setLoginName("");
    setLoginPass("");
  }

  function openApp(path: string) {
    window.location.href = path;
  }

  // ── LOGIN SCREEN ────────────────────────────────────────────────────────────
  if (!user) return (
    <div style={S.bg}>
      <div style={S.loginWrap}>
        {/* Logo */}
        <div style={S.logoCircle}>
          <span style={S.logoText}>ROF</span>
        </div>
        <h1 style={S.title}>Ring of Fire PLM</h1>
        <p style={S.subtitle}>Product Lifecycle Management</p>

        <div style={S.card}>
          <input style={S.input} placeholder="Username"
            value={loginName} onChange={e => setLoginName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()} autoFocus />

          <div style={{ position: "relative" }}>
            <input style={{ ...S.input, paddingRight: 40 }}
              placeholder="Password"
              type={showPass ? "text" : "password"}
              value={loginPass} onChange={e => setLoginPass(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLogin()} />
            <button onClick={() => setShowPass(p => !p)} style={S.eyeBtn}>
              {showPass ? "🙈" : "👁"}
            </button>
          </div>

          {loginErr && <p style={S.err}>{loginErr}</p>}

          <button style={{ ...S.btnPrimary, opacity: loggingIn ? 0.7 : 1 }}
            onClick={handleLogin} disabled={loggingIn}>
            {loggingIn ? "Signing in…" : "Sign In"}
          </button>
        </div>

        <p style={{ color: "#4B5563", fontSize: 12, marginTop: 24 }}>
          Ring of Fire Clothing © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );

  // ── APP LAUNCHER ────────────────────────────────────────────────────────────
  const isAdmin = user.role === "admin";

  return (
    <div style={S.bg}>
      {/* Header */}
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ ...S.logoCircle, width: 36, height: 36 }}>
            <span style={{ ...S.logoText, fontSize: 13 }}>ROF</span>
          </div>
          <span style={{ color: "#111827", fontWeight: 700, fontSize: 18 }}>Ring of Fire PLM</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={S.userPill}>
            <div style={{ ...S.avatarDot, background: user.color ?? "#CC2200" }}>
              {user.initials ?? user.username?.[0]?.toUpperCase()}
            </div>
            <span style={{ color: "#374151", fontSize: 14, fontWeight: 500 }}>{user.name ?? user.username}</span>
            {isAdmin && <span style={S.adminBadge}>Admin</span>}
          </div>
          {isAdmin && (
            <button style={S.headerBtn} onClick={() => setShowAdmin(true)}>⚙️ Manage Users</button>
          )}
          <button style={{ ...S.headerBtn, color: "#CC2200", borderColor: "#FCA5A5" }}
            onClick={handleSignOut}>Sign Out</button>
        </div>
      </header>

      {/* App Cards */}
      <main style={S.main}>
        <h2 style={S.greeting}>Welcome back, {user.name?.split(" ")[0] ?? user.username} 👋</h2>
        <p style={S.greetingSub}>Select an application to get started</p>

        <div style={S.grid}>
          {APPS.map(app => {
            const perm = getPermission(user, app.id);
            const locked = !perm.access;
            const soon   = app.comingSoon;

            return (
              <div key={app.id}
                style={{
                  ...S.appCard,
                  borderTop: `4px solid ${locked || soon ? "#E5E7EB" : app.color}`,
                  opacity: locked || soon ? 0.6 : 1,
                  cursor: locked || soon ? "not-allowed" : "pointer",
                }}
                onClick={() => !locked && !soon && openApp(app.path)}>

                <div style={{ fontSize: 40, marginBottom: 12 }}>{app.icon}</div>
                <h3 style={{ ...S.appName, color: locked || soon ? "#9CA3AF" : "#111827" }}>
                  {app.name}
                </h3>
                <p style={S.appDesc}>{app.description}</p>

                <div style={{ marginTop: "auto", paddingTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  {soon ? (
                    <span style={S.comingSoonBadge}>Coming Soon</span>
                  ) : locked ? (
                    <span style={S.lockedBadge}>🔒 No Access</span>
                  ) : (
                    <span style={{ ...S.accessBadge, background: app.color + "15", color: app.color, border: `1px solid ${app.color}30` }}>
                      {perm.readOnly ? "👁 Read Only" : "✏️ Read/Write"}
                    </span>
                  )}
                  {!locked && !soon && (
                    <span style={{ color: app.color, fontSize: 20 }}>→</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Admin User Manager Modal */}
      {showAdmin && <UserManagerModal onClose={() => setShowAdmin(false)} currentUser={user} />}
    </div>
  );
}

// ── User Manager Modal ────────────────────────────────────────────────────────
function UserManagerModal({ onClose, currentUser }: { onClose: () => void; currentUser: User }) {
  const [users, setUsers]     = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [msg, setMsg]         = useState("");

  useEffect(() => {
    loadUsers().then(u => { setUsers(u); setLoading(false); });
  }, []);

  async function saveUsers(updated: User[]) {
    setSaving(true);
    try {
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "users", value: JSON.stringify(updated) }),
      });
      setUsers(updated);
      setMsg("Saved!");
      setTimeout(() => setMsg(""), 2000);
    } catch { setMsg("Save failed"); }
    finally { setSaving(false); }
  }

  function updatePermission(userId: string, app: "design" | "tanda" | "techpack", field: keyof AppPermission, value: boolean) {
    const updated = users.map(u => {
      if (u.id !== userId) return u;
      const perms = u.permissions ?? {};
      const appPerm = perms[app] ?? { ...DEFAULT_PERMISSION };
      return { ...u, permissions: { ...perms, [app]: { ...appPerm, [field]: value } } };
    });
    setUsers(updated);
  }

  function uid() { return Math.random().toString(36).slice(2, 11); }

  function addUser() {
    const newUser: User = {
      id: uid(), username: "", name: "", password: "", role: "user", color: "#3B82F6", initials: "",
      permissions: {
        design:   { ...DEFAULT_PERMISSION },
        tanda:    { ...DEFAULT_PERMISSION },
        techpack: { ...DEFAULT_PERMISSION },
      },
    };
    setEditing(newUser);
  }

  function saveEdit() {
    if (!editing) return;
    const exists = users.find(u => u.id === editing.id);
    const updated = exists ? users.map(u => u.id === editing.id ? editing : u) : [...users, editing];
    saveUsers(updated);
    setEditing(null);
  }

  function deleteUser(id: string) {
    if (id === currentUser.id) { alert("You cannot delete yourself."); return; }
    if (!confirm("Delete this user?")) return;
    saveUsers(users.filter(u => u.id !== id));
  }

  const APP_LABELS = [
    { id: "design" as const, label: "Design Calendar", color: "#CC2200" },
    { id: "tanda"  as const, label: "Purchase Orders",  color: "#3B82F6" },
    { id: "techpack" as const, label: "Tech Packs",     color: "#8B5CF6" },
  ];

  return (
    <div style={S.modalOverlay} onClick={onClose}>
      <div style={{ ...S.modal, width: 740, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>⚙️ User Management</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {msg && <span style={{ color: "#10B981", fontSize: 13 }}>{msg}</span>}
            {saving && <span style={{ color: "#6B7280", fontSize: 13 }}>Saving…</span>}
            <button style={S.modalClose} onClick={onClose}>✕</button>
          </div>
        </div>

        <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>
          {loading ? <p style={{ color: "#6B7280" }}>Loading users…</p> : (
            <>
              {/* User list */}
              {users.map(u => (
                <div key={u.id} style={S.userRow}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 160 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: u.color ?? "#CC2200", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 700 }}>
                      {u.initials ?? u.username?.[0]?.toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{u.name ?? u.username}</div>
                      <div style={{ fontSize: 12, color: "#6B7280" }}>@{u.username} · {u.role}</div>
                    </div>
                  </div>

                  {/* Per-app permissions */}
                  {u.role !== "admin" && (
                    <div style={{ display: "flex", gap: 12, flex: 1 }}>
                      {APP_LABELS.map(app => {
                        const perm = u.permissions?.[app.id] ?? DEFAULT_PERMISSION;
                        return (
                          <div key={app.id} style={{ textAlign: "center", minWidth: 100 }}>
                            <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>{app.label}</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                                <input type="checkbox" checked={perm.access}
                                  onChange={e => updatePermission(u.id, app.id, "access", e.target.checked)} />
                                Access
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", opacity: perm.access ? 1 : 0.4 }}>
                                <input type="checkbox" checked={!perm.readOnly} disabled={!perm.access}
                                  onChange={e => updatePermission(u.id, app.id, "readOnly", !e.target.checked)} />
                                Write
                              </label>
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", opacity: perm.access ? 1 : 0.4 }}>
                                <input type="checkbox" checked={perm.seeOthersData} disabled={!perm.access}
                                  onChange={e => updatePermission(u.id, app.id, "seeOthersData", e.target.checked)} />
                                All Data
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {u.role === "admin" && (
                    <span style={{ color: "#CC2200", fontSize: 13, fontStyle: "italic" }}>Admin — full access to all apps</span>
                  )}

                  <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                    <button style={S.editBtn} onClick={() => setEditing({ ...u })}>Edit</button>
                    {u.id !== currentUser.id && (
                      <button style={S.deleteBtn} onClick={() => deleteUser(u.id)}>Remove</button>
                    )}
                  </div>
                </div>
              ))}

              <button style={{ ...S.btnPrimary, marginTop: 16, width: "auto", padding: "10px 20px" }} onClick={addUser}>
                + Add User
              </button>

              {users.length > 0 && (
                <button style={{ ...S.btnSave, marginTop: 12 }} onClick={() => saveUsers(users)} disabled={saving}>
                  {saving ? "Saving…" : "💾 Save All Changes"}
                </button>
              )}
            </>
          )}
        </div>

        {/* Edit User Modal */}
        {editing && (
          <div style={{ ...S.modalOverlay, zIndex: 300 }} onClick={() => setEditing(null)}>
            <div style={{ ...S.modal, width: 420 }} onClick={e => e.stopPropagation()}>
              <div style={S.modalHeader}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
                  {users.find(u => u.id === editing.id) ? "Edit User" : "New User"}
                </h3>
                <button style={S.modalClose} onClick={() => setEditing(null)}>✕</button>
              </div>
              <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={S.label}>Full Name</label>
                  <input style={S.input} value={editing.name ?? ""} onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : p)} placeholder="Full name" />
                </div>
                <div>
                  <label style={S.label}>Username</label>
                  <input style={S.input} value={editing.username} onChange={e => setEditing(p => p ? { ...p, username: e.target.value } : p)} placeholder="username" />
                </div>
                <div>
                  <label style={S.label}>Password</label>
                  <input style={S.input} type="password" value={editing.password} onChange={e => setEditing(p => p ? { ...p, password: e.target.value } : p)} placeholder="password" />
                </div>
                <div>
                  <label style={S.label}>Initials</label>
                  <input style={S.input} value={editing.initials ?? ""} onChange={e => setEditing(p => p ? { ...p, initials: e.target.value.toUpperCase().slice(0, 2) } : p)} placeholder="AB" maxLength={2} />
                </div>
                <div>
                  <label style={S.label}>Role</label>
                  <select style={S.select} value={editing.role} onChange={e => setEditing(p => p ? { ...p, role: e.target.value as "admin" | "user" } : p)}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <label style={S.label}>Color</label>
                  <input type="color" value={editing.color ?? "#CC2200"} onChange={e => setEditing(p => p ? { ...p, color: e.target.value } : p)} style={{ width: 60, height: 36, border: "1px solid #E5E7EB", borderRadius: 6, cursor: "pointer" }} />
                </div>
                <button style={S.btnPrimary} onClick={saveEdit} disabled={!editing.username || !editing.password}>
                  Save User
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  bg:         { minHeight: "100vh", background: "#F9FAFB", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },
  loginWrap:  { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 24 },
  logoCircle: { width: 72, height: 72, borderRadius: "50%", background: "#CC2200", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16, boxShadow: "0 8px 24px rgba(204,34,0,0.3)" },
  logoText:   { color: "#fff", fontWeight: 900, fontSize: 22, letterSpacing: 1 },
  title:      { margin: "0 0 6px", fontSize: 28, fontWeight: 800, color: "#111827" },
  subtitle:   { margin: "0 0 32px", fontSize: 15, color: "#6B7280" },
  card:       { background: "#fff", borderRadius: 16, padding: 28, width: "100%", maxWidth: 380, boxShadow: "0 4px 24px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: 14 },
  input:      { width: "100%", border: "1.5px solid #E5E7EB", borderRadius: 8, padding: "11px 14px", fontSize: 14, color: "#111827", outline: "none", boxSizing: "border-box", background: "#fff" },
  eyeBtn:     { position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#6B7280", padding: 0, lineHeight: 1 },
  err:        { color: "#DC2626", fontSize: 13, margin: 0 },
  btnPrimary: { background: "#CC2200", color: "#fff", border: "none", borderRadius: 8, padding: "12px 20px", fontWeight: 700, fontSize: 14, cursor: "pointer", width: "100%" },

  header:     { background: "#fff", borderBottom: "1px solid #E5E7EB", padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 50 },
  headerBtn:  { background: "none", border: "1px solid #E5E7EB", color: "#374151", borderRadius: 8, padding: "7px 14px", fontSize: 13, cursor: "pointer", fontWeight: 500 },
  userPill:   { display: "flex", alignItems: "center", gap: 8, background: "#F9FAFB", borderRadius: 20, padding: "6px 14px", border: "1px solid #E5E7EB" },
  avatarDot:  { width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700 },
  adminBadge: { background: "#FEF2F2", color: "#CC2200", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, border: "1px solid #FCA5A5" },

  main:       { maxWidth: 960, margin: "0 auto", padding: "48px 24px" },
  greeting:   { margin: "0 0 6px", fontSize: 26, fontWeight: 700, color: "#111827" },
  greetingSub:{ margin: "0 0 36px", fontSize: 15, color: "#6B7280" },
  grid:       { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 },

  appCard:    { background: "#fff", borderRadius: 16, padding: 28, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", display: "flex", flexDirection: "column", transition: "box-shadow 0.15s, transform 0.15s" },
  appName:    { margin: "0 0 8px", fontSize: 18, fontWeight: 700 },
  appDesc:    { margin: 0, fontSize: 13, color: "#6B7280", lineHeight: 1.5 },
  accessBadge:{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 20 },
  lockedBadge:{ fontSize: 12, color: "#9CA3AF", fontWeight: 600 },
  comingSoonBadge: { fontSize: 12, color: "#8B5CF6", background: "#F5F3FF", padding: "4px 10px", borderRadius: 20, fontWeight: 600, border: "1px solid #DDD6FE" },

  // Modal
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:        { background: "#fff", borderRadius: 16, width: 480, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" },
  modalHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #E5E7EB" },
  modalClose:   { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6B7280" },

  userRow:    { display: "flex", alignItems: "flex-start", gap: 16, padding: "14px 0", borderBottom: "1px solid #F3F4F6" },
  editBtn:    { background: "none", border: "1px solid #E5E7EB", color: "#374151", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" },
  deleteBtn:  { background: "none", border: "1px solid #FCA5A5", color: "#DC2626", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer" },
  btnSave:    { background: "#CC2200", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, fontSize: 14, cursor: "pointer", width: "100%" },

  label:  { color: "#374151", fontSize: 13, fontWeight: 500, display: "block", marginBottom: 4 },
  select: { width: "100%", border: "1.5px solid #E5E7EB", borderRadius: 8, padding: "10px 12px", fontSize: 14, color: "#111827", outline: "none", background: "#fff" },
};
