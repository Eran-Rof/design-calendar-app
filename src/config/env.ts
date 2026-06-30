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

  // Sandbox demo mode. When true: external integrations return canned
  // responses (see api/_lib/demoGuard.js), the PLM landing hides apps
  // outside the demo scope, and a DEMO banner is rendered. Set only on
  // the design-calendar-demo Vercel deploy.
  demoMode: parseBool("VITE_DEMO_MODE", false),

  // Go-live switch for "Tangerine is the front door." When true, the root
  // route `/` redirects to the standalone Tangerine login page (`/login`)
  // instead of rendering the legacy PLM launcher — the planned retirement of
  // the PLM launcher. OFF by default: today `/` still shows the PLM launcher
  // and `/login` is reachable directly. Flip this on Vercel at go-live.
  tangerineAsHome: parseBool("VITE_TANGERINE_AS_HOME", false),

  // P27 Phase 3 — Suite SSO front door. When ON, Tangerine requires a Microsoft
  // sign-in instead of silently adopting the cloned PLM-launcher session: a user
  // with no MS token lands on the Microsoft login (which mints the per-user JWT
  // and provisions identity by email). The PLM session stays available as a
  // BREAK-GLASS link on that screen, so an Entra outage can't lock anyone out.
  // OFF by default → today's no-relogin behavior is unchanged; flip on Vercel
  // only once every user's M365 account (matching email) is confirmed.
  suiteSsoFrontDoor: parseBool("VITE_SUITE_SSO_FRONT_DOOR", false),
} as const;
