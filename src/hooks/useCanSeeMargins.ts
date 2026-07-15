// src/hooks/useCanSeeMargins.ts
//
// Single, app-wide gate for margin visibility. Every panel that renders a
// margin% / margin$ (gross-margin) column, KPI, or export MUST ask THIS hook —
// so the gate is enforced the SAME way everywhere and the CEO can grant/revoke
// it from one place (User Access → the `margins` capability).
//
// Backed by the P14 RBAC `margins` capability:
//   • margins:read   → may VIEW margin columns / KPIs
//   • margins:export → may EXPORT margin data
//
// Fail-open contract (inherited from useEffectivePermissions.can): both return
// TRUE whenever RBAC_MODE !== "enforce", perms haven't loaded, or the caller is
// unidentified. So this is a NO-OP until enforcement is live — margins stay
// visible for everyone today — and only under enforce do non-granted users lose
// the columns. An operator can never be locked out by a fetch hiccup.
//
// Usage:
//   const { canView, canExport } = useCanSeeMargins();
//   {canView && <th>Margin %</th>}
//   <ExportButton disabled={!canExport} … />   // or drop margin cols from rows

import { useEffectivePermissions } from "./useEffectivePermissions";

export interface CanSeeMargins {
  /** May the caller SEE margin columns / KPIs? */
  canView: boolean;
  /** May the caller EXPORT margin data? (implies canView) */
  canExport: boolean;
  /** True while the permission set is still loading (both flags fail-open meanwhile). */
  loading: boolean;
}

export const MARGINS_MODULE_KEY = "margins";

export function useCanSeeMargins(): CanSeeMargins {
  const { can, loading } = useEffectivePermissions();
  return {
    canView: can(MARGINS_MODULE_KEY, "read"),
    canExport: can(MARGINS_MODULE_KEY, "export"),
    loading,
  };
}
