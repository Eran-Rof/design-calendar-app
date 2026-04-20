// Header pill that shows the current (impersonated) user email and
// lets the planner change it. Dev-friendly shim while the real auth
// story hasn't landed — matches the Phase 7 doc: localStorage-backed.

import { useEffect, useState } from "react";
import { currentUserEmail, setCurrentUserEmail, loadPermissionsFor } from "../../governance/services/permissionService";
import type { IpUserWithPermissions } from "../../governance/types/governance";
import { S, PAL } from "../../components/styles";

export interface UserSwitcherProps {
  onChange?: (user: IpUserWithPermissions) => void;
}

export default function UserSwitcher({ onChange }: UserSwitcherProps) {
  const [email, setEmail] = useState(currentUserEmail());
  const [user, setUser] = useState<IpUserWithPermissions | null>(null);

  useEffect(() => {
    void (async () => {
      const u = await loadPermissionsFor(email);
      setUser(u);
      onChange?.(u);
    })();
  }, [email, onChange]);

  const perms = user?.permissions ?? {};
  const roles = user?.roles ?? [];
  const roleCount = roles.length;
  const permCount = Object.values(perms).filter(Boolean).length;

  async function changeUser() {
    const next = window.prompt("Switch user (email) — session-only impersonation for dev", email);
    if (!next) return;
    setCurrentUserEmail(next);
    setEmail(next.trim().toLowerCase());
  }

  return (
    <button onClick={changeUser} title="Click to switch impersonated user"
            style={{
              ...S.btnSecondary, display: "flex", alignItems: "center", gap: 8,
              border: roleCount > 0 ? `1px solid ${PAL.accent}` : `1px solid ${PAL.red}`,
            }}>
      <span style={{ fontFamily: "monospace", color: PAL.text }}>{email}</span>
      <span style={{
        ...S.chip,
        background: (roleCount > 0 ? PAL.accent : PAL.red) + "33",
        color: roleCount > 0 ? PAL.accent : PAL.red,
        fontSize: 11,
      }}>
        {roleCount > 0 ? `${roles.map((r) => r.role_name).join(",")} · ${permCount} perms` : "no roles"}
      </span>
    </button>
  );
}
