// src/config/env.ts
//
// Single source of truth for runtime configuration.
// All values come from Vite env vars (VITE_* prefix = bundled into the frontend).
// Read once at module evaluation; import `appConfig` throughout the app.

export type AppEnv = "development" | "staging" | "production";

function parseAppEnv(): AppEnv {
  const raw = ((import.meta.env.VITE_APP_ENV as string) ?? "").trim().toLowerCase();
  if (raw === "staging") return "staging";
  if (raw === "production") return "production";
  return "development";
}

function parseBool(key: string, defaultValue: boolean): boolean {
  const raw = ((import.meta.env[key] as string) ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return defaultValue;
}

function parseEmailList(key: string): string[] {
  const raw = ((import.meta.env[key] as string) ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

const appEnv = parseAppEnv();

export const appConfig = {
  appEnv,
  isStaging:     appEnv === "staging",
  isProduction:  appEnv === "production",
  isDevelopment: appEnv === "development",

  supabaseConfigured:
    Boolean(((import.meta.env.VITE_SUPABASE_URL as string) ?? "").trim()) &&
    Boolean(((import.meta.env.VITE_SUPABASE_ANON_KEY as string) ?? "").trim()),

  // Inventory planning feature flags.
  // Dev default: enabled (easy local iteration).
  // Staging default: enabled, beta-only (access list controls who sees it).
  // Production default: disabled until Phase 1 is signed off.
  inventoryPlanningEnabled:    parseBool("VITE_ENABLE_INVENTORY_PLANNING",          appEnv === "development"),
  inventoryPlanningBetaOnly:   parseBool("VITE_ENABLE_INVENTORY_PLANNING_BETA_ONLY", appEnv !== "development"),
  inventoryPlanningAllowedEmails: parseEmailList("VITE_INVENTORY_PLANNING_ALLOWED_EMAILS"),

  // Integration safety flags.
  // Read-only is the safe default everywhere except production.
  xoroReadOnly:      parseBool("VITE_ENABLE_XORO_READONLY",    appEnv !== "production"),
  shopifyReadOnly:   parseBool("VITE_ENABLE_SHOPIFY_READONLY",  appEnv !== "production"),
  erpWritebackEnabled: parseBool("VITE_ENABLE_ERP_WRITEBACK",   false),
} as const;
