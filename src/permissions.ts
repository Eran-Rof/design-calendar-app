// ── PLM permission model ─────────────────────────────────────────────────────
// Pure helpers shared by PLM.tsx (UserManagerModal), NavBar.tsx (ATS Reports
// menu gate) and TechPack.tsx (Costing tab gate). Lives in its own module so
// the logic is testable without booting the React shell — see
// src/__tests__/permissions.test.ts for the unit coverage.
//
// Internal staff users live in sessionStorage.plm_user (NOT Supabase Auth;
// see project_internal_auth_pattern.md). The session blob shape mirrors the
// User interface here. Default-true semantics: any missing/undefined entry
// means access granted, so users that pre-date a new permission gate keep
// working without manual migration.

export interface AppPermission {
  access: boolean;
  readOnly: boolean;
  seeOthersData: boolean;
}

export interface AtsReportsPermission {
  exportExcel?: boolean;
  negInven?: boolean;
  agedInven?: boolean;
  noMrgnData?: boolean;
  stockVsSo?: boolean;
  salesComps?: boolean;
}

export interface AtsPermission extends AppPermission {
  reports?: AtsReportsPermission;
}

export type PermissionAppId =
  | "design"
  | "tanda"
  | "techpack"
  | "ats"
  | "costing"
  | "vendor";

export interface PermissionUser {
  id?: string;
  username?: string;
  role?: "admin" | "user";
  permissions?: {
    design?: AppPermission;
    tanda?: AppPermission;
    techpack?: AppPermission;
    ats?: AtsPermission;
    costing?: AppPermission;
    vendor?: AppPermission;
  };
}

export const DEFAULT_PERMISSION: AppPermission = { access: true, readOnly: false, seeOthersData: false };
export const ADMIN_PERMISSION: AppPermission = { access: true, readOnly: false, seeOthersData: true };

export const ATS_REPORT_KEYS = ["exportExcel", "negInven", "agedInven", "noMrgnData", "stockVsSo", "salesComps"] as const;
export type AtsReportKey = typeof ATS_REPORT_KEYS[number];

const ALL_REPORTS_ON: Record<AtsReportKey, boolean> = {
  exportExcel: true,
  negInven: true,
  agedInven: true,
  noMrgnData: true,
  stockVsSo: true,
  salesComps: true,
};

export function getAppPermission(user: PermissionUser, app: PermissionAppId): AppPermission {
  if (user.role === "admin") return ADMIN_PERMISSION;
  return user.permissions?.[app] ?? DEFAULT_PERMISSION;
}

// Resolve report permissions with default-true semantics. Admins see every
// report regardless of stored config (matches the "Admin — full access to
// all apps" behavior in the User Management modal).
export function getAtsReportsPermissions(user: PermissionUser): Record<AtsReportKey, boolean> {
  if (user.role === "admin") return { ...ALL_REPORTS_ON };
  const reports = user.permissions?.ats?.reports ?? {};
  const resolved = {} as Record<AtsReportKey, boolean>;
  for (const k of ATS_REPORT_KEYS) {
    resolved[k] = reports[k] !== false; // missing or true → true
  }
  return resolved;
}

// Session helpers — read sessionStorage.plm_user once and resolve the gates.
// Safe to call in SSR/test environments without a window — returns the
// "all on" defaults so callers don't need their own guards.

function readSessionUser(): PermissionUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem("plm_user");
    if (!raw) return null;
    return JSON.parse(raw) as PermissionUser;
  } catch {
    return null;
  }
}

export function getAtsReportPermissionsFromSession(): Record<AtsReportKey, boolean> {
  const u = readSessionUser();
  if (!u) return { ...ALL_REPORTS_ON };
  return getAtsReportsPermissions(u);
}

// True when the current session user is allowed to see the Costing tab in
// Tech Packs. Default-true when no session / no permission entry.
export function canSeeCostingTabFromSession(): boolean {
  const u = readSessionUser();
  if (!u) return true;
  if (u.role === "admin") return true;
  return u.permissions?.costing?.access !== false;
}

// True when the current session user may open the standalone Costing app
// (launcher card + the /costing route guard in main.tsx). Same permission
// key as the Tech Packs Costing tab above. Default-true when no session /
// no permission entry, so pre-existing users keep working.
export function canAccessCostingFromSession(): boolean {
  return canSeeCostingTabFromSession();
}

// True when the Vendor Portal card should render on the PLM dashboard for
// the given user. Admins always see it; regular users need
// permissions.vendor.access === true.
export function canSeeVendorPortalCard(user: PermissionUser): boolean {
  if (user.role === "admin") return true;
  return user.permissions?.vendor?.access === true;
}
