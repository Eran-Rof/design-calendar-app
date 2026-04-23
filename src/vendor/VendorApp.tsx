import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useNavigate,
  useLocation,
} from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { TH } from "./theme";
import { ROFLogoFull } from "../utils/styles";
import { supabaseVendor } from "./supabaseVendor";
import VendorLogin from "./VendorLogin";
import VendorSetup from "./VendorSetup";
import POList from "./POList";
import ShipmentsList from "./ShipmentsList";
import ShipmentDetail from "./ShipmentDetail";
import ShipmentSubmit from "./ShipmentSubmit";
import InvoicesList from "./InvoicesList";
import InvoiceSubmit from "./InvoiceSubmit";
import InvoiceDetail from "./InvoiceDetail";
import NotificationBell from "./NotificationBell";
import ComplianceList from "./ComplianceList";
import POMessages from "./POMessages";
import VendorScorecard from "./VendorScorecard";
import VendorReports from "./VendorReports";
import VendorPODetail from "./VendorPODetail";
import POPrintView from "./POPrintView";
import VendorPhasesView from "./VendorPhasesView";
import VendorContracts from "./VendorContracts";
import VendorContractDetail from "./VendorContractDetail";
import VendorDisputes from "./VendorDisputes";
import VendorDisputeDetail from "./VendorDisputeDetail";
import VendorCatalog from "./VendorCatalog";
import VendorBulk from "./VendorBulk";
import VendorApiKeys from "./VendorApiKeys";
import VendorOnboarding from "./VendorOnboarding";
import VendorEdi from "./VendorEdi";
import VendorErp from "./VendorErp";
import VendorHealth from "./VendorHealth";
import VendorRfqs from "./VendorRfqs";
import VendorRfqDetail from "./VendorRfqDetail";
import VendorEntitySwitcher from "./VendorEntitySwitcher";
import VendorMobileFeed from "./VendorMobileFeed";
import PortalLogin from "./PortalLogin";
import VendorWorkspaces from "./VendorWorkspaces";
import VendorSustainability from "./VendorSustainability";
import VendorDiversity from "./VendorDiversity";
import VendorMarketplace from "./VendorMarketplace";
import VendorEsg from "./VendorEsg";
import VendorDiscountOffers from "./VendorDiscountOffers";
import VendorPaymentPreferences from "./VendorPaymentPreferences";
import VendorScf from "./VendorScf";
import VendorVirtualCards from "./VendorVirtualCards";
import VendorWithholding from "./VendorWithholding";
import VendorPayments from "./VendorPayments";

function useVendorSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    supabaseVendor.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabaseVendor.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}

function Protected({ children }: { children: ReactNode }) {
  const { session, ready } = useVendorSession();
  const loc = useLocation();
  if (!ready) return <LoadingScreen />;
  if (!session) return <Navigate to="/vendor/login" replace state={{ from: loc }} />;
  return <>{children}</>;
}

// Gate: if the vendor has an onboarding workflow that isn't approved, force
// them into /vendor/onboarding until it's done. Vendors with no workflow
// row yet (legacy) see the banner but aren't blocked.
function OnboardingGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [block, setBlock] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabaseVendor.auth.getSession();
        const token = session?.access_token;
        if (!token) { if (!cancelled) setReady(true); return; }
        const r = await fetch("/api/vendor/onboarding", { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) { if (!cancelled) setReady(true); return; }
        const data = await r.json() as { workflow: { status: string } };
        const status = data.workflow?.status;
        if (!cancelled) {
          if (status && status !== "approved") setBlock(true);
          setReady(true);
        }
      } catch { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!ready) return <LoadingScreen />;
  if (block && !loc.pathname.startsWith("/vendor/onboarding")) {
    return <Navigate to="/vendor/onboarding" replace />;
  }
  return <>{children}</>;
}

const MORE_GROUPS: { group: string; items: { to: string; label: string; match: (p: string) => boolean }[] }[] = [
  { group: "Orders", items: [
    { to: "/vendor/contracts", label: "Contracts", match: (p) => p.startsWith("/vendor/contracts") },
    { to: "/vendor/catalog",   label: "Catalog",   match: (p) => p.startsWith("/vendor/catalog") },
  ]},
  { group: "Finance", items: [
    { to: "/vendor/discount-offers",     label: "Early pay",     match: (p) => p.startsWith("/vendor/discount-offers") },
    { to: "/vendor/scf",                 label: "Financing",     match: (p) => p.startsWith("/vendor/scf") },
    { to: "/vendor/virtual-cards",       label: "Virtual cards", match: (p) => p.startsWith("/vendor/virtual-cards") },
    { to: "/vendor/withholding",         label: "Tax",           match: (p) => p.startsWith("/vendor/withholding") || p.startsWith("/vendor/tax") },
    { to: "/vendor/payment-preferences", label: "Payment prefs", match: (p) => p.startsWith("/vendor/payment-preferences") },
  ]},
  { group: "ESG & Diversity", items: [
    { to: "/vendor/sustainability", label: "Sustainability", match: (p) => p.startsWith("/vendor/sustainability") },
    { to: "/vendor/esg",            label: "ESG",            match: (p) => p.startsWith("/vendor/esg") },
    { to: "/vendor/diversity",      label: "Diversity",      match: (p) => p.startsWith("/vendor/diversity") },
  ]},
  { group: "Collab", items: [
    { to: "/vendor/workspaces",  label: "Workspaces",  match: (p) => p.startsWith("/vendor/workspaces") },
    { to: "/vendor/disputes",    label: "Disputes",    match: (p) => p.startsWith("/vendor/disputes") },
    { to: "/vendor/marketplace", label: "Marketplace", match: (p) => p.startsWith("/vendor/marketplace") },
  ]},
  { group: "Reports & Admin", items: [
    { to: "/vendor/scorecard",         label: "Scorecard", match: (p) => p.startsWith("/vendor/scorecard") || p.startsWith("/vendor/performance") },
    { to: "/vendor/bulk",              label: "Bulk",      match: (p) => p.startsWith("/vendor/bulk") },
    { to: "/vendor/settings/api-keys", label: "Settings",  match: (p) => p.startsWith("/vendor/settings") },
  ]},
];

function MoreFlyout({ activePath, onClose }: { activePath: string; onClose: () => void }) {
  const currentGroup = MORE_GROUPS.find((g) => g.items.some((i) => i.match(activePath)))?.group;
  const [hovered, setHovered] = useState<string | null>(currentGroup || MORE_GROUPS[0].group);
  const active = MORE_GROUPS.find((g) => g.group === hovered) || MORE_GROUPS[0];

  return (
    <div
      role="menu"
      style={{
        position: "absolute", top: "100%", right: 0, paddingTop: 2,
        display: "flex", gap: 4, flexDirection: "row-reverse",
        zIndex: 100,
      }}
    >
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: 4, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        {MORE_GROUPS.map((g) => {
          const isHovered = g.group === hovered;
          const hasSelected = g.items.some((i) => i.match(activePath));
          return (
            <button
              key={g.group}
              onMouseEnter={() => setHovered(g.group)}
              onFocus={() => setHovered(g.group)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                background: isHovered ? "#334155" : "transparent",
                border: "none", color: hasSelected ? "#60A5FA" : "#F1F5F9",
                borderRadius: 6, padding: "9px 10px", fontSize: 13, cursor: "default",
                textAlign: "left", fontFamily: "inherit", fontWeight: hasSelected ? 700 : 500,
              }}
            >
              <span style={{ fontSize: 10, opacity: 0.6 }}>◂</span>
              <span>{g.group}</span>
            </button>
          );
        })}
      </div>
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: 4, minWidth: 200, boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "6px 10px 4px", fontSize: 10, fontWeight: 700, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.8 }}>{active.group}</div>
        {active.items.map((i) => (
          <Link
            key={i.to} to={i.to} role="menuitem"
            onClick={onClose}
            style={{
              display: "block", width: "100%",
              background: i.match(activePath) ? "#3B82F620" : "transparent",
              color: i.match(activePath) ? "#60A5FA" : "#CBD5E1",
              borderRadius: 6, padding: "8px 10px", fontSize: 13, textDecoration: "none",
              boxSizing: "border-box",
            }}
          >{i.label}</Link>
        ))}
      </div>
    </div>
  );
}

function MoreMenu({ activePath }: { activePath: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", esc); };
  }, [open]);
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);

  const anyActive = MORE_GROUPS.some((g) => g.items.some((i) => i.match(activePath)));
  const activeItem = MORE_GROUPS.flatMap((g) => g.items).find((i) => i.match(activePath));
  const label = activeItem ? activeItem.label : "More";

  return (
    <div
      ref={ref}
      style={{ position: "relative" }}
      onMouseEnter={() => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } }}
      onMouseLeave={() => { leaveTimer.current = setTimeout(() => setOpen(false), 200); }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "10px 18px", fontSize: 13, fontWeight: 600,
          color: anyActive ? "#60A5FA" : "#CBD5E1",
          background: "transparent", border: "none",
          borderBottom: anyActive ? "2px solid #60A5FA" : "2px solid transparent",
          cursor: "pointer", fontFamily: "inherit",
        }}
        aria-haspopup="menu" aria-expanded={open}
      >
        {label} <span style={{ fontSize: 10, marginLeft: 4, opacity: 0.8 }}>▾</span>
      </button>
      {open && <MoreFlyout activePath={activePath} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TabNav() {
  const loc = useLocation();
  const p = loc.pathname;
  return (
    <nav style={{ display: "flex", gap: 2, padding: "0 24px", background: "rgba(255,255,255,0.05)", borderBottom: `1px solid rgba(255,255,255,0.12)`, alignItems: "center" }}>
      <TabLink to="/vendor/reports" active={p.startsWith("/vendor/reports")}>Dashboard</TabLink>
      <TabLink to="/vendor" active={p === "/vendor"}>Purchase Orders</TabLink>
      <TabLink to="/vendor/shipments" active={p.startsWith("/vendor/shipments")}>Shipments</TabLink>
      <TabLink to="/vendor/invoices" active={p.startsWith("/vendor/invoices")}>Invoices</TabLink>
      <TabLink to="/vendor/payments" active={p.startsWith("/vendor/payments")}>Payments</TabLink>
      <TabLink to="/vendor/messages" active={p.startsWith("/vendor/messages")}>Messages</TabLink>
      <TabLink to="/vendor/compliance" active={p.startsWith("/vendor/compliance")}>Compliance</TabLink>
      <div style={{ marginLeft: "auto" }}><MoreMenu activePath={p} /></div>
    </nav>
  );
}

function TabLink({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      to={to}
      style={{
        padding: "10px 18px",
        fontSize: 13,
        fontWeight: 600,
        color: active ? "#FFFFFF" : "rgba(255,255,255,0.65)",
        textDecoration: "none",
        borderBottom: `3px solid ${active ? TH.primary : "transparent"}`,
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function VendorShell({ children, withTabs = false }: { children: ReactNode; withTabs?: boolean }) {
  const { session } = useVendorSession();
  const nav = useNavigate();
  return (
    <div style={{ minHeight: "100vh", background: TH.bg, fontFamily: "system-ui, -apple-system, sans-serif", color: TH.text, colorScheme: "dark" }}>
      <header style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 24px", background: TH.header, borderBottom: `1px solid ${TH.border}`, boxShadow: `0 1px 2px ${TH.shadowMd}` }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <ROFLogoFull height={66} />
        </div>
        <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", fontWeight: 700, fontSize: 20, color: "#FFFFFF", letterSpacing: 0.3, textShadow: "0 1px 1px rgba(0,0,0,0.2)" }}>
          Vendor Portal
        </div>
        {session && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <NotificationBell />
            <span style={{ fontSize: 13, color: "#FFFFFF" }}>{session.user.email}</span>
            <button
              onClick={async () => {
                await supabaseVendor.auth.signOut();
                nav("/vendor/login", { replace: true });
              }}
              style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.12)", color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {withTabs && session && <TabNav />}
      <main style={{ padding: "24px" }}>{children}</main>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: TH.textMuted }}>
      Loading…
    </div>
  );
}

export default function VendorApp() {
  if (!supabaseVendor) {
    return (
      <div style={{ padding: 24, color: TH.primary }}>
        Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
      </div>
    );
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/vendor/login" element={<VendorShell><VendorLogin /></VendorShell>} />
        <Route path="/vendor/setup" element={<VendorShell><VendorSetup /></VendorShell>} />
        <Route
          path="/vendor/onboarding"
          element={
            <Protected>
              <VendorShell><VendorOnboarding /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor"
          element={
            <Protected>
              <OnboardingGate>
                <VendorShell withTabs><POList /></VendorShell>
              </OnboardingGate>
            </Protected>
          }
        />
        <Route
          path="/vendor/shipments"
          element={
            <Protected>
              <VendorShell withTabs><ShipmentsList /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/shipments/new"
          element={
            <Protected>
              <VendorShell withTabs><ShipmentSubmit /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/shipments/:id"
          element={
            <Protected>
              <VendorShell withTabs><ShipmentDetail /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/invoices"
          element={
            <Protected>
              <VendorShell withTabs><InvoicesList /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/invoices/new"
          element={
            <Protected>
              <VendorShell withTabs><InvoiceSubmit /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/invoices/:id"
          element={
            <Protected>
              <VendorShell withTabs><InvoiceDetail /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/compliance"
          element={
            <Protected>
              <VendorShell withTabs><ComplianceList /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/messages"
          element={
            <Protected>
              <VendorShell withTabs><POMessages /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/performance"
          element={<Navigate to="/vendor/scorecard" replace />}
        />
        <Route
          path="/vendor/scorecard"
          element={
            <Protected>
              <VendorShell withTabs><VendorScorecard /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/reports"
          element={
            <Protected>
              <VendorShell withTabs><VendorReports /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/pos/:id"
          element={
            <Protected>
              <VendorShell withTabs><VendorPODetail /></VendorShell>
            </Protected>
          }
        />
        <Route
          path="/vendor/pos/:id/view"
          element={<Protected><POPrintView /></Protected>}
        />
        <Route
          path="/vendor/phases"
          element={<Protected><VendorShell withTabs><VendorPhasesView /></VendorShell></Protected>}
        />
        <Route path="/vendor/contracts"     element={<Protected><VendorShell withTabs><VendorContracts /></VendorShell></Protected>} />
        <Route path="/vendor/contracts/:id" element={<Protected><VendorShell withTabs><VendorContractDetail /></VendorShell></Protected>} />
        <Route path="/vendor/disputes"      element={<Protected><VendorShell withTabs><VendorDisputes /></VendorShell></Protected>} />
        <Route path="/vendor/disputes/:id"  element={<Protected><VendorShell withTabs><VendorDisputeDetail /></VendorShell></Protected>} />
        <Route path="/vendor/catalog"       element={<Protected><VendorShell withTabs><VendorCatalog /></VendorShell></Protected>} />
        <Route path="/vendor/bulk"          element={<Protected><VendorShell withTabs><VendorBulk /></VendorShell></Protected>} />
        <Route path="/vendor/settings/api-keys" element={<Protected><VendorShell withTabs><VendorApiKeys /></VendorShell></Protected>} />
        <Route path="/vendor/settings"      element={<Navigate to="/vendor/settings/api-keys" replace />} />
        <Route path="/vendor/erp"           element={<Protected><VendorShell withTabs><VendorErp /></VendorShell></Protected>} />
        <Route path="/vendor/edi"           element={<Protected><VendorShell withTabs><VendorEdi /></VendorShell></Protected>} />
        <Route path="/vendor/health"        element={<Protected><VendorShell withTabs><VendorHealth /></VendorShell></Protected>} />
        <Route path="/vendor/rfqs"           element={<Protected><VendorShell withTabs><VendorRfqs /></VendorShell></Protected>} />
        <Route path="/vendor/rfqs/:id"       element={<Protected><VendorShell withTabs><VendorRfqDetail /></VendorShell></Protected>} />
        <Route path="/vendor/entity-switcher" element={<Protected><VendorShell withTabs><VendorEntitySwitcher /></VendorShell></Protected>} />
        <Route path="/vendor/mobile/feed"    element={<Protected><VendorShell><VendorMobileFeed /></VendorShell></Protected>} />
        <Route path="/vendor/workspaces"     element={<Protected><VendorShell withTabs><VendorWorkspaces /></VendorShell></Protected>} />
        <Route path="/vendor/sustainability" element={<Protected><VendorShell withTabs><VendorSustainability /></VendorShell></Protected>} />
        <Route path="/vendor/diversity"      element={<Protected><VendorShell withTabs><VendorDiversity /></VendorShell></Protected>} />
        <Route path="/vendor/marketplace"    element={<Protected><VendorShell withTabs><VendorMarketplace /></VendorShell></Protected>} />
        <Route path="/vendor/esg"            element={<Protected><VendorShell withTabs><VendorEsg /></VendorShell></Protected>} />
        <Route path="/vendor/discount-offers" element={<Protected><VendorShell withTabs><VendorDiscountOffers /></VendorShell></Protected>} />
        <Route path="/vendor/payment-preferences" element={<Protected><VendorShell withTabs><VendorPaymentPreferences /></VendorShell></Protected>} />
        <Route path="/vendor/scf"                 element={<Protected><VendorShell withTabs><VendorScf /></VendorShell></Protected>} />
        <Route path="/vendor/virtual-cards"       element={<Protected><VendorShell withTabs><VendorVirtualCards /></VendorShell></Protected>} />
        <Route path="/vendor/virtual-cards/:id/reveal" element={<Protected><VendorShell withTabs><VendorVirtualCards /></VendorShell></Protected>} />
        <Route path="/vendor/withholding"         element={<Protected><VendorShell withTabs><VendorWithholding /></VendorShell></Protected>} />
        <Route path="/vendor/tax"                 element={<Protected><VendorShell withTabs><VendorWithholding /></VendorShell></Protected>} />
        <Route path="/vendor/financing"           element={<Protected><VendorShell withTabs><VendorScf /></VendorShell></Protected>} />
        <Route path="/vendor/payments"            element={<Protected><VendorShell withTabs><VendorPayments /></VendorShell></Protected>} />
        <Route path="/portal/:slug/login"    element={<PortalLogin />} />
        <Route path="/vendor/*" element={<Navigate to="/vendor" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
