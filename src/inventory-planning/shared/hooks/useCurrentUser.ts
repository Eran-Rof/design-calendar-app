// Small hook that resolves the current impersonated user + permissions.
// Re-runs when the email in localStorage changes (lightweight polling so
// the header-bar user switcher is reflected in sub-panels within ~1s).

import { useEffect, useState } from "react";
import type { IpUserWithPermissions } from "../../governance/types/governance";
import { currentUserEmail, loadPermissionsFor } from "../../governance/services/permissionService";

export function useCurrentUser(): IpUserWithPermissions | null {
  const [user, setUser] = useState<IpUserWithPermissions | null>(null);

  useEffect(() => {
    let mounted = true;
    let lastEmail = currentUserEmail();

    async function load() {
      const u = await loadPermissionsFor(lastEmail);
      if (mounted) setUser(u);
    }
    void load();

    // Lightweight poll for email changes (the admin user switcher
    // writes to localStorage and we want sub-panels to notice).
    const t = window.setInterval(() => {
      const cur = currentUserEmail();
      if (cur !== lastEmail) {
        lastEmail = cur;
        void load();
      }
    }, 1500);

    return () => { mounted = false; clearInterval(t); };
  }, []);

  return user;
}
