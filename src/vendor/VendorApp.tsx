import { useEffect, useState, type ReactNode } from "react";
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
import { TH } from "../utils/theme";
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

function TabNav() {
  const loc = useLocation();
  const p = loc.pathname;
  return (
    <nav style={{ display: "flex", gap: 2, padding: "0 24px", background: "rgba(255,255,255,0.05)", borderBottom: `1px solid rgba(255,255,255,0.12)`, flexWrap: "wrap" }}>
      <TabLink to="/vendor" active={p === "/vendor"}>Purchase Orders</TabLink>
      <TabLink to="/vendor/shipments" active={p.startsWith("/vendor/shipments")}>Shipments</TabLink>
      <TabLink to="/vendor/invoices" active={p.startsWith("/vendor/invoices")}>Invoices</TabLink>
      <TabLink to="/vendor/contracts" active={p.startsWith("/vendor/contracts")}>Contracts</TabLink>
      <TabLink to="/vendor/catalog" active={p.startsWith("/vendor/catalog")}>Catalog</TabLink>
      <TabLink to="/vendor/compliance" active={p.startsWith("/vendor/compliance")}>Compliance</TabLink>
      <TabLink to="/vendor/messages" active={p.startsWith("/vendor/messages")}>Messages</TabLink>
      <TabLink to="/vendor/disputes" active={p.startsWith("/vendor/disputes")}>Disputes</TabLink>
      <TabLink to="/vendor/reports" active={p.startsWith("/vendor/reports")}>Reports</TabLink>
      <TabLink to="/vendor/scorecard" active={p.startsWith("/vendor/scorecard") || p.startsWith("/vendor/performance")}>Scorecard</TabLink>
      <TabLink to="/vendor/bulk" active={p.startsWith("/vendor/bulk")}>Bulk</TabLink>
      <TabLink to="/vendor/settings/api-keys" active={p.startsWith("/vendor/settings")}>Settings</TabLink>
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
    <div style={{ minHeight: "100vh", background: TH.bg, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 24px", background: "#808895", borderBottom: `1px solid ${TH.header}`, boxShadow: `0 1px 2px ${TH.shadowMd}` }}>
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
        <Route path="/portal/:slug/login"    element={<PortalLogin />} />
        <Route path="/vendor/*" element={<Navigate to="/vendor" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
