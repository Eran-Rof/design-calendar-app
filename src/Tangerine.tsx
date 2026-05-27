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

import { useEffect, useState } from "react";

import InternalStyleMaster        from "./tanda/InternalStyleMaster";
import InternalFabricCodes        from "./tanda/InternalFabricCodes";
import InternalVendorMaster       from "./tanda/InternalVendorMaster";
import InternalCustomerMaster     from "./tanda/InternalCustomerMaster";
import InternalPaymentTerms       from "./tanda/InternalPaymentTerms";
import InternalCOA                from "./tanda/InternalCOA";
import InternalPeriods            from "./tanda/InternalPeriods";
import InternalJournalEntry       from "./tanda/InternalJournalEntry";
import InternalAPInvoices         from "./tanda/InternalAPInvoices";
import InternalAPPayments         from "./tanda/InternalAPPayments";
import InternalApprovalRules           from "./tanda/InternalApprovalRules";
import InternalApprovalRequests        from "./tanda/InternalApprovalRequests";
import InternalNotificationCenter      from "./tanda/InternalNotificationCenter";
import InternalNotificationPreferences from "./tanda/InternalNotificationPreferences";
import InternalEmployees               from "./tanda/InternalEmployees";
import InternalInventoryTransfers      from "./tanda/InternalInventoryTransfers";
import InternalInventoryAdjustments    from "./tanda/InternalInventoryAdjustments";
import InternalScannerSessions         from "./tanda/InternalScannerSessions";
import { clearMsTokens, getMsAccessToken, loadMsTokens, msSignIn } from "./utils/msAuth";
import { setCachedAuthUserId } from "./utils/tangerineAuthUser";

// ─────────────────────────────────────────────────────────────────────────────
// Theme — match the dark Tanda palette so the admin panels (which use the
// same color constants) blend in.
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
  // Tangerine brand accent
  tangerine: "#fb923c",
  tangerineDim: "#c2410c",
};

// ─────────────────────────────────────────────────────────────────────────────
// Tangerine modules — the 6 admin panels shipped in P1 Chunks 7/7b/7c/8a/8b/8c
// ─────────────────────────────────────────────────────────────────────────────
type ModuleKey =
  | "style_master"
  | "fabric_codes"
  | "vendor_master"
  | "customer_master"
  | "payment_terms"
  | "gl_accounts"
  | "gl_periods"
  | "journal_entries"
  | "ap_invoices"
  | "ap_payments"
  | "approval_rules"
  | "approval_requests"
  | "notifications"
  | "notification_prefs"
  | "employees"
  | "inventory_transfers"
  | "inventory_adjustments"
  | "scanner_sessions";

type ModuleDef = {
  key: ModuleKey;
  label: string;
  emoji: string;
  group: "Master Data" | "Accounting" | "Approvals" | "Notifications" | "HR" | "Inventory" | "Operations";
};

const MODULES: ModuleDef[] = [
  { key: "style_master",      label: "Style Master",      emoji: "🎨", group: "Master Data" },
  { key: "fabric_codes",      label: "Fabric Codes",      emoji: "🧵", group: "Master Data" },
  { key: "vendor_master",     label: "Vendor Master",     emoji: "🏭", group: "Master Data" },
  { key: "customer_master",   label: "Customer Master",   emoji: "🤝", group: "Master Data" },
  { key: "payment_terms",     label: "Payment Terms",     emoji: "📆", group: "Master Data" },
  { key: "gl_accounts",       label: "Chart of Accounts", emoji: "📒", group: "Accounting" },
  { key: "gl_periods",        label: "Periods",           emoji: "🗓️", group: "Accounting" },
  { key: "journal_entries",   label: "Journal Entries",   emoji: "📓", group: "Accounting" },
  { key: "ap_invoices",       label: "AP Invoices",       emoji: "🧾", group: "Accounting" },
  { key: "ap_payments",       label: "AP Payments",       emoji: "💸", group: "Accounting" },
  { key: "approval_rules",    label: "Approval Rules",    emoji: "⚙️", group: "Approvals" },
  { key: "approval_requests", label: "Approval Inbox",    emoji: "✅", group: "Approvals" },
  { key: "notifications",     label: "Notifications",     emoji: "🔔", group: "Notifications" },
  { key: "notification_prefs",label: "Notif. Preferences",emoji: "🎚️", group: "Notifications" },
  { key: "employees",         label: "Employees",         emoji: "👥", group: "HR" },
  { key: "inventory_transfers", label: "Inventory Transfers", emoji: "🔁", group: "Inventory" },
  { key: "inventory_adjustments", label: "Inventory Adjustments", emoji: "📐", group: "Inventory" },
  { key: "scanner_sessions",  label: "Scanner Sessions",  emoji: "📱", group: "Operations" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Apps launcher — links to the other modules within the design-calendar-app
// suite. Each navigates the browser to the existing URL (same tab).
// ─────────────────────────────────────────────────────────────────────────────
type AppLink = { href: string; label: string; emoji: string; description: string };

const APPS: AppLink[] = [
  { href: "/",          label: "Design Calendar", emoji: "📅", description: "Calendar, tasks, collections" },
  { href: "/tanda",     label: "PO WIP",          emoji: "📦", description: "Purchase orders, shipments, invoices" },
  { href: "/ats",       label: "ATS Planning",    emoji: "📊", description: "Available-to-ship inventory grid" },
  { href: "/techpack",  label: "Tech Packs",      emoji: "📐", description: "Style spec sheets" },
  { href: "/gs1",       label: "GS1 Labels",      emoji: "🏷️", description: "GTIN-14 prepack labels" },
  { href: "/planning",  label: "Planning",        emoji: "📈", description: "Inventory forecasting" },
  { href: "/vendor",    label: "Vendor Portal",   emoji: "🌐", description: "External vendor view (separate auth)" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
type AuthState = "loading" | "signed_out" | "signed_in";

export default function Tangerine() {
  const [activeModule, setActiveModule] = useState<ModuleKey | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Auth gate: on mount, check for an MS token. If present + non-expired, fetch
  // the signed-in user's email from Graph (User.Read is already in MS_SCOPES).
  // No token → render the branded login screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tokens = loadMsTokens();
      if (!tokens) {
        if (!cancelled) setAuthState("signed_out");
        return;
      }
      try {
        const token = await getMsAccessToken();
        if (cancelled) return;
        if (!token) {
          setAuthState("signed_out");
          return;
        }
        const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`Graph /me HTTP ${r.status}`);
        const me = await r.json();
        if (cancelled) return;
        setUserEmail(me.mail || me.userPrincipalName || me.displayName || null);
        setAuthState("signed_in");

        // Bridge MS OAuth → Supabase Auth. Best-effort: if the provision
        // endpoint fails (network / server-side mis-config), surface a
        // console warning but do NOT block the login — the operator can
        // still paste their uuid manually as a fallback while we debug.
        // First call creates auth.users + entity_users + links EB001;
        // subsequent calls are idempotent (ON CONFLICT DO NOTHING).
        try {
          const pr = await fetch("/api/internal/auth/provision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ms_access_token: token }),
          });
          if (pr.ok) {
            const provisioned = await pr.json();
            if (!cancelled && provisioned?.auth_user_id) {
              setCachedAuthUserId(provisioned.auth_user_id);
            }
          } else {
            const detail = await pr.text().catch(() => "");
            console.warn("[Tangerine] auth provision returned non-OK:", pr.status, detail);
          }
        } catch (provErr) {
          console.warn("[Tangerine] auth provision failed (non-fatal):", provErr);
        }
      } catch (err) {
        console.error("[Tangerine] auth check failed:", err);
        if (!cancelled) setAuthState("signed_out");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSignIn() {
    try {
      await msSignIn();
      // Re-run the auth check by reloading; simpler than re-deriving state.
      window.location.reload();
    } catch (err) {
      console.error("[Tangerine] sign-in failed:", err);
      alert("Sign-in failed. See console for details.");
    }
  }

  function handleSignOut() {
    if (!confirm("Sign out of Tangerine?")) return;
    clearMsTokens();
    window.location.reload();
  }

  if (authState === "loading") {
    return (
      <div style={{ background: C.bg, color: C.textMuted, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
        Checking authentication…
      </div>
    );
  }

  if (authState === "signed_out") {
    return <LoginScreen onSignIn={handleSignIn} />;
  }

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh" }}>
      <TopNav
        activeModule={activeModule}
        onSelectModule={setActiveModule}
        appsOpen={appsOpen}
        onToggleApps={() => setAppsOpen((v) => !v)}
        onCloseApps={() => setAppsOpen(false)}
        onGoHome={() => setActiveModule(null)}
        userEmail={userEmail}
        onSignOut={handleSignOut}
      />

      <main style={{ padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
        {activeModule === null && <HomeLanding onSelectModule={setActiveModule} />}
        {activeModule === "style_master"    && <InternalStyleMaster />}
        {activeModule === "fabric_codes"    && <InternalFabricCodes />}
        {activeModule === "vendor_master"   && <InternalVendorMaster />}
        {activeModule === "customer_master" && <InternalCustomerMaster />}
        {activeModule === "payment_terms"   && <InternalPaymentTerms />}
        {activeModule === "gl_accounts"       && <InternalCOA />}
        {activeModule === "gl_periods"        && <InternalPeriods />}
        {activeModule === "journal_entries"   && <InternalJournalEntry />}
        {activeModule === "ap_invoices"       && <InternalAPInvoices />}
        {activeModule === "ap_payments"       && <InternalAPPayments />}
        {activeModule === "approval_rules"     && <InternalApprovalRules />}
        {activeModule === "approval_requests"  && <InternalApprovalRequests />}
        {activeModule === "notifications"      && <InternalNotificationCenter />}
        {activeModule === "notification_prefs" && <InternalNotificationPreferences />}
        {activeModule === "employees"          && <InternalEmployees />}
        {activeModule === "inventory_transfers" && <InternalInventoryTransfers />}
        {activeModule === "inventory_adjustments" && <InternalInventoryAdjustments />}
        {activeModule === "scanner_sessions"    && <InternalScannerSessions />}
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branded login screen — shown when no MS token is present. Tangerine logo +
// "Sign in with Microsoft" button + a brief framing. Mirrors the rest of the
// design-calendar-app suite: same MS OAuth flow, different branded entry.
// ─────────────────────────────────────────────────────────────────────────────
function LoginScreen({ onSignIn }: { onSignIn: () => void }) {
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
      </div>
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
  onSignOut: () => void;
}

function TopNav({ activeModule, onSelectModule, appsOpen, onToggleApps, onCloseApps, onGoHome, userEmail, onSignOut }: TopNavProps) {
  return (
    <header
      style={{
        background: "#0b1220",
        borderBottom: `1px solid ${C.cardBdr}`,
        padding: "10px 24px",
        display: "flex",
        alignItems: "center",
        gap: 20,
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

      <nav style={{ display: "flex", gap: 4, flex: 1, marginLeft: 20 }}>
        {MODULES.map((m) => {
          const active = activeModule === m.key;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => onSelectModule(m.key)}
              style={{
                background: active ? C.card : "transparent",
                border: `1px solid ${active ? C.cardBdr : "transparent"}`,
                color: active ? C.text : C.textSub,
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
              title={m.group}
            >
              <span>{m.emoji}</span>
              <span>{m.label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ position: "relative" }}>
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
          <span>🧩</span>
          <span>Apps</span>
          <span style={{ fontSize: 10 }}>{appsOpen ? "▴" : "▾"}</span>
        </button>
        {appsOpen && <AppsLauncher onClose={onCloseApps} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: `1px solid ${C.cardBdr}`, marginLeft: 4 }}>
        {userEmail && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2, fontSize: 11 }}>
            <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>Signed in</span>
            <span style={{ color: C.text, fontWeight: 600, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={userEmail}>
              {userEmail}
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
                <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.description}</span>
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
  const masterModules = MODULES.filter((m) => m.group === "Master Data");
  const acctModules = MODULES.filter((m) => m.group === "Accounting");
  const approvalsModules = MODULES.filter((m) => m.group === "Approvals");
  const notifModules = MODULES.filter((m) => m.group === "Notifications");
  const hrModules = MODULES.filter((m) => m.group === "HR");
  const inventoryModules = MODULES.filter((m) => m.group === "Inventory");
  const opsModules = MODULES.filter((m) => m.group === "Operations");

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Tangerine ERP</h1>
        <p style={{ margin: "4px 0 0", color: C.textMuted, fontSize: 14 }}>
          The operating system for your PLM suite. Master data + accounting + integration to the apps you already use.
        </p>
      </div>

      <Section title="Master Data">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {masterModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Accounting">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {acctModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Approvals (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {approvalsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Notifications (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {notifModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="HR (P2)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {hrModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Inventory (P3)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {inventoryModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Operations (P3)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {opsModules.map((m) => <ModuleCard key={m.key} module={m} onClick={() => onSelectModule(m.key)} />)}
        </div>
      </Section>

      <Section title="Other apps in the suite">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {APPS.map((a) => (
            <a
              key={a.href}
              href={a.href}
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
        padding: 16,
        textAlign: "left",
        color: C.text,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        transition: "border-color 0.15s, transform 0.05s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.tangerine; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.cardBdr; }}
    >
      <div style={{ fontSize: 32 }}>{module.emoji}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{module.label}</div>
      <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{module.group}</div>
    </button>
  );
}
