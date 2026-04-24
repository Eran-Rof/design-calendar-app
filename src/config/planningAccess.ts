// src/config/planningAccess.ts
//
// Determines whether a given user may access the inventory planning module.
// Used at route mount time (main.tsx) and in PLM card rendering (PLM.tsx).
//
// Access tiers (evaluated in order):
//   1. inventoryPlanningEnabled = false  → always denied
//   2. inventoryPlanningBetaOnly = false → allowed for all authenticated users
//   3. betaOnly = true, allowedEmails empty → allowed for all authenticated users
//   4. betaOnly = true, allowedEmails non-empty → email must be in the list

import { appConfig } from "./env";

// Accepts an optional config override so unit tests can inject values
// without needing to stub import.meta.env.
export function canAccessInventoryPlanning(
  userEmail?: string | null,
  config: Pick<
    typeof appConfig,
    "inventoryPlanningEnabled" | "inventoryPlanningBetaOnly" | "inventoryPlanningAllowedEmails"
  > = appConfig,
): boolean {
  if (!config.inventoryPlanningEnabled) return false;
  if (!config.inventoryPlanningBetaOnly) return true;

  const { inventoryPlanningAllowedEmails: allowed } = config;
  if (allowed.length === 0) return true; // beta-only but open list

  if (!userEmail) return false;
  return allowed.includes(userEmail.trim().toLowerCase());
}

// Reads the PLM session from sessionStorage (set by PLM.tsx after login).
// Returns the username string, or null if no session exists.
// Safe to call in any context — never throws.
export function getPlmSessionEmail(): string | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username?: string } | null;
    return parsed?.username?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}
