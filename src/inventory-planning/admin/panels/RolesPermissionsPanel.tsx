// Roles + user-role assignments surface.
// Read-only for non-admins; assign/revoke for admins.

import { useEffect, useMemo, useState } from "react";
import type { IpRole, IpUserRole, IpUserWithPermissions } from "../../governance/types/governance";
import { PERMISSION_KEYS } from "../../governance/types/governance";
import {
  assignUserRole,
  can,
  listRoles,
  listUserRoles,
  revokeUserRole,
} from "../../governance/services/permissionService";
import { logChange } from "../../scenarios/services/auditLogService";
import { S, PAL, formatDate } from "../../components/styles";
import type { ToastMessage } from "../../components/Toast";

export interface RolesPermissionsPanelProps {
  currentUser: IpUserWithPermissions;
  onToast: (t: ToastMessage) => void;
}

export default function RolesPermissionsPanel({ currentUser, onToast }: RolesPermissionsPanelProps) {
  const [roles, setRoles] = useState<IpRole[]>([]);
  const [userRoles, setUserRoles] = useState<IpUserRole[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const isAdmin = can(currentUser, "manage_users_or_roles");

  async function refresh() {
    const [r, ur] = await Promise.all([listRoles(), listUserRoles()]);
    setRoles(r);
    setUserRoles(ur);
    if (!selectedRoleId && r.length > 0) setSelectedRoleId(r[0].id);
  }
  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);

  const selectedRole = useMemo(() => roles.find((r) => r.id === selectedRoleId) ?? null, [roles, selectedRoleId]);
  const assignments = useMemo(() => userRoles.filter((ur) => ur.role_id === selectedRoleId), [userRoles, selectedRoleId]);

  async function assign() {
    if (!selectedRole || !isAdmin) return;
    const email = window.prompt(`Grant "${selectedRole.role_name}" to which email?`);
    if (!email) return;
    try {
      await assignUserRole(email, selectedRole.id, currentUser.user_email);
      await logChange({
        entity_type: "other", changed_field: "role_granted",
        new_value: `${selectedRole.role_name} → ${email}`,
        changed_by: currentUser.user_email,
        change_reason: "category:role_management",
      });
      onToast({ text: "Role granted", kind: "success" });
      await refresh();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }

  async function revoke(ur: IpUserRole) {
    if (!isAdmin) return;
    if (!window.confirm(`Revoke ${ur.user_email}'s role?`)) return;
    try {
      await revokeUserRole(ur.id);
      await logChange({
        entity_type: "other", changed_field: "role_revoked",
        old_value: `user=${ur.user_email} role=${selectedRole?.role_name ?? ur.role_id}`,
        changed_by: currentUser.user_email,
        change_reason: "category:role_management",
      });
      onToast({ text: "Role revoked", kind: "success" });
      await refresh();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 12 }}>
      <div style={S.card}>
        <h3 style={S.cardTitle}>Roles</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {roles.map((r) => (
            <button key={r.id} onClick={() => setSelectedRoleId(r.id)}
                    style={{
                      textAlign: "left",
                      background: r.id === selectedRoleId ? PAL.panelAlt : "transparent",
                      border: `1px solid ${r.id === selectedRoleId ? PAL.accent : PAL.border}`,
                      color: PAL.text, borderRadius: 8, padding: "8px 12px", cursor: "pointer",
                    }}>
              <div style={{ fontWeight: 600 }}>{r.role_name}{r.is_system ? " · system" : ""}</div>
              <div style={{ fontSize: 12, color: PAL.textMuted, marginTop: 4 }}>{r.description ?? ""}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={S.card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <h3 style={S.cardTitle}>{selectedRole?.role_name ?? "—"}</h3>
            <span style={{ color: PAL.textMuted, fontSize: 12 }}>{selectedRole?.description ?? ""}</span>
            {isAdmin && <button style={{ ...S.btnSecondary, marginLeft: "auto" }} onClick={assign}>+ Grant to user</button>}
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: PAL.textDim, marginBottom: 6 }}>Permissions</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {PERMISSION_KEYS.map((k) => {
                const on = selectedRole?.permissions?.[k];
                return (
                  <div key={k} style={{
                    background: on ? PAL.green + "22" : PAL.panel,
                    color: on ? PAL.green : PAL.textMuted,
                    padding: "4px 8px", borderRadius: 6, fontSize: 11, fontFamily: "monospace",
                  }}>
                    {on ? "✓" : "·"} {k}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div style={S.card}>
          <h4 style={S.cardTitle}>Assignments</h4>
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>User</th>
                  <th style={S.th}>Active</th>
                  <th style={S.th}>Granted at</th>
                  <th style={S.th}>Granted by</th>
                  <th style={S.th}>Note</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((ur) => (
                  <tr key={ur.id}>
                    <td style={{ ...S.td, fontFamily: "monospace" }}>{ur.user_email}</td>
                    <td style={S.td}>{ur.active ? "✓" : "✕"}</td>
                    <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDate(ur.granted_at.slice(0, 10))}</td>
                    <td style={{ ...S.td, fontFamily: "monospace", color: PAL.textMuted, fontSize: 11 }}>{ur.granted_by ?? ""}</td>
                    <td style={{ ...S.td, color: PAL.textMuted }}>{ur.note ?? ""}</td>
                    <td style={S.td}>
                      {isAdmin && ur.active && (
                        <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => revoke(ur)}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
                {assignments.length === 0 && (
                  <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                    No users currently hold this role.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
