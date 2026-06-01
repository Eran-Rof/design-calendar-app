import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { B } from "./theme";
import { supabaseB2B } from "./supabaseB2B";
import B2BLogin from "./B2BLogin";
import B2BShell from "./B2BShell";
import type { B2BSession } from "./types";

// /b2b — external B2B customer portal. Passwordless Supabase Auth session that
// is fully isolated from internal staff auth (separate browser client +
// storageKey). After GoTrue establishes a session, we authorize the buyer
// against b2b_accounts via GET /api/b2b/session before showing the shell.

type Phase =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "authorizing" }
  | { kind: "ready"; portal: B2BSession }
  | { kind: "unauthorized" }
  | { kind: "config-error" };

export default function B2BApp() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // Track the GoTrue session. detectSessionInUrl (in supabaseB2B) completes the
  // magic-link return; onAuthStateChange then fires with the new session.
  useEffect(() => {
    if (!supabaseB2B) {
      setPhase({ kind: "config-error" });
      return;
    }
    let mounted = true;

    function applySession(session: Session | null) {
      if (!mounted) return;
      if (!session) {
        setPhase({ kind: "login" });
        return;
      }
      authorize(session);
    }

    supabaseB2B.auth.getSession().then(({ data }) => applySession(data.session));
    const { data: sub } = supabaseB2B.auth.onAuthStateChange((_evt, session) => {
      applySession(session);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exchange the GoTrue access token for the server-authorized portal identity.
  async function authorize(session: Session) {
    setPhase({ kind: "authorizing" });
    try {
      const res = await fetch("/api/b2b/session", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const portal = (await res.json()) as B2BSession;
        setPhase({ kind: "ready", portal });
        return;
      }
      // 401 = bad/expired token (sign out, back to login). 403 = authenticated
      // but not provisioned for the portal (show the not-authorized message and
      // sign out so a stale session doesn't loop).
      if (res.status === 401) {
        await supabaseB2B.auth.signOut();
        setPhase({ kind: "login" });
      } else {
        await supabaseB2B.auth.signOut();
        setPhase({ kind: "unauthorized" });
      }
    } catch {
      setPhase({ kind: "unauthorized" });
    }
  }

  async function logout() {
    try { await supabaseB2B.auth.signOut(); } catch { /* ignore */ }
    setPhase({ kind: "login" });
  }

  switch (phase.kind) {
    case "loading":
    case "authorizing":
      return <Centered>{phase.kind === "authorizing" ? "Signing you in…" : "Loading…"}</Centered>;
    case "login":
      return <B2BLogin />;
    case "ready":
      return <B2BShell session={phase.portal} onLogout={logout} />;
    case "unauthorized":
      return (
        <Notice
          title="Not authorized"
          body="Your email isn't authorized for the portal yet. Please contact your Ring of Fire sales rep."
          action={{ label: "Back to sign in", onClick: () => setPhase({ kind: "login" }) }}
        />
      );
    case "config-error":
      return <Notice title="Portal unavailable" body="The portal is not configured. Please contact your rep." />;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: B.font, display: "flex", alignItems: "center", justifyContent: "center", color: B.textMuted, fontSize: 14 }}>
      {children}
    </div>
  );
}

function Notice({
  title, body, action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{ minHeight: "100vh", background: B.bg, fontFamily: B.font, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 20px" }}>
      <div style={{ maxWidth: 420, textAlign: "center", background: B.surface, border: `1px solid ${B.border}`, borderRadius: 14, padding: 32, boxShadow: `0 4px 24px ${B.shadow}` }}>
        <h1 style={{ margin: 0, fontSize: 18, color: B.text }}>{title}</h1>
        <p style={{ color: B.textMuted, fontSize: 14, lineHeight: 1.5, margin: "12px 0 0" }}>{body}</p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{ marginTop: 20, padding: "10px 18px", borderRadius: 8, border: "none", background: B.primary, color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
