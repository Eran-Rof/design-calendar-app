import { useEffect, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import VendorLogin from "./VendorLogin";
import VendorSetup from "./VendorSetup";
import POList from "./POList";

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

function VendorShell({ children }: { children: ReactNode }) {
  const { session } = useVendorSession();
  const nav = useNavigate();
  return (
    <div style={{ minHeight: "100vh", background: TH.surfaceHi, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 24px", background: TH.header, borderBottom: `1px solid ${TH.border}` }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: "#FFFFFF", letterSpacing: 0.2 }}>Ring of Fire — Vendor Portal</div>
        {session && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "#CBD5E0" }}>{session.user.email}</span>
            <button
              onClick={async () => {
                await supabaseVendor.auth.signOut();
                nav("/vendor/login", { replace: true });
              }}
              style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.3)", background: "transparent", color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
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
              <VendorShell><POList /></VendorShell>
            </Protected>
          }
        />
        <Route path="/vendor/*" element={<Navigate to="/vendor" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
