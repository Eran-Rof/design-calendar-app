// api/_lib/capabilityModules.js
//
// Hand-curated CAPABILITY module_keys — RBAC grants that are NOT nav
// destinations, so they do NOT come from the auto-generated nav mirror
// (src/erp/modules.ts → api/_lib/tangerineModules.js). The User Access admin
// grid (api/internal/users-access) unions these into its module list so the CEO
// can grant/revoke them per user like any other cell.
//
// Keep this list tiny and deliberate — a capability is a cross-cutting
// visibility/behavior gate, not a screen. Each entry MUST also exist as a row
// in the `module_keys` DB table (seeded by a migration) so role_permissions can
// reference it.
//
// margins: gates visibility + export of margin% / margin$ (gross margin)
//   columns app-wide. Seeded by 20261700000000_margins_capability_permission.sql
//   (admin + accountant get read+export by default).

export const CAPABILITY_MODULES = [
  {
    key: "margins",
    display_name: "Margin Visibility",
    group_name: "Data Visibility",
    sort_order: 900,
    available_actions: ["read", "export"],
  },
];

export default CAPABILITY_MODULES;
