// src/tanda/InternalUserAccess.tsx
//
// P14-3b — RBAC User Access admin panel (🔐 Admin nav group).
//
// Two-pane operator surface over the permission matrix:
//   • Left  — every member of the entity + their assigned role.
//   • Right — for the selected user: a role dropdown + a module × action grid.
//             Each cell shows the EFFECTIVE permission (role grant ± override);
//             clicking a cell either writes a per-user override or, when the new
//             state matches the role default, clears the override (revert).
//
// Reads/writes the chunk-3b handlers:
//   GET    /api/internal/users-access            → { modules, roles, role_grants, users }
//   PUT    /api/internal/users-access            → { user_id, role_id }
//   PUT    /api/internal/users-access/override   → { user_id, module_key, action, allowed }
//   DELETE /api/internal/users-access/override   → { user_id, module_key, action }
//
// Enforcement is gated by RBAC_MODE on the server (off by default) — this panel
// configures the matrix; it does not itself turn enforcement on.

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";

const ACTIONS = ["read", "write", "post", "void", "export"] as const;
type Action = (typeof ACTIONS)[number];

type ModuleDef = {
  key: string;
  display_name: string;
  group_name: string;
  sort_order: number;
  available_actions: Action[];
};
type RoleDef = { id: string; name: string; description: string | null; is_seed: boolean };
type OverrideCell = { module_key: string; action: Action; allowed: boolean; reason: string | null };
type UserRow = {
  user_id: string;
  email: string | null;
  legacy_role: string | null;
  role_id: string | null;
  role_name: string | null;
  overrides: OverrideCell[];
  effective: string[]; // "module:action"
};
type Matrix = {
  entity_id: string;
  modules: ModuleDef[];
  roles: RoleDef[];
  role_grants: Record<string, string[]>; // role_id → ["module:action", …]
  users: UserRow[];
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", danger: "#EF4444", warn: "#F59E0B",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13,
};

const key = (m: string, a: string) => `${m}:${a}`;

export default function InternalUserAccess() {
  const [data, setData] = useState<Matrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [busyGroup, setBusyGroup] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/users-access");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const m: Matrix = await r.json();
      setData(m);
      setSelectedId((prev) => prev && m.users.some((u) => u.user_id === prev) ? prev : (m.users[0]?.user_id ?? null));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(
    () => data?.users.find((u) => u.user_id === selectedId) || null,
    [data, selectedId],
  );

  // Effective set + override map for the selected user.
  const effectiveSet = useMemo(() => new Set(selected?.effective || []), [selected]);
  const overrideMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const o of selected?.overrides || []) map.set(key(o.module_key, o.action), o.allowed);
    return map;
  }, [selected]);
  // What the user's role grants by itself (before overrides).
  const roleGrantSet = useMemo(
    () => new Set(selected?.role_id ? (data?.role_grants[selected.role_id] || []) : []),
    [data, selected],
  );

  async function changeRole(roleId: string) {
    if (!selected) return;
    setErr(null);
    try {
      const r = await fetch("/api/internal/users-access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: selected.user_id, role_id: roleId }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function toggleCell(moduleKey: string, action: Action) {
    if (!selected) return;
    const k = key(moduleKey, action);
    const currentlyOn = effectiveSet.has(k);
    const next = !currentlyOn;
    const roleDefault = roleGrantSet.has(k);
    setBusyCell(k);
    setErr(null);
    try {
      let r: Response;
      if (next === roleDefault) {
        // Toggling back to the role default → drop any override (clean state).
        r = await fetch("/api/internal/users-access/override", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_id: selected.user_id, module_key: moduleKey, action }),
        });
      } else {
        // Diverge from the role default → record an explicit grant/revoke.
        r = await fetch("/api/internal/users-access/override", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_id: selected.user_id, module_key: moduleKey, action, allowed: next }),
        });
      }
      if (!r.ok && r.status !== 204) {
        throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyCell(null);
    }
  }

  // Select-all (or clear-all) every supported action across every module in a
  // group. Mirrors toggleCell's grant/revoke-vs-role-default logic per cell, but
  // batches the writes and reloads ONCE at the end (a group can be 50+ cells).
  async function selectGroup(group: string, on: boolean) {
    if (!selected) return;
    const mods = grouped.find((g) => g.group === group)?.modules || [];
    setBusyGroup(group);
    setErr(null);
    try {
      for (const m of mods) {
        for (const action of ACTIONS) {
          if (!m.available_actions.includes(action)) continue;
          const k = key(m.key, action);
          if (effectiveSet.has(k) === on) continue; // already in desired state
          const roleDefault = roleGrantSet.has(k);
          const r = on === roleDefault
            ? await fetch("/api/internal/users-access/override", {
                method: "DELETE", headers: { "content-type": "application/json" },
                body: JSON.stringify({ user_id: selected.user_id, module_key: m.key, action }),
              })
            : await fetch("/api/internal/users-access/override", {
                method: "PUT", headers: { "content-type": "application/json" },
                body: JSON.stringify({ user_id: selected.user_id, module_key: m.key, action, allowed: on }),
              });
          if (!r.ok && r.status !== 204) {
            throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          }
        }
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyGroup(null);
    }
  }

  // Is every supported (module, action) in the group effectively ON?
  function groupAllOn(modules: ModuleDef[]): boolean {
    let any = false;
    for (const m of modules) {
      for (const action of ACTIONS) {
        if (!m.available_actions.includes(action)) continue;
        any = true;
        if (!effectiveSet.has(key(m.key, action))) return false;
      }
    }
    return any;
  }

  // Modules grouped by group_name, preserving sort_order.
  const grouped = useMemo(() => {
    const groups: { group: string; modules: ModuleDef[] }[] = [];
    const idx = new Map<string, number>();
    for (const m of data?.modules || []) {
      if (!idx.has(m.group_name)) { idx.set(m.group_name, groups.length); groups.push({ group: m.group_name, modules: [] }); }
      groups[idx.get(m.group_name)!].modules.push(m);
    }
    return groups;
  }, [data]);

  // Export: one row per user with role + effective-permission count + the
  // pipe-joined effective list (the universal-export rule applies here too).
  const exportRows = useMemo(
    () => (data?.users || []).map((u) => ({
      email: u.email || u.user_id,
      role: u.role_name || "(none)",
      legacy_role: u.legacy_role || "",
      effective_count: u.effective.length,
      override_count: u.overrides.length,
      effective: u.effective.join(" | "),
    })),
    [data],
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: 24, color: C.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>User Access</h1>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Per-module × per-action permissions. Pick a user, set their role, tick cells to override.
        </span>
        <div style={{ marginLeft: "auto" }}>
          <ExportButton
            rows={exportRows as unknown as Array<Record<string, unknown>>}
            filename="user-access"
            sheetName="User Access"
            columns={[
              { key: "email",           header: "User" },
              { key: "role",            header: "Role" },
              { key: "legacy_role",     header: "Legacy Role" },
              { key: "effective_count", header: "Effective #" },
              { key: "override_count",  header: "Overrides #" },
              { key: "effective",       header: "Effective Permissions" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 16 }}>
        Enforcement is controlled by <code>RBAC_MODE</code> on the server (default <strong>off</strong>). Configure
        the matrix here, then roll out <code>off → log → enforce</code>. Every change is recorded in the audit log.
      </div>

      {err && <div style={{ background: "#7f1d1d", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}

      {!loading && data && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, alignItems: "start" }}>
          {/* ── Left: user list ─────────────────────────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
            <div style={{ ...th, padding: "10px 12px" }}>Users ({data.users.length})</div>
            {data.users.length === 0 && (
              <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No members in this entity.</div>
            )}
            {data.users.map((u) => {
              const isSel = u.user_id === selectedId;
              return (
                <button
                  key={u.user_id}
                  onClick={() => setSelectedId(u.user_id)}
                  style={{
                    display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                    background: isSel ? "#0b1220" : "transparent", border: 0,
                    borderBottom: `1px solid ${C.cardBdr}`, borderLeft: `3px solid ${isSel ? C.primary : "transparent"}`,
                    padding: "10px 12px", color: C.text,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.email || <span style={{ color: C.textMuted }}>(unknown user)</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>
                    {u.role_name || <span style={{ color: C.warn }}>no role</span>}
                    {u.overrides.length > 0 && <span style={{ color: C.warn }}> · {u.overrides.length} override{u.overrides.length > 1 ? "s" : ""}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Right: matrix for the selected user ─────────────────────── */}
          <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 16 }}>
            {!selected && <div style={{ color: C.textMuted }}>Select a user.</div>}
            {selected && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.email || selected.user_id}</div>
                  <label style={{ fontSize: 12, color: C.textSub, display: "flex", alignItems: "center", gap: 6 }}>
                    Role
                    <SearchableSelect
                      inputStyle={{ ...inputStyle, padding: "5px 8px" }}
                      value={selected.role_id || ""}
                      onChange={(v) => void changeRole(v)}
                      options={[
                        ...(!selected.role_id ? [{ value: "", label: "(select)" }] : []),
                        ...data.roles.map((r) => ({ value: r.id, label: r.name })),
                      ]}
                    />
                  </label>
                  <Legend />
                </div>

                <div style={{ overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={th}>Module</th>
                        {ACTIONS.map((a) => <th key={a} style={{ ...th, textAlign: "center", width: 70 }}>{a}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {grouped.map((g) => (
                        <GroupBlock
                          key={g.group}
                          group={g.group}
                          allOn={groupAllOn(g.modules)}
                          busy={busyGroup === g.group}
                          disabled={!selected || busyGroup != null}
                          onToggleAll={(on) => void selectGroup(g.group, on)}
                        >
                          {g.modules.map((m) => (
                            <tr key={m.key}>
                              <td style={td}>
                                <div style={{ fontWeight: 600 }}>{m.display_name}</div>
                                <div style={{ fontSize: 10, color: C.textMuted, fontFamily: "monospace" }}>{m.key}</div>
                              </td>
                              {ACTIONS.map((a) => {
                                const exposes = m.available_actions.includes(a);
                                const k = key(m.key, a);
                                const on = effectiveSet.has(k);
                                const ov = overrideMap.get(k); // true=grant, false=revoke, undefined=none
                                return (
                                  <td key={a} style={{ ...td, textAlign: "center" }}>
                                    {exposes ? (
                                      <Cell
                                        on={on}
                                        override={ov}
                                        busy={busyCell === k}
                                        onClick={() => void toggleCell(m.key, a)}
                                      />
                                    ) : (
                                      <span style={{ color: "#475569" }}>·</span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </GroupBlock>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Cell({ on, override, busy, onClick }: {
  on: boolean; override: boolean | undefined; busy: boolean; onClick: () => void;
}) {
  // Border colour signals an explicit override: green grant, red revoke.
  const ovBorder = override === true ? C.success : override === false ? C.danger : "transparent";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={override === true ? "Override: granted" : override === false ? "Override: revoked" : on ? "Granted by role" : "Not granted"}
      style={{
        width: 26, height: 26, borderRadius: 5, cursor: busy ? "wait" : "pointer",
        background: on ? C.success : "#0b1220",
        border: `2px solid ${override !== undefined ? ovBorder : (on ? C.success : C.cardBdr)}`,
        color: "white", fontSize: 13, lineHeight: "22px", opacity: busy ? 0.5 : 1, padding: 0,
      }}
    >
      {on ? "✓" : ""}
    </button>
  );
}

function Legend() {
  const dot = (bg: string, bdr: string) => ({
    display: "inline-block", width: 12, height: 12, borderRadius: 3,
    background: bg, border: `2px solid ${bdr}`, verticalAlign: "middle", marginRight: 4,
  } as React.CSSProperties);
  return (
    <div style={{ marginLeft: "auto", fontSize: 11, color: C.textMuted, display: "flex", gap: 12, alignItems: "center" }}>
      <span><span style={dot(C.success, C.success)} />granted</span>
      <span><span style={dot("#0b1220", C.cardBdr)} />denied</span>
      <span><span style={dot(C.success, C.success)} />/<span style={dot("#0b1220", C.danger)} />override</span>
    </div>
  );
}

function GroupBlock({ group, children, allOn, busy, disabled, onToggleAll }: {
  group: string;
  children: React.ReactNode;
  allOn: boolean;
  busy: boolean;
  disabled: boolean;
  onToggleAll: (on: boolean) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={1 + ACTIONS.length} style={{
          background: "#0b1220", color: C.textMuted, fontSize: 10, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: 0.5, padding: "5px 10px",
        }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}
                 title="Select / clear every action for every module in this group">
            <input
              type="checkbox"
              checked={allOn}
              disabled={disabled}
              onChange={(e) => onToggleAll(e.target.checked)}
              style={{ cursor: disabled ? "default" : "pointer" }}
            />
            {group}{busy ? " — saving…" : ""}
          </label>
        </td>
      </tr>
      {children}
    </>
  );
}
