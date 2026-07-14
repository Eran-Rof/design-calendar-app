// src/Tangerine.tsx
//
// Tangerine ERP — independent shell. Hosts the 6 P1 admin panels and provides
// an Apps launcher linking to the other modules (Design Calendar, PO WIP, ATS,
// Tech Packs, GS1, Planning, Vendor Portal).
//
// Architectural note: previously these 6 admin panels lived inside the Tanda
// (PO WIP) app's "Vendors ▾" dropdown, which was the wrong long-term home —
// Tangerine should be the parent ERP shell that hosts everything else, not a
// sub-feature of one PLM app. Chunk T1 (2026-05-26) moves them out.
//
// Panel React components themselves still live at src/tanda/Internal*.tsx for
// now (they're reusable; importing across folders is fine). A future cleanup
// can rename them to src/tangerine/*Panel.tsx for clarity but it's cosmetic.

import { useEffect, useMemo, useRef, useState } from "react";
import { WarnHost, notify, confirmDialog } from "./shared/ui/warn";
import { StyleGalleryHost } from "./shared/ui/StyleImageGallery";

import InternalStyleMaster        from "./tanda/InternalStyleMaster";
import InternalPimProductCatalog  from "./tanda/InternalPimProductCatalog";
import InternalFabricCodes        from "./tanda/InternalFabricCodes";
import InternalHtsMaster          from "./tanda/InternalHtsMaster";
import InternalVendorMaster       from "./tanda/InternalVendorMaster";
import InternalCustomerMaster     from "./tanda/InternalCustomerMaster";
import InternalPaymentTerms       from "./tanda/InternalPaymentTerms";
import InternalSizeScales         from "./tanda/InternalSizeScales";
import InternalSeasonMaster       from "./tanda/InternalSeasonMaster";
import InternalColorMaster        from "./tanda/InternalColorMaster";
import InternalFabricMillMaster   from "./tanda/InternalFabricMillMaster";
import InternalPartMaster         from "./tanda/InternalPartMaster";
import InternalServiceItemMaster  from "./tanda/InternalServiceItemMaster";
import InternalPartTypeMaster     from "./tanda/InternalPartTypeMaster";
import InternalPartInventory      from "./tanda/InternalPartInventory";
import InternalMfgBom             from "./tanda/InternalMfgBom";
import InternalMfgBuildOrders     from "./tanda/InternalMfgBuildOrders";
import InternalMfgReports         from "./tanda/InternalMfgReports";
import InternalSyncHealth         from "./tanda/InternalSyncHealth";
import InternalRmaReasonMaster    from "./tanda/InternalRmaReasonMaster";
import InternalAdjustmentTypeMaster from "./tanda/InternalAdjustmentTypeMaster";
import InternalDatePresetMaster from "./tanda/InternalDatePresetMaster";
import InternalAdjustmentReasonMaster from "./tanda/InternalAdjustmentReasonMaster";
import InternalTransferReasonMaster from "./tanda/InternalTransferReasonMaster";
import InternalWarehouseMaster     from "./tanda/InternalWarehouseMaster";
import InternalCarrierMaster      from "./tanda/InternalCarrierMaster";
import InternalBuyerScopeMaster   from "./tanda/InternalBuyerScopeMaster";
import InternalB2BAccounts        from "./tanda/InternalB2BAccounts";
import InternalPriceLists         from "./tanda/InternalPriceLists";
import InternalPromotions         from "./tanda/InternalPromotions";
import InternalCountries          from "./tanda/InternalCountries";
import InternalGenders            from "./tanda/InternalGenders";
import InternalStyleClassifications from "./tanda/InternalStyleClassifications";
import InternalFactors            from "./tanda/InternalFactors";
import InternalCOA                from "./tanda/InternalCOA";
import InternalPeriods            from "./tanda/InternalPeriods";
import InternalJournalEntry       from "./tanda/InternalJournalEntry";
import InternalAPInvoices         from "./tanda/InternalAPInvoices";
import InternalAPPayments         from "./tanda/InternalAPPayments";
import InternalARInvoices         from "./tanda/InternalARInvoices";
import InternalSalesOrders        from "./tanda/InternalSalesOrders";
import InternalAllocations        from "./tanda/InternalAllocations";
import InternalSalesReturns       from "./tanda/InternalSalesReturns";
import InternalDropShip          from "./tanda/InternalDropShip";
import InternalThreePL           from "./tanda/InternalThreePL";
import InternalThreePLRecon      from "./tanda/InternalThreePLRecon";
import InternalEDI               from "./tanda/InternalEDI";
import InternalEdiCustomers      from "./tanda/InternalEdiCustomers";
import InternalEdiSettings       from "./tanda/InternalEdiSettings";
import InternalReportsHub        from "./tanda/InternalReportsHub";
import InternalFixedAssets       from "./tanda/InternalFixedAssets";
import InternalBudgets           from "./tanda/InternalBudgets";
import InternalForm1099          from "./tanda/InternalForm1099";
import InternalPurchaseOrders     from "./tanda/InternalPurchaseOrders";
import InternalReceiving          from "./tanda/InternalReceiving";
import InternalBookkeeperApproval from "./tanda/InternalBookkeeperApproval";
import InternalQCInspections      from "./tanda/InternalQCInspections";
import InternalCustomsEntries     from "./tanda/InternalCustomsEntries";
import InternalBrokerInvoices     from "./tanda/InternalBrokerInvoices";
import InternalThreeWayMatch      from "./tanda/InternalThreeWayMatch";
import InternalProcurementRecon   from "./tanda/InternalProcurementRecon";
import InternalARReceipts         from "./tanda/InternalARReceipts";
import InternalARAging            from "./tanda/InternalARAging";
// P7-7 — M9-subset operational reports under the new 📊 Reports group.
import InternalAPAging            from "./tanda/InternalAPAging";
import InternalSalesByRep         from "./tanda/InternalSalesByRep";
import InternalSalesByCustomer    from "./tanda/InternalSalesByCustomer";
import InternalGLDetail           from "./tanda/InternalGLDetail";
import InternalUpcReport          from "./tanda/InternalUpcReport";
import InternalARBackfill         from "./tanda/InternalARBackfill";
import InternalTrialBalance       from "./tanda/InternalTrialBalance";
import InternalFactorRecon        from "./tanda/InternalFactorRecon";
import InternalChargebacks         from "./tanda/InternalChargebacks";
import InternalMonthEndClose      from "./tanda/InternalMonthEndClose";
import InternalIncomeStatement    from "./tanda/InternalIncomeStatement";
import InternalSegmentPL          from "./tanda/InternalSegmentPL";
import InternalBalanceSheet       from "./tanda/InternalBalanceSheet";
import InternalCashFlow           from "./tanda/InternalCashFlow";
import InternalYearEndClose       from "./tanda/InternalYearEndClose";
import InternalBankReconciliation from "./tanda/InternalBankReconciliation";
import InternalBankReconReport    from "./tanda/InternalBankReconReport";
import InternalApprovalRules           from "./tanda/InternalApprovalRules";
import InternalApprovalRequests        from "./tanda/InternalApprovalRequests";
import InternalNotificationCenter      from "./tanda/InternalNotificationCenter";
import InternalNotificationPreferences from "./tanda/InternalNotificationPreferences";
import InternalEmployees               from "./tanda/InternalEmployees";
import InternalEmployeeTitles          from "./tanda/InternalEmployeeTitles";
import InternalEmployeeDepartments     from "./tanda/InternalEmployeeDepartments";
import InternalInventoryMatrix          from "./tanda/InternalInventoryMatrix";
import InternalPrepackMatrix            from "./tanda/InternalPrepackMatrix";
import InternalInventoryTransfers      from "./tanda/InternalInventoryTransfers";
import InternalInventoryAdjustments    from "./tanda/InternalInventoryAdjustments";
import InternalCycleCounts             from "./tanda/InternalCycleCounts";
import InternalScannerSessions         from "./tanda/InternalScannerSessions";
import InternalCases                   from "./tanda/InternalCases";
// P8-3 — M25 CRM panels (Opportunities + Activities + Tasks + Pipeline Report).
import InternalCrmOpportunities       from "./tanda/InternalCrmOpportunities";
import InternalCrmActivities          from "./tanda/InternalCrmActivities";
import InternalCrmTasks               from "./tanda/InternalCrmTasks";
import InternalCrmPipelineReport      from "./tanda/InternalCrmPipelineReport";
// Cross-cutter T10-7 — Shadow Mirror Status panel (Xoro → Tangerine nightly mirror dashboard).
import InternalShadowMirrorStatus     from "./tanda/InternalShadowMirrorStatus";
// P11-7 — Shopify Refunds reports panel.
import InternalShopifyRefunds         from "./tanda/InternalShopifyRefunds";
// P11 — Connect Shopify Store (encrypted token; enables sync + image pull).
import InternalShopifyStores          from "./tanda/InternalShopifyStores";
// Tangerine P12-99 — Marketplaces status panel (Shopify / FBA / Walmart / Faire dashboard).
import InternalMarketplaceStatus      from "./tanda/InternalMarketplaceStatus";
// Cross-cutter T11-3 — Universal audit log admin panel (🕒 Audit nav group).
import InternalAuditLog                from "./tanda/InternalAuditLog";
// P14-3b — RBAC User Access admin panel (🔐 Admin nav group).
import InternalUserAccess              from "./tanda/InternalUserAccess";
// P14-4 — client menu hide driven by the caller's effective permissions.
import { useEffectivePermissions } from "./hooks/useEffectivePermissions";
import { rbacModuleForTangerine } from "./lib/rbacModuleMap";
// M31 — surface the standalone Planning app inside the Tangerine shell; gate by
// the shared PLM per-app permission (`permissions.planning.access`, default-true).
import { canAccessAppFromSession } from "./permissions";
// Cross-cutter T4-3 — Personalization favorites drawer (legacy, kept for other apps).
import FavoritesMenu from "./components/FavoritesMenu";
// Navigation drawer — replaces the horizontal TopNav.
import { NavDrawer, DRAWER_W_OPEN, DRAWER_W_CLOSED } from "./tanda/NavDrawer";
// Tangerine P10-5 — Top-bar entity switcher (visible when caller has ≥2 entities).
import EntitySwitcher from "./components/EntitySwitcher";
import BrandChannelSwitcher from "./components/BrandChannelSwitcher";
// Cross-cutter T4-4 — Auto-landing redirect to operator's home_route.
import AutoLandingToast from "./components/AutoLandingToast";
import { useAutoLanding } from "./hooks/useAutoLanding";
import InternalCommissionAccruals      from "./tanda/InternalCommissionAccruals";
import InternalCommissionPayouts       from "./tanda/InternalCommissionPayouts";
// Nav-reachable scorecard entry points (wrap the existing drill-through modals).
import InternalVendorScorecard         from "./tanda/InternalVendorScorecard";
import InternalCustomerScorecard       from "./tanda/InternalCustomerScorecard";
// #983 — surface 26 built-but-unmenued panels (Treasury, ESG & Compliance,
// Workflow, Reports analytics, RFQs, Marketplaces, Admin entities/onboarding).
import InternalPayments               from "./tanda/InternalPayments";
import InternalReconciliationDashboard from "./tanda/InternalReconciliationDashboard";
import InternalFx                     from "./tanda/InternalFx";
import InternalVirtualCards           from "./tanda/InternalVirtualCards";
import InternalScf                    from "./tanda/InternalScf";
import InternalDiscountOffers         from "./tanda/InternalDiscountOffers";
import InternalTax                    from "./tanda/InternalTax";
import InternalRfqs                   from "./tanda/InternalRfqs";
import InternalAnalytics              from "./tanda/InternalAnalytics";
import InternalInsights               from "./tanda/InternalInsights";
import InternalAnomalies              from "./tanda/InternalAnomalies";
import InternalBenchmark              from "./tanda/InternalBenchmark";
import InternalHealthScores           from "./tanda/InternalHealthScores";
import InternalPreferred              from "./tanda/InternalPreferred";
import InternalSustainability         from "./tanda/InternalSustainability";
import InternalEsgScores              from "./tanda/InternalEsgScores";
import InternalDiversity              from "./tanda/InternalDiversity";
import InternalComplianceAudit        from "./tanda/InternalComplianceAudit";
import InternalComplianceAutomation   from "./tanda/InternalComplianceAutomation";
import InternalWorkflowRules          from "./tanda/InternalWorkflowRules";
import InternalWorkflowExecutions     from "./tanda/InternalWorkflowExecutions";
import InternalWorkspaces             from "./tanda/InternalWorkspaces";
import InternalMarketplace            from "./tanda/InternalMarketplace";
import InternalMarketplaceInquiries   from "./tanda/InternalMarketplaceInquiries";
import InternalEntities               from "./tanda/InternalEntities";
import InternalOnboarding             from "./tanda/InternalOnboarding";
import InternalApiKeys                from "./tanda/InternalApiKeys";
import { clearMsTokens, getMsAccessToken, loadMsTokens, msSignIn } from "./utils/msAuth";
import { setCachedAuthUserId, setCachedAuthUserEmail, setCachedAuthUserName, setCachedAuthJwt } from "./utils/tangerineAuthUser";
import { appConfig } from "./config/env";
import { GlobalSearchPaletteAuto } from "./components/GlobalSearchPalette";
import { AskAIPanel } from "./ai/AskAIPanel";
import type { GridContextSnapshot } from "./ai/tools";

// Module registry + palette extracted to src/erp/ (Tangerine.tsx shrink).
import { C } from "./erp/theme";
import {
  MODULES, NAV_SECTIONS, GROUP_ICON, APPS, PLANNING_SCREENS,
} from "./erp/modules";
import type { ModuleKey, GroupKey, ModuleDef, AppLink } from "./erp/modules";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
type AuthState = "loading" | "signed_out" | "signed_in";

// ── PLM-session fallback identity ────────────────────────────────────────────
// The PLM launcher (PLM.tsx) signs the operator in once with username/password
// and writes the user blob to sessionStorage.plm_user, which is cloned into the
// app tab on launch. Tangerine's primary identity is a Microsoft-365 token, but
// when an already-PLM-authenticated user opens Tangerine from the launcher and
// has no MS token yet, we must NOT prompt them for a SECOND sign-in. Instead we
// adopt the PLM session identity (default-true access; the /tangerine route
// guard in main.tsx already blocked anyone with tangerine.access=false). The
// MS-only features (Graph photo + per-user JWT provisioning) degrade exactly as
// they already do when provisioning fails — both are best-effort/non-fatal, and
// the internal API stays fail-open on the static deploy token. See
// project_two_permission_systems + project_app_no_relogin_g.
function readPlmSessionIdentity(): { email: string | null; name: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem("plm_user");
    if (!raw) return null;
    const u = JSON.parse(raw) as { email?: string; name?: string; username?: string };
    if (!u) return null;
    const email = (u.email || "").trim() || null;
    const name = (u.name || "").trim() || (u.username || "").trim() || email;
    // Require at least one human identifier so we don't "sign in" on a junk blob.
    if (!email && !name) return null;
    return { email, name: name || null };
  } catch {
    return null;
  }
}

// P27 4c — cross-tab sign-out bus. One tab signing out broadcasts here so every
// other open Tangerine tab tears down its session too (the httpOnly JWT cookie
// is already cleared server-side, which is global, but this makes the UI in
// sibling tabs redirect immediately instead of lingering on stale state).
const AUTH_CHANNEL = "tangerine-auth";
function broadcastSignOut() {
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const ch = new BroadcastChannel(AUTH_CHANNEL);
      ch.postMessage("signout");
      ch.close();
    }
  } catch { /* best-effort */ }
}

// Clear every client-side trace of the session (both auth systems). Shared by the
// explicit sign-out and the cross-tab listener.
function localSignOutCleanup() {
  clearMsTokens();
  setCachedAuthJwt(null);
  setCachedAuthUserEmail(null);
  setCachedAuthUserName(null);
  setCachedAuthUserId(""); // empty → removes the cached id keys
  try {
    sessionStorage.removeItem("plm_user");
    sessionStorage.removeItem("rof_notif_dismissed_internal");
  } catch { /* ignore */ }
}

// Provision the MS→Supabase identity and cache the per-user app JWT. Shared by
// the initial sign-in AND the P27 Phase 4 silent-refresh timer. Best-effort:
// never throws (a provision blip must not break a working session — the
// X-Auth-User-Id stopgap keeps per-user reads alive). Returns true on a mint.
async function provisionWithMsToken(token: string): Promise<boolean> {
  try {
    const pr = await fetch("/api/internal/auth/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ms_access_token: token }),
    });
    if (!pr.ok) {
      console.warn("[Tangerine] auth provision non-OK:", pr.status, await pr.text().catch(() => ""));
      return false;
    }
    const j = await pr.json();
    if (j?.auth_user_id) {
      setCachedAuthUserId(j.auth_user_id);
      // Per-user JWT (present only when SUPABASE_JWT_SECRET is set server-side);
      // internalApiAuth attaches it as Authorization: Bearer on /api/internal calls.
      setCachedAuthJwt(j.access_token ?? null);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("[Tangerine] auth provision failed (non-fatal):", e);
    return false;
  }
}

export default function Tangerine() {
  // Cross-cutter T4-4 — auto-landing redirect to operator's home_route.
  // Fires once per tab session at app-shell root. See useAutoLanding.ts.
  const landing = useAutoLanding();
  // Deep-link / multi-tab support: `?m=<module_key>` drives activeModule so
  // opening ?m=journal_entries in a new tab lands directly on that panel.
  // Also accepts the legacy `?view=` param written by COA click-throughs etc.
  // Read on initial mount; subsequent navigation uses goToModule() below.
  const [aiOpen, setAiOpen] = useState(false);

  // Navigation drawer collapsed state (persisted in localStorage).
  const [drawerCollapsed, setDrawerCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("tangerine:nav:collapsed:v1") === "1"; }
    catch { return false; }
  });
  const toggleDrawer = () => {
    setDrawerCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("tangerine:nav:collapsed:v1", next ? "1" : "0"); } catch {}
      return next;
    });
  };

  // Publish the live NavDrawer width as a CSS var so descendant panels/modals
  // can clear the drawer (`left: var(--tng-nav-offset)`) without threading the
  // drawer state down as a prop — e.g. the Inventory Matrix drill modals, which
  // otherwise centre over the full viewport and slide under the drawer (#24).
  useEffect(() => {
    const w = drawerCollapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN;
    try { document.documentElement.style.setProperty("--tng-nav-offset", `${w}px`); } catch { /* noop */ }
  }, [drawerCollapsed]);

  const [activeModule, setActiveModule] = useState<ModuleKey | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get("m") ?? sp.get("view");
      return v && (MODULES as { key: string }[]).some((m) => m.key === v)
        ? (v as ModuleKey)
        : null;
    } catch {
      return null;
    }
  });

  // ── URL sync helpers ──────────────────────────────────────────────────────
  // goToModule: single call-site that updates both React state and the browser
  // URL (?m=<key> or clear when null). Use pushState so back/forward work.
  function goToModule(key: ModuleKey | null) {
    setActiveModule(key);
    const url = new URL(window.location.href);
    if (key) {
      url.searchParams.set("m", key);
    } else {
      url.searchParams.delete("m");
    }
    // Also remove legacy ?view= if present, to keep the URL tidy.
    url.searchParams.delete("view");
    window.history.pushState({ module: key }, "", url.toString());
  }

  // popstate: handle browser back / forward buttons.
  useEffect(() => {
    function onPopState() {
      try {
        const sp = new URLSearchParams(window.location.search);
        const v = sp.get("m") ?? sp.get("view");
        const resolved =
          v && (MODULES as { key: string }[]).some((m) => m.key === v)
            ? (v as ModuleKey)
            : null;
        setActiveModule(resolved);
      } catch {
        setActiveModule(null);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser tab title = the active module's menu header, so every tab opened
  // via the menu (or a ?m= deep link) is identifiable at a glance. Falls back
  // to the app name on the home landing.
  useEffect(() => {
    const label = activeModule
      ? (MODULES as { key: string; label: string }[]).find((m) => m.key === activeModule)?.label
      : null;
    document.title = label ? `${label} · Tangerine` : "Tangerine ERP";
  }, [activeModule]);

  const [appsOpen, setAppsOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  // Chunk I item 1 — display name shown in the top bar (falls back to email).
  const [userName, setUserName] = useState<string | null>(null);
  // Optional MS Graph profile photo (object URL). Null → initials avatar.
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);

  // Auth gate: on mount, check for an MS token. If present + non-expired, fetch
  // the signed-in user's email from Graph (User.Read is already in MS_SCOPES).
  // No token → render the branded login screen.
  useEffect(() => {
    let cancelled = false;
    // Adopt the PLM-launcher session as Tangerine's identity when there is no
    // usable MS token. Returns true if it signed the user in (so callers can
    // stop), false if there is no PLM session either (→ show the MS login).
    function fallbackToPlmSession(): boolean {
      const plm = readPlmSessionIdentity();
      // P27 Phase 3 — when the Suite SSO front door is ON, do NOT silently adopt
      // the PLM session: require a Microsoft sign-in (it mints the per-user JWT +
      // provisions identity by email). The signed-out screen still offers the PLM
      // session as an explicit break-glass link, so an Entra outage can't lock
      // anyone out. OFF (default) → today's no-relogin behavior is unchanged.
      if (!plm || appConfig.suiteSsoFrontDoor) {
        if (!cancelled) setAuthState("signed_out");
        return false;
      }
      if (cancelled) return true;
      setUserEmail(plm.email);
      setUserName(plm.name);
      setCachedAuthUserEmail(plm.email);
      setCachedAuthUserName(plm.name);
      setAuthState("signed_in");
      return true;
    }
    (async () => {
      const tokens = loadMsTokens();
      if (!tokens) {
        // No MS token. A user who already signed into the PLM launcher should
        // open Tangerine directly — fall back to that session instead of a
        // redundant second (Microsoft) sign-in prompt.
        fallbackToPlmSession();
        return;
      }
      try {
        const token = await getMsAccessToken();
        if (cancelled) return;
        if (!token) {
          fallbackToPlmSession();
          return;
        }
        const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`Graph /me HTTP ${r.status}`);
        const me = await r.json();
        if (cancelled) return;
        const resolvedEmail = me.mail || me.userPrincipalName || me.displayName || null;
        setUserEmail(resolvedEmail);
        // Chunk I item 1 — prefer the human display name in the header; fall
        // back to the email when Graph returns no displayName.
        const resolvedName = me.displayName || resolvedEmail;
        setUserName(resolvedName);
        // Cache the email snapshot so panels that need it for audit/notes
        // (e.g. Style Master notes log) can read it without re-querying Graph.
        setCachedAuthUserEmail(resolvedEmail);
        setCachedAuthUserName(resolvedName);
        setAuthState("signed_in");

        // Best-effort MS Graph profile photo for the nav avatar. Failure
        // (no photo set / 404) silently falls back to the initials avatar.
        (async () => {
          try {
            const pr = await fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!pr.ok) return;
            const blob = await pr.blob();
            if (cancelled) return;
            setUserPhotoUrl(URL.createObjectURL(blob));
          } catch { /* initials fallback */ }
        })();

        // Bridge MS OAuth → Supabase Auth. Best-effort: a provision blip must
        // not block login (the X-Auth-User-Id stopgap keeps per-user reads
        // alive). First call creates auth.users + entity_users + links the
        // employee; subsequent calls are idempotent. The Phase 4 timer below
        // re-runs this periodically so the 12h JWT never silently expires.
        await provisionWithMsToken(token);
      } catch (err) {
        console.error("[Tangerine] auth check failed:", err);
        // MS token present but Graph/enrichment failed — don't force a re-login
        // if the operator already holds a PLM session; adopt it instead.
        fallbackToPlmSession();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // P27 4c — listen for a sign-out from any sibling tab and tear down here too.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(AUTH_CHANNEL);
    ch.onmessage = (e) => {
      if (e?.data === "signout") {
        localSignOutCleanup();
        window.location.assign("/");
      }
    };
    return () => { try { ch.close(); } catch { /* noop */ } };
  }, []);

  // P27 Phase 4 — silent app-JWT refresh. The per-user JWT is a 12h token; if a
  // tab stays open past expiry it 401s per-user endpoints (the original favorites
  // / audit breakage) and RBAC can't verify the caller. While signed in WITH a
  // Microsoft session, every few hours silently re-acquire the MS token (MSAL
  // handles the refresh) and re-provision to mint a fresh JWT. No-op for PLM-only
  // sessions (no MS token to refresh — those rely on the X-Auth-User-Id stopgap).
  useEffect(() => {
    if (authState !== "signed_in") return;
    if (!loadMsTokens()) return;
    const REFRESH_MS = 4 * 60 * 60 * 1000; // 4h ≪ the 12h JWT lifetime → always fresh
    const id = setInterval(() => {
      void (async () => {
        const t = await getMsAccessToken();
        if (t) await provisionWithMsToken(t);
      })();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [authState]);

  // P27 Phase 3 break-glass — adopt the PLM-launcher session as Tangerine identity
  // without a Microsoft sign-in. Only surfaced on the login screen when the SSO
  // front door is ON and a PLM session exists (e.g. an Entra outage).
  function adoptPlmSession() {
    const plm = readPlmSessionIdentity();
    if (!plm) return;
    setUserEmail(plm.email);
    setUserName(plm.name);
    setCachedAuthUserEmail(plm.email);
    setCachedAuthUserName(plm.name);
    setAuthState("signed_in");
  }

  async function handleSignIn() {
    try {
      await msSignIn();
      // Re-run the auth check by reloading; simpler than re-deriving state.
      window.location.reload();
    } catch (err) {
      console.error("[Tangerine] sign-in failed:", err);
      notify("Sign-in failed. See console for details.", "error");
    }
  }

  async function handleSignOut() {
    if (!(await confirmDialog("Sign out? You'll return to the login screen.", { title: "Sign out", icon: "", confirmText: "Sign out" }))) return;
    // Full sign-out across BOTH internal auth systems. Clearing only the MS
    // tokens + cached JWT and reloading was a no-op refresh: the no-relogin
    // path (see project_app_no_relogin_g) re-adopts the still-present PLM
    // session (sessionStorage.plm_user) on mount and signs the user straight
    // back in. So we also drop the PLM session and leave Tangerine for the
    // launcher, which shows the login form when there's no session.
    // P27 4b — also clear the httpOnly JWT cookie server-side (JS can't delete it).
    try { await fetch("/api/internal/auth/signout", { method: "POST" }); } catch { /* best-effort */ }
    localSignOutCleanup();
    broadcastSignOut(); // 4c — sign sibling tabs out too
    // Navigate away (not reload) → the PLM launcher at "/" with no session
    // renders the sign-in form. A reload would re-enter via the fallback.
    window.location.assign("/");
  }

  if (authState === "loading") {
    return (
      <div style={{ background: C.bg, color: C.textMuted, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
        Checking authentication…
      </div>
    );
  }

  if (authState === "signed_out") {
    // Break-glass only when the SSO front door is on AND a PLM session is present.
    const plmBreakGlass = appConfig.suiteSsoFrontDoor && readPlmSessionIdentity() != null
      ? adoptPlmSession : undefined;
    return <LoginScreen onSignIn={handleSignIn} onUseLauncherSession={plmBreakGlass} />;
  }

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <WarnHost />
      <StyleGalleryHost />
      <NavDrawer
        activeModule={activeModule}
        onSelectModule={(k) => goToModule(k as ModuleKey | null)}
        userEmail={userEmail}
        userName={userName}
        userPhotoUrl={userPhotoUrl}
        onSignOut={handleSignOut}
        modules={MODULES}
        sections={NAV_SECTIONS}
        groupIcons={GROUP_ICON}
        collapsed={drawerCollapsed}
        onToggleCollapsed={toggleDrawer}
      />

      {/* Slim top bar — anchored left of the drawer, holds entity/brand pickers.
          z:150 sits above content but below the sidebar (z:200) and modals. */}
      <div style={{
        position: "fixed", top: 0, right: 0,
        left: drawerCollapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN,
        height: 40, zIndex: 150,
        display: "flex", alignItems: "center", justifyContent: "flex-end",
        gap: 8, padding: "0 16px",
        background: "#0b1220", borderBottom: "1px solid rgba(255,255,255,0.08)",
        transition: "left 0.2s ease",
      }}>
        <EntitySwitcher inline />
        <button
          type="button"
          onClick={() => setAiOpen(v => !v)}
          title="Ask AI — questions about your data or how to use Tangerine"
          style={{
            background: "#1E293B", color: "#F1F5F9", border: "1px solid #334155",
            borderRadius: 8, padding: "6px 8px", fontSize: 12, fontWeight: 600,
            cursor: "pointer", whiteSpace: "nowrap",
            ...(aiOpen ? { borderColor: "#7C3AED", color: "#c4b5fd" } : {}),
          }}
        >Ask AI</button>
        <BrandChannelSwitcher inline />
      </div>

      <main style={{
        marginLeft: drawerCollapsed ? DRAWER_W_CLOSED : DRAWER_W_OPEN,
        transition: "margin-left 0.2s ease",
        padding: "24px 32px",
        paddingTop: 64,
        minHeight: "100vh",
        boxSizing: "border-box",
      }}>
        {activeModule === null && <HomeLanding onSelectModule={goToModule} />}
        {activeModule === "style_master"    && <InternalStyleMaster />}
        {activeModule === "pim_catalog"     && <InternalPimProductCatalog />}
        {activeModule === "fabric_codes"    && <InternalFabricCodes />}
        {activeModule === "vendor_master"   && <InternalVendorMaster />}
        {activeModule === "customer_master" && <InternalCustomerMaster />}
        {activeModule === "payment_terms"   && <InternalPaymentTerms />}
        {activeModule === "countries"            && <InternalCountries />}
        {activeModule === "genders"              && <InternalGenders />}
        {activeModule === "style_classifications" && <InternalStyleClassifications />}
        {activeModule === "factors"              && <InternalFactors />}
        {activeModule === "size_scales"          && <InternalSizeScales />}
        {activeModule === "season_master"        && <InternalSeasonMaster />}
        {activeModule === "color_master"         && <InternalColorMaster />}
        {activeModule === "fabric_mill_master"    && <InternalFabricMillMaster />}
        {activeModule === "part_master"           && <InternalPartMaster />}
        {activeModule === "service_item_master"   && <InternalServiceItemMaster />}
        {activeModule === "part_type_master"      && <InternalPartTypeMaster />}
        {activeModule === "part_inventory"        && <InternalPartInventory />}
        {activeModule === "mfg_bom"               && <InternalMfgBom />}
        {activeModule === "mfg_build_orders"      && <InternalMfgBuildOrders />}
        {activeModule === "mfg_reports"           && <InternalMfgReports />}
        {activeModule === "rma_reason_master"    && <InternalRmaReasonMaster />}
        {activeModule === "adjustment_type_master" && <InternalAdjustmentTypeMaster />}
        {activeModule === "date_preset_master" && <InternalDatePresetMaster />}
        {activeModule === "adjustment_reason_master" && <InternalAdjustmentReasonMaster />}
        {activeModule === "transfer_reason_master" && <InternalTransferReasonMaster />}
        {activeModule === "warehouse_master"     && <InternalWarehouseMaster />}
        {activeModule === "carrier_master"       && <InternalCarrierMaster />}
        {activeModule === "buyer_scope_master"   && <InternalBuyerScopeMaster />}
        {activeModule === "hts_master"           && <InternalHtsMaster />}
        {activeModule === "b2b_accounts"         && <InternalB2BAccounts />}
        {activeModule === "b2b_price_list"       && <InternalPriceLists />}
        {activeModule === "pricing_promotions"   && <InternalPromotions />}
        {activeModule === "gl_accounts"       && <InternalCOA />}
        {activeModule === "gl_periods"        && <InternalPeriods />}
        {activeModule === "journal_entries"   && <InternalJournalEntry />}
        {activeModule === "ap_invoices"       && <InternalAPInvoices />}
        {activeModule === "ap_payments"       && <InternalAPPayments />}
        {activeModule === "ar_invoices"       && <InternalARInvoices />}
        {activeModule === "ar_receipts"       && <InternalARReceipts />}
        {activeModule === "sales_orders"      && <InternalSalesOrders />}
        {activeModule === "sales_allocations" && <InternalAllocations />}
        {activeModule === "sales_returns" && <InternalSalesReturns />}
        {activeModule === "drop_ship" && <InternalDropShip />}
        {activeModule === "three_pl" && <InternalThreePL />}
        {activeModule === "three_pl_recon" && <InternalThreePLRecon />}
        {activeModule === "edi" && <InternalEDI />}
        {activeModule === "edi_customers" && <InternalEdiCustomers />}
        {activeModule === "edi_settings" && <InternalEdiSettings />}
        {activeModule === "reports_hub" && <InternalReportsHub />}
        {activeModule === "fixed_assets" && <InternalFixedAssets />}
        {activeModule === "budgets" && <InternalBudgets />}
        {activeModule === "form_1099" && <InternalForm1099 />}
        {activeModule === "purchase_orders"   && <InternalPurchaseOrders />}
        {activeModule === "receiving"         && <InternalReceiving />}
        {activeModule === "bookkeeper_approval" && <InternalBookkeeperApproval />}
        {activeModule === "qc_inspections"    && <InternalQCInspections />}
        {activeModule === "customs_entries"   && <InternalCustomsEntries />}
        {activeModule === "broker_invoices"   && <InternalBrokerInvoices />}
        {activeModule === "three_way_match"   && <InternalThreeWayMatch />}
        {activeModule === "procurement_recon" && <InternalProcurementRecon />}
        {activeModule === "ar_aging"          && <InternalARAging />}
        {activeModule === "ar_backfill"       && <InternalARBackfill />}
        {activeModule === "trial_balance"     && <InternalTrialBalance />}
        {activeModule === "income_statement"  && <InternalIncomeStatement />}
        {activeModule === "segment_pl"        && <InternalSegmentPL />}
        {activeModule === "balance_sheet"     && <InternalBalanceSheet />}
        {activeModule === "cash_flow"         && <InternalCashFlow />}
        {activeModule === "year_end_close"    && <InternalYearEndClose />}
        {activeModule === "bank_reconciliation" && <InternalBankReconciliation />}
        {activeModule === "bank_recon_report" && <InternalBankReconReport />}
        {activeModule === "factor_recon"      && <InternalFactorRecon />}
        {activeModule === "chargebacks"       && <InternalChargebacks />}
        {activeModule === "month_end_close"   && <InternalMonthEndClose />}
        {activeModule === "approval_rules"     && <InternalApprovalRules />}
        {activeModule === "approval_requests"  && <InternalApprovalRequests />}
        {activeModule === "notifications"      && <InternalNotificationCenter />}
        {activeModule === "notification_prefs" && <InternalNotificationPreferences />}
        {activeModule === "employees"          && <InternalEmployees />}
        {activeModule === "employee_titles"      && <InternalEmployeeTitles />}
        {activeModule === "employee_departments" && <InternalEmployeeDepartments />}
        {activeModule === "inventory_matrix"     && <InternalInventoryMatrix />}
        {activeModule === "prepack_matrices"     && <InternalPrepackMatrix />}
        {activeModule === "inventory_transfers" && <InternalInventoryTransfers />}
        {activeModule === "inventory_adjustments" && <InternalInventoryAdjustments />}
        {activeModule === "cycle_counts"        && <InternalCycleCounts />}
        {activeModule === "scanner_sessions"    && <InternalScannerSessions />}
        {activeModule === "cases"               && <InternalCases />}
        {/* P7-7 — Reports menu group */}
        {activeModule === "ap_aging"            && <InternalAPAging />}
        {activeModule === "sales_by_rep"        && <InternalSalesByRep />}
        {activeModule === "sales_by_customer"   && <InternalSalesByCustomer />}
        {activeModule === "gl_detail"           && <InternalGLDetail />}
        {activeModule === "upc_report"          && <InternalUpcReport />}
        {/* P8-3 — M25 CRM panels */}
        {activeModule === "crm_opportunities"   && <InternalCrmOpportunities />}
        {activeModule === "crm_activities"      && <InternalCrmActivities />}
        {activeModule === "crm_tasks"           && <InternalCrmTasks />}
        {activeModule === "crm_pipeline_report" && <InternalCrmPipelineReport />}
        {/* Cross-cutter T10-7 — Shadow Mirror Status dashboard */}
        {activeModule === "shadow_mirror"       && <InternalShadowMirrorStatus />}
        {/* P11-7 — Shopify Refunds reports panel */}
        {activeModule === "shopify_refunds"     && <InternalShopifyRefunds />}
        {/* P11 — Connect Shopify Store */}
        {activeModule === "shopify_stores"      && <InternalShopifyStores />}
        {/* Tangerine P12-99 — Marketplaces close-out status dashboard */}
        {activeModule === "marketplace_status"  && <InternalMarketplaceStatus />}
        {/* Cross-cutter T11-3 — Universal audit log admin panel */}
        {activeModule === "audit_log"           && <InternalAuditLog />}
        {activeModule === "commission_accruals"   && <InternalCommissionAccruals />}
        {activeModule === "commission_payouts"    && <InternalCommissionPayouts />}
        {activeModule === "vendor_scorecard"      && <InternalVendorScorecard />}
        {activeModule === "customer_scorecard"    && <InternalCustomerScorecard />}
        {/* P14-3b — RBAC User Access admin panel */}
        {activeModule === "user_access"            && <InternalUserAccess />}
        {/* #983 — Treasury */}
        {activeModule === "payments"               && <InternalPayments />}
        {activeModule === "recon_dashboard"        && <InternalReconciliationDashboard />}
        {activeModule === "fx"                      && <InternalFx />}
        {activeModule === "virtual_cards"          && <InternalVirtualCards />}
        {activeModule === "scf"                     && <InternalScf />}
        {activeModule === "discount_offers"        && <InternalDiscountOffers />}
        {activeModule === "tax"                     && <InternalTax />}
        {/* #983 — Procurement RFQs */}
        {activeModule === "rfqs"                    && <InternalRfqs />}
        {/* #983 — Reports analytics */}
        {activeModule === "analytics"              && <InternalAnalytics />}
        {activeModule === "insights"               && <InternalInsights />}
        {activeModule === "anomalies"              && <InternalAnomalies />}
        {activeModule === "benchmark"              && <InternalBenchmark />}
        {activeModule === "health_scores"          && <InternalHealthScores />}
        {activeModule === "preferred"              && <InternalPreferred />}
        {/* #983 — ESG & Compliance */}
        {activeModule === "sustainability"         && <InternalSustainability />}
        {activeModule === "esg_scores"             && <InternalEsgScores />}
        {activeModule === "diversity"              && <InternalDiversity />}
        {activeModule === "compliance_audit"       && <InternalComplianceAudit />}
        {activeModule === "compliance_automation"  && <InternalComplianceAutomation />}
        {/* #983 — Workflow */}
        {activeModule === "workflow_rules"         && <InternalWorkflowRules />}
        {activeModule === "workflow_executions"    && <InternalWorkflowExecutions />}
        {activeModule === "workspaces"             && <InternalWorkspaces />}
        {/* #983 — Marketplaces */}
        {activeModule === "marketplace"            && <InternalMarketplace />}
        {activeModule === "marketplace_inquiries"  && <InternalMarketplaceInquiries />}
        {/* #983 — Admin */}
        {activeModule === "entities"               && <InternalEntities />}
        {activeModule === "onboarding"             && <InternalOnboarding />}
        {/* M15 — External / Partner API key admin */}
        {activeModule === "api_keys"               && <InternalApiKeys />}
        {activeModule === "sync_health"            && <InternalSyncHealth />}
      </main>
      {/* EntitySwitcher + BrandChannelSwitcher moved to the slim top bar above. */}
      {/* Cross-cutter T6-3 — ⌘K / Ctrl-K global search palette. Reachable
          from any module; invisible until the hotkey fires. */}
      <GlobalSearchPaletteAuto />
      {/* Cross-cutter T4-4 — auto-landing redirect toast (bottom-right). */}
      <AutoLandingToast landing={landing} />

      <AskAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        appId="tangerine"
        setters={{}}
        buildContext={(): GridContextSnapshot => ({
          columns: [],
          active_filters: {},
          sort: null,
          row_count: 0,
          distinct: { categories: [], sub_categories: [], styles: [], genders: [], stores: [] },
          sample_rows: [],
        })}
        samplePrompts={[
          "What's our total open AR right now?",
          "How do I post a manual journal entry?",
          "Where is the fixed-asset register?",
          "List the open purchase orders by vendor",
          "What does GR/IR mean in receiving?",
        ]}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branded login screen — shown when no MS token is present. Tangerine logo +
// "Sign in with Microsoft" button + a brief framing. Mirrors the rest of the
// design-calendar-app suite: same MS OAuth flow, different branded entry.
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onSignIn, onUseLauncherSession }: { onSignIn: () => void; onUseLauncherSession?: () => void }) {
  return (
    <div
      style={{
        background: `radial-gradient(ellipse at top left, ${C.tangerineDim}33 0%, ${C.bg} 50%)`,
        color: C.text,
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: `linear-gradient(135deg, ${C.tangerine}, ${C.tangerineDim})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              fontWeight: 800,
              color: "white",
              boxShadow: `0 8px 24px ${C.tangerineDim}66`,
            }}
          >
            T
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: C.text }}>Tangerine</span>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 2 }}>ERP</span>
          </div>
        </div>

        <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>Sign in to continue</h1>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
          Tangerine is the ERP shell for the design-calendar-app PLM suite. Sign in with your work Microsoft account to access master data + accounting.
        </p>

        <button
          type="button"
          onClick={onSignIn}
          style={{
            width: "100%",
            background: "white",
            color: "#1f1f1f",
            border: 0,
            padding: "12px 16px",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
          </svg>
          Sign in with Microsoft
        </button>

        <p style={{ margin: "20px 0 0", fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>
          Uses the same Microsoft 365 account that signs you into the other PLM-suite apps (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning). The popup may be blocked by some browsers — allow pop-ups for this domain if it doesn't open.
        </p>

        {onUseLauncherSession && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.cardBdr}`, textAlign: "center" }}>
            <button
              type="button"
              onClick={onUseLauncherSession}
              style={{ background: "none", border: "none", color: C.textMuted, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
              title="Break-glass: continue with your existing launcher session instead of Microsoft (use only if Microsoft sign-in is unavailable)"
            >
              Continue with launcher session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu-item finder — type-ahead jump to any panel, sits in the nav bar next to
// the section dropdowns. Filters the permission-checked panel list by label;
// Enter selects the top hit, ↑/↓ navigate, Esc clears.
// ─────────────────────────────────────────────────────────────────────────────
interface SearchItem { key: ModuleKey; label: string; emoji: string; section: string; }

function MenuSearch({ items, onSelect }: { items: SearchItem[]; onSelect: (k: ModuleKey) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    // Match panel LABELS first. Only fall back to section-name matching when no
    // label matches at all — otherwise typing a word that also appears in a
    // section name (e.g. "Master" → the "Master Data" group) flooded the list
    // with every panel in that section. Within label hits, rank exact > prefix
    // > substring so the closest panel surfaces at the top.
    const labelHits = items.filter((it) => it.label.toLowerCase().includes(term));
    const base = labelHits.length > 0
      ? labelHits
      : items.filter((it) => it.section.toLowerCase().includes(term)); // jump by section name
    const rank = (it: SearchItem) => {
      const l = it.label.toLowerCase();
      if (l === term) return 0;
      if (l.startsWith(term)) return 1;
      return 2;
    };
    return [...base]
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
      .slice(0, 12);
  }, [q, items]);

  function choose(k: ModuleKey) { onSelect(k); setQ(""); setOpen(false); setHi(0); }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setQ(""); setOpen(false); return; }
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[hi] || results[0]; if (r) choose(r.key); }
  }

  return (
    <div ref={ref} style={{ position: "relative", marginLeft: 12 }}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => { if (q.trim()) setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder="Find a panel…"
        aria-label="Find a panel"
        style={{
          background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
          borderRadius: 6, padding: "6px 10px", fontSize: 13, outline: "none",
          // Shrinks on narrow viewports (down to a usable 140px) so it never
          // forces the bar to overflow, but caps at 200px on wide screens.
          width: "clamp(140px, 14vw, 200px)",
        }}
      />
      {open && results.length > 0 && (
        <div
          role="listbox"
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, minWidth: 280,
            background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 6, zIndex: 70,
            display: "flex", flexDirection: "column", gap: 2, maxHeight: 360, overflowY: "auto",
          }}
        >
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(r.key)}
              style={{
                background: i === hi ? "rgba(59, 130, 246, 0.14)" : "transparent",
                border: 0, color: i === hi ? C.text : C.textSub, padding: "8px 10px",
                borderRadius: 4, fontSize: 13, cursor: "pointer", textAlign: "left",
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <span style={{ width: 18, display: "inline-block" }}>{r.emoji}</span>
              <span style={{ flex: 1 }}>{r.label}</span>
              <span style={{ fontSize: 10, color: C.textMuted }}>{r.section}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Top nav
// ─────────────────────────────────────────────────────────────────────────────
interface TopNavProps {
  activeModule: ModuleKey | null;
  onSelectModule: (m: ModuleKey) => void;
  appsOpen: boolean;
  onToggleApps: () => void;
  onCloseApps: () => void;
  onGoHome: () => void;
  userEmail: string | null;
  userName: string | null;
  userPhotoUrl?: string | null;
  onSignOut: () => void;
}

// Item 12 — is a modal/popup currently open in this tab? The Internal* panels
// render a full-screen fixed backdrop (position:fixed; inset:0; translucent
// dark background; high z-index). When one is open we open the next module in a
// NEW tab so the in-progress modal isn't lost; otherwise we navigate normally
// in the same tab. Clicks are rare, so a one-off DOM scan is fine.
function isModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  const nodes = document.querySelectorAll("div");
  for (let i = 0; i < nodes.length; i++) {
    const s = window.getComputedStyle(nodes[i]);
    if (
      s.position === "fixed" &&
      s.top === "0px" && s.left === "0px" && s.right === "0px" && s.bottom === "0px" &&
      parseInt(s.zIndex || "0", 10) >= 50
    ) {
      const bg = s.backgroundColor || "";
      const transparent = bg === "" || bg === "transparent" || /,\s*0\)\s*$/.test(bg);
      if (!transparent) return true; // a translucent full-screen backdrop = an open modal
    }
  }
  return false;
}

// Derive 1–2 uppercase initials from a display name (preferred) or email.
// "Eran Bitton" → "EB"; "eran@x.com" → "E". Empty string → "?".
function deriveInitials(name?: string | null, email?: string | null): string {
  const src = (name || "").trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  const e = (email || "").trim();
  if (e) return e[0].toUpperCase();
  return "?";
}

// Deterministic background colour from the avatar seed so each user keeps a
// stable swatch across reloads (no random flicker).
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const palette = ["#3B82F6", "#fb923c", "#10B981", "#8B5CF6", "#EC4899", "#F59E0B", "#06B6D4", "#EF4444"];
  return palette[h % palette.length];
}

// Small circular user avatar: photo if supplied, else initials on a colour.
function UserAvatar({ name, email, photoUrl }: { name?: string | null; email?: string | null; photoUrl?: string | null }) {
  const size = 28;
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name || email || "User"}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  const initials = deriveInitials(name, email);
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        background: avatarColor(name || email || ""),
        color: "#fff", fontSize: 11, fontWeight: 700,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        letterSpacing: 0.5, userSelect: "none",
      }}
    >
      {initials}
    </span>
  );
}

function TopNav({ activeModule, onSelectModule, appsOpen, onToggleApps, onCloseApps, onGoHome, userEmail, userName, userPhotoUrl, onSignOut }: TopNavProps) {
  // Group-dropdown nav: hover the group → opens its menu; mouse leaves the
  // group container (button + dropdown) → closes immediately. openGroup is
  // also driven by click (keyboard / accessibility fallback) and Esc.
  const [openGroup, setOpenGroup] = useState<string | null>(null); // open SECTION name
  // Which sub-group's items show in the open section's flyout pane.
  const [hoverSub, setHoverSub] = useState<GroupKey | null>(null);
  // hoveredKey: per-dropdown highlighted item, drives the row background.
  const [hoveredKey, setHoveredKey] = useState<ModuleKey | null>(null);
  // P14-4 — hide nav items the caller lacks :read on. Inert (shows all) unless
  // RBAC_MODE=enforce on the server; see useEffectivePermissions.
  const { can } = useEffectivePermissions();

  // Hover-menu close debouncing. The absolute-positioned dropdown sits 4px
  // below the button — when the mouse traverses that gap on its way into
  // the menu, it briefly leaves the parent div's bounding box (absolutely
  // positioned children don't extend the parent's layout box). Without a
  // delay, that fires onMouseLeave and closes the menu before the cursor
  // reaches an item. A 140ms scheduled close lets the cursor land on the
  // dropdown (which cancels the timer via its own onMouseEnter) before the
  // close fires.
  const closeTimerRef = useRef<number | null>(null);
  function cancelClose() {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }
  function scheduleClose() {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpenGroup(null);
      setHoveredKey(null);
      closeTimerRef.current = null;
    }, 140);
  }
  useEffect(() => () => cancelClose(), []);

  // Close on Esc.
  useEffect(() => {
    if (openGroup == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { cancelClose(); setOpenGroup(null); setHoveredKey(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGroup]);

  // Auto-close after selection.
  function handleSelect(m: ModuleKey) {
    cancelClose();
    setOpenGroup(null);
    setHoveredKey(null);
    onSelectModule(m);
  }

  // Flat, permission-filtered list of every panel for the menu-item finder,
  // each tagged with its section label for context in the results.
  const searchItems = useMemo<SearchItem[]>(() => {
    const sectionOf = (g: GroupKey): string =>
      NAV_SECTIONS.find((s) => s.groups.includes(g))?.section ?? "";
    return MODULES
      .filter((m) => can(rbacModuleForTangerine(m.key), "read"))
      .map((m) => ({ key: m.key, label: m.label, emoji: m.emoji, section: sectionOf(m.group) }));
  }, [can]);

  return (
    <header
      style={{
        background: "#0b1220",
        borderBottom: `1px solid ${C.cardBdr}`,
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        // Allow the row to tighten its inter-item gap as width shrinks, with a
        // sane floor, so the whole bar fits common widths (1280–1920) without a
        // horizontal page scrollbar. The group-dropdown <nav> is the flex/wrap
        // element that absorbs the slack (see below); Favorites, Find-a-panel,
        // Apps and the user/avatar stay fixed and always visible.
        gap: "clamp(8px, 1vw, 20px)",
        minWidth: 0,
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <button
        type="button"
        onClick={onGoHome}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          padding: 0,
          color: C.text,
        }}
        title="Back to Tangerine home"
      >
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: `linear-gradient(135deg, ${C.tangerine}, ${C.tangerineDim})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
            fontWeight: 800,
            color: "white",
          }}
        >
          T
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.1 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Tangerine</span>
          <span style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>ERP</span>
        </div>
      </button>

      {/* Favorites — first action icon (consistent across all apps). */}
      <FavoritesMenu />

      {/* Menu-item finder — type-ahead jump to any panel, positioned right after
          Favorites (separate from the section dropdowns). Respects the same
          permission filter. flexShrink:0 keeps it from being squeezed out when
          the group-dropdown row wraps/shrinks. */}
      <div style={{ flexShrink: 0 }}>
        <MenuSearch items={searchItems} onSelect={handleSelect} />
      </div>

      <nav style={{ display: "flex", flexWrap: "wrap", gap: 4, rowGap: 6, flex: 1, minWidth: 0, marginLeft: 20, alignItems: "center" }}>
        {NAV_SECTIONS.map((sec) => {
          // Sub-groups of this section that have at least one permitted module.
          const subGroups = sec.groups
            .map((g) => ({
              group: g,
              // Dropdown items are sorted ALPHABETICALLY by label (operator
              // request — Master Data + every other group) so destinations are
              // predictable to scan regardless of MODULES declaration order.
              modules: MODULES.filter((m) => m.group === g && can(rbacModuleForTangerine(m.key), "read"))
                .slice()
                .sort((a, b) => a.label.localeCompare(b.label)),
            }))
            .filter((sg) => sg.modules.length > 0);
          if (subGroups.length === 0) return null;

          const containsActive = subGroups.some((sg) => sg.modules.some((m) => m.key === activeModule));
          const isOpen = openGroup === sec.section;
          // The sub-group that shares the section's name is redundant with the
          // section trigger above (e.g. "Master Data" section → "Master Data"
          // group). Omit it from the left rail and make its modules the DEFAULT
          // pane, so the header isn't duplicated. The left rail lists only the
          // OTHER sub-categories (EDI, Reports, Approvals, …).
          const leftRailGroups = subGroups.filter((sg) => sg.group !== sec.section);
          const multi = subGroups.length > 1;
          // Pane to show: hovered → active-holding → the section-named group → first.
          const shown =
            subGroups.find((sg) => sg.group === hoverSub) ||
            subGroups.find((sg) => sg.modules.some((m) => m.key === activeModule)) ||
            subGroups.find((sg) => sg.group === sec.section) ||
            subGroups[0];

          return (
            <div
              key={sec.section}
              style={{ position: "relative" }}
              onMouseEnter={() => { cancelClose(); setOpenGroup(sec.section); setHoverSub(shown.group); }}
              onMouseLeave={() => scheduleClose()}
            >
              <button
                type="button"
                onClick={() => { setOpenGroup(isOpen ? null : sec.section); setHoverSub(shown.group); }}
                style={{
                  background: containsActive || isOpen ? C.card : "transparent",
                  border: `1px solid ${containsActive || isOpen ? C.cardBdr : "transparent"}`,
                  color: containsActive || isOpen ? C.text : C.textSub,
                  // Responsive: padding + gap tighten as the viewport narrows so
                  // every group button stays on the bar at common widths.
                  padding: "6px clamp(7px, 0.6vw, 12px)", borderRadius: 6,
                  fontSize: "clamp(12px, 0.85vw, 13px)", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: "clamp(4px, 0.4vw, 6px)",
                  whiteSpace: "nowrap",
                }}
                aria-haspopup="menu"
                aria-expanded={isOpen}
              >
                <span>{sec.section}</span>
                <span style={{ fontSize: 10 }}>{isOpen ? "▴" : "▾"}</span>
              </button>
              {isOpen && (
                <div
                  role="menu"
                  onMouseEnter={() => cancelClose()}
                  onMouseLeave={() => scheduleClose()}
                  style={{
                    position: "absolute", top: "100%", left: 0,
                    background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: 6, zIndex: 60,
                    display: "flex", gap: 4,
                  }}
                >
                  {/* Left rail: sub-group picker (only when >1 sub-group). */}
                  {multi && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 168, borderRight: `1px solid ${C.cardBdr}`, paddingRight: 6 }}>
                      {leftRailGroups.map((sg) => {
                        const isShown = sg.group === shown.group;
                        const hasActive = sg.modules.some((m) => m.key === activeModule);
                        return (
                          <button
                            key={sg.group}
                            type="button"
                            onMouseEnter={() => setHoverSub(sg.group)}
                            onFocus={() => setHoverSub(sg.group)}
                            style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                              background: isShown ? "#0b1220" : "transparent", border: 0,
                              color: hasActive ? "#60A5FA" : isShown ? C.textSub : C.textMuted,
                              padding: "14px 10px", borderRadius: 4, fontSize: 14, cursor: "pointer",
                              textAlign: "left", fontWeight: hasActive ? 700 : 500,
                            }}
                          >
                            <span>{sg.group}</span>
                            <span style={{ fontSize: 10, opacity: 0.6 }}>▸</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {/* Right pane: the shown sub-group's modules.
                      Item 12 (tightened) — plain left-click navigates IN THIS TAB
                      normally. BUT if a modal/popup is currently open, we open the
                      module in a NEW tab instead, so the in-progress modal is never
                      lost. cmd/ctrl/shift/middle-click always open a new tab
                      natively (href is present; we don't preventDefault those). */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 224 }}>
                    {shown.modules.map((m) => {
                      const active = activeModule === m.key;
                      const hovered = hoveredKey === m.key;
                      return (
                        <a
                          key={m.key}
                          href={`?m=${m.key}`}
                          rel="noreferrer"
                          role="menuitem"
                          onClick={(e) => {
                            // Modifier / non-primary clicks → let the browser open a
                            // new tab natively (href handles it).
                            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
                              cancelClose(); setOpenGroup(null); setHoveredKey(null);
                              return;
                            }
                            e.preventDefault();
                            cancelClose();
                            setOpenGroup(null);
                            setHoveredKey(null);
                            if (isModalOpen()) {
                              // Preserve the open modal in this tab — open elsewhere.
                              // No `noopener`: same-origin Tangerine route; noopener would
                              // give the new tab an empty sessionStorage and re-prompt MS login.
                              window.open(`?m=${m.key}`, "_blank");
                            } else {
                              onSelectModule(m.key); // normal same-tab navigation
                            }
                          }}
                          onMouseEnter={() => setHoveredKey(m.key)}
                          onMouseLeave={() => setHoveredKey((cur) => (cur === m.key ? null : cur))}
                          style={{
                            background: hovered ? "rgba(59, 130, 246, 0.14)" : active ? "#0b1220" : "transparent",
                            border: 0, color: hovered || active ? C.textSub : C.textMuted,
                            padding: "14px 12px", borderRadius: 4, fontSize: 14, cursor: "pointer",
                            textAlign: "left", display: "flex", alignItems: "center", gap: 8,
                            transition: "background 80ms ease, color 80ms ease",
                            textDecoration: "none",
                          }}
                        >
                          <span>{m.label}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onToggleApps}
          style={{
            background: appsOpen ? C.card : "transparent",
            border: `1px solid ${appsOpen ? C.cardBdr : C.cardBdr}`,
            color: C.text,
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 13,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
          aria-haspopup="menu"
          aria-expanded={appsOpen}
        >
          <span>Apps</span>
          <span style={{ fontSize: 10 }}>{appsOpen ? "▴" : "▾"}</span>
        </button>
        {appsOpen && <AppsLauncher onClose={onCloseApps} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: `1px solid ${C.cardBdr}`, marginLeft: 4, flexShrink: 0 }}>
        {(userName || userEmail) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={userEmail || userName || ""}>
            <UserAvatar name={userName} email={userEmail} photoUrl={userPhotoUrl} />
            <span style={{ color: C.text, fontWeight: 600, fontSize: 13, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {userName || userEmail}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onSignOut}
          style={{
            background: "transparent",
            border: `1px solid ${C.cardBdr}`,
            color: C.textSub,
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
          }}
          title="Sign out"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Apps launcher dropdown
// ─────────────────────────────────────────────────────────────────────────────
function AppsLauncher({ onClose }: { onClose: () => void }) {
  return (
    <>
      {/* Backdrop to close on outside click */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "transparent", zIndex: 50 }}
        aria-hidden
      />
      <div
        role="menu"
        style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          width: 380,
          background: C.card,
          border: `1px solid ${C.cardBdr}`,
          borderRadius: 10,
          padding: 12,
          zIndex: 100,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, padding: "0 4px" }}>
          Apps in the suite
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              target="_blank"
              rel="noopener"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                textDecoration: "none",
                color: C.text,
                background: "transparent",
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = C.cardBdr; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              title={a.description}
            >
              <span style={{ fontSize: 22 }}>{a.emoji}</span>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "normal", overflowWrap: "anywhere" }}>{a.description}</span>
              </div>
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home landing — shown when no module is active. Module cards + apps shortcut.
// ─────────────────────────────────────────────────────────────────────────────
function HomeLanding({ onSelectModule }: { onSelectModule: (m: ModuleKey) => void }) {
  // P14-4 — hide cards the caller lacks :read on. Inert unless RBAC_MODE=enforce.
  const { can } = useEffectivePermissions();
  const visibleModules = MODULES.filter((m) => can(rbacModuleForTangerine(m.key), "read"));
  const masterModules = visibleModules.filter((m) => m.group === "Master Data");
  const acctModules = visibleModules.filter((m) => m.group === "Accounting");
  const crmModules = visibleModules.filter((m) => m.group === "CRM");
  const reportsModules = visibleModules.filter((m) => m.group === "Reports");
  const approvalsModules = visibleModules.filter((m) => m.group === "Approvals");
  const notifModules = visibleModules.filter((m) => m.group === "Notifications");
  const hrModules = visibleModules.filter((m) => m.group === "HR");
  const inventoryModules = visibleModules.filter((m) => m.group === "Inventory");
  const vendorModules = visibleModules.filter((m) => m.group === "Vendors");
  const csModules = visibleModules.filter((m) => m.group === "Customer Service");
  const marketplacesModules = visibleModules.filter((m) => m.group === "Marketplaces");
  const mirrorModules = visibleModules.filter((m) => m.group === "Shadow Mirror");

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Tangerine ERP</h1>
        <p style={{ margin: "4px 0 0", color: C.textMuted, fontSize: 14 }}>
          The operating system for your PLM suite. Master data + accounting + integration to the apps you already use.
        </p>
      </div>

      <Section title="Master Data">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {masterModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Accounting">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {acctModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Vendors">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {vendorModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
          {/* External vendor-facing portal (separate Supabase auth) — open in a new tab. */}
          <ExternalLinkCard href="/vendor" label="Vendor Portal" emoji="" sublabel="External · new tab" />
          <ExternalLinkCard href="/vendor/onboarding" label="Vendor Onboarding" emoji="" sublabel="External · new tab" />
        </div>
      </Section>

      <Section title="CRM (P8)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {crmModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Reports (P7-7)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {reportsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Approvals (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {approvalsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Notifications (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {notifModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="HR (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {hrModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Inventory (P3)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {inventoryModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      {/* M31 — the standalone Planning app's screens as first-class deep links.
          Separate app (own shell, own Xoro/Shopify-backed data); opens in a new
          tab. Gated by the shared planning permission. */}
      {canAccessAppFromSession("planning") && (
        <Section title="Planning (M31)">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
            {PLANNING_SCREENS.map((s) => (
              <ExternalLinkCard key={s.href} href={s.href} label={s.label} emoji={s.emoji} sublabel={s.description} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Customer Service (P7)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {csModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Marketplaces (P11–P12)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {marketplacesModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Shadow Mirror (T10)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18 }}>
          {mirrorModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Other apps in the suite">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
              target="_blank"
              rel="noopener"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 14px",
                background: C.card,
                border: `1px solid ${C.cardBdr}`,
                borderRadius: 10,
                textDecoration: "none",
                color: C.text,
              }}
              title={a.description}
            >
              <span style={{ fontSize: 26 }}>{a.emoji}</span>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
                <span style={{ fontSize: 11, color: C.textMuted }}>{a.description}</span>
              </div>
            </a>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModuleCard({ module, onClick }: { module: ModuleDef; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: C.card,
        border: `1px solid ${C.cardBdr}`,
        borderRadius: 10,
        padding: 24,
        textAlign: "left",
        color: C.text,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        transition: "border-color 0.15s, transform 0.05s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.tangerine; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.cardBdr; }}
    >
      <div style={{ fontSize: 17, fontWeight: 600, color: C.textSub }}>{module.label}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{module.group}</div>
    </button>
  );
}

// External-link variant of ModuleCard: navigates to another app/route in a
// NEW TAB (mirrors the ATS link added to the Inventory Matrix). Used for the
// Vendor Portal + Vendor Onboarding entries, which live in the isolated
// /vendor app (separate Supabase auth) and so must open standalone.
function ExternalLinkCard({ href, label, emoji, sublabel }: { href: string; label: string; emoji: string; sublabel: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${label} — opens in a new tab`}
      style={{
        background: C.card,
        border: `1px solid ${C.cardBdr}`,
        borderRadius: 10,
        padding: 16,
        textAlign: "left",
        color: C.text,
        cursor: "pointer",
        textDecoration: "none",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 0.15s, transform 0.05s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.tangerine; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.cardBdr; }}
    >
      <div style={{ fontSize: 32 }}>{emoji}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 0 }}>{sublabel}</div>
    </a>
  );
}
