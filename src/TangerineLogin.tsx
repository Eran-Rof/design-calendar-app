// src/TangerineLogin.tsx
//
// Standalone, Tangerine-branded login page — the planned single front door for
// the whole ROF suite. Microsoft-365 sign-in only (operator decision): it reuses
// the exact same MS OAuth flow as the in-shell Tangerine login (src/utils/msAuth),
// so a successful sign-in here drops you into the app with a live MS token and the
// per-user JWT bridge provisions on landing (Tangerine.tsx mount).
//
// Reached two ways:
//   • directly at /login (always available), and
//   • as the root "/" route once the operator flips VITE_TANGERINE_AS_HOME=true
//     (retiring the PLM launcher — see OPERATOR-TODO).
//
// A `?next=<path>` query param controls where you land after sign-in (default
// /tangerine); only same-origin relative paths are honoured.

import { useEffect, useState } from "react";
import { loadMsTokens, getMsAccessToken, msSignIn } from "./utils/msAuth";

// Self-contained palette so this page never imports the heavy Tangerine shell.
const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  tangerine: "#F97316",
  tangerineDim: "#C2410C",
};

// Only allow a same-origin relative path (must start with a single "/"); falls
// back to the Tangerine home. Prevents an open-redirect via ?next=//evil.com.
function safeNext(): string {
  try {
    const p = new URLSearchParams(window.location.search).get("next");
    if (p && p.startsWith("/") && !p.startsWith("//")) return p;
  } catch { /* noop */ }
  return "/tangerine";
}

export default function TangerineLogin() {
  // "checking" → probing for an existing MS token; "signed_out" → show the
  // sign-in card; "signing_in" → popup in flight.
  const [phase, setPhase] = useState<"checking" | "signed_out" | "signing_in">("checking");
  const [err, setErr] = useState("");

  // If a valid MS token is already cached, skip the page entirely and go to the
  // destination — so the front door doesn't nag an already-signed-in user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!loadMsTokens()) { if (!cancelled) setPhase("signed_out"); return; }
      try {
        const token = await getMsAccessToken();
        if (cancelled) return;
        if (token) { window.location.replace(safeNext()); return; }
        setPhase("signed_out");
      } catch {
        if (!cancelled) setPhase("signed_out");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function signIn() {
    setErr("");
    setPhase("signing_in");
    try {
      await msSignIn();
      // Token saved by msSignIn; a full navigation lets the destination app
      // (Tangerine) run its own auth check + provision the per-user JWT.
      window.location.replace(safeNext());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("signed_out");
    }
  }

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
        fontFamily: "system-ui, -apple-system, sans-serif",
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
              width: 56, height: 56, borderRadius: 14,
              background: `linear-gradient(135deg, ${C.tangerine}, ${C.tangerineDim})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, fontWeight: 800, color: "white",
              boxShadow: `0 8px 24px ${C.tangerineDim}66`,
            }}
          >
            T
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontSize: 24, fontWeight: 700, color: C.text }}>Tangerine</span>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 2 }}>ERP · Ring of Fire</span>
          </div>
        </div>

        <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>Sign in to the suite</h1>
        <p style={{ margin: "0 0 24px", fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>
          Tangerine is the home for the Ring of Fire app suite — accounting, inventory,
          sales, procurement and finance, plus links out to every other app. Sign in with
          your work Microsoft account to continue.
        </p>

        {phase === "checking" ? (
          <div style={{ padding: "14px 0", fontSize: 13, color: C.textMuted }}>Checking your session…</div>
        ) : (
          <button
            type="button"
            onClick={signIn}
            disabled={phase === "signing_in"}
            style={{
              width: "100%",
              background: phase === "signing_in" ? "#e5e5e5" : "white",
              color: "#1f1f1f",
              border: 0,
              padding: "12px 16px",
              borderRadius: 8,
              cursor: phase === "signing_in" ? "wait" : "pointer",
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
            {phase === "signing_in" ? "Opening Microsoft sign-in…" : "Sign in with Microsoft"}
          </button>
        )}

        {err && (
          <p style={{ margin: "14px 0 0", fontSize: 12, color: "#FCA5A5", lineHeight: 1.5 }}>
            Sign-in failed: {err}. The popup may have been blocked — allow pop-ups for this domain and try again.
          </p>
        )}

        <p style={{ margin: "20px 0 0", fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>
          Uses the same Microsoft 365 work account as the rest of the suite. Once signed in,
          launch the other apps (Design Calendar, PO WIP, ATS, Tech Packs, GS1, Planning,
          Costing, Vendor Portal) from the Apps menu inside Tangerine.
        </p>

        {/* Fallback while the PLM launcher is still live (pre-retirement). */}
        <p style={{ margin: "12px 0 0", fontSize: 11, color: C.textMuted }}>
          <a href="/" style={{ color: C.tangerine, textDecoration: "none" }}>Use the classic launcher →</a>
        </p>
      </div>
    </div>
  );
}
