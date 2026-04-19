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

function TabNav() {
  const loc = useLocation();
  const isPOs = loc.pathname === "/vendor";
  const isShipments = loc.pathname.startsWith("/vendor/shipments");
  const isInvoices = loc.pathname.startsWith("/vendor/invoices");
  const isCompliance = loc.pathname.startsWith("/vendor/compliance");
  return (
    <nav style={{ display: "flex", gap: 2, padding: "0 24px", background: "rgba(255,255,255,0.05)", borderBottom: `1px solid rgba(255,255,255,0.12)` }}>
      <TabLink to="/vendor" active={isPOs}>Purchase Orders</TabLink>
      <TabLink to="/vendor/shipments" active={isShipments}>Shipments</TabLink>
      <TabLink to="/vendor/invoices" active={isInvoices}>Invoices</TabLink>
      <TabLink to="/vendor/compliance" active={isCompliance}>Compliance</TabLink>
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
          path="/vendor"
          element={
            <Protected>
              <VendorShell withTabs><POList /></VendorShell>
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
        <Route path="/vendor/*" element={<Navigate to="/vendor" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
