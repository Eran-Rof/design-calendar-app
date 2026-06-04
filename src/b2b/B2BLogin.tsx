import { useState, type FormEvent } from "react";
import { B } from "./theme";
import { supabaseB2B } from "./supabaseB2B";

// Passwordless (magic-link) login for the B2B customer portal. The buyer enters
// their email; Supabase Auth emails a one-time link that redirects back to /b2b,
// where B2BApp completes the session and authorizes against b2b_accounts.
export default function B2BLogin() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!supabaseB2B) {
      setErr("The portal is not configured. Please contact your rep.");
      return;
    }
    setBusy(true);
    try {
      const clean = email.trim().toLowerCase();
      const { error } = await supabaseB2B.auth.signInWithOtp({
        email: clean,
        options: {
          // Absolute /b2b URL so the magic link returns to this app. The origin
          // must be on the Supabase Auth redirect allowlist (OPERATOR-TODO).
          emailRedirectTo: `${window.location.origin}/b2b`,
        },
      });
      if (error) {
        setErr(error.message);
        return;
      }
      setSent(true);
    } catch {
      setErr("Something went wrong sending your link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={pageWrap}>
      <div style={card}>
        <div style={{ fontSize: 22, fontWeight: 700, color: B.primary, marginBottom: 4 }}>
          Ring of Fire
        </div>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 18, color: B.text }}>
          Wholesale Portal
        </h1>

        {sent ? (
          <div>
            <p style={{ color: B.textSub, fontSize: 14, lineHeight: 1.5, marginTop: 14 }}>
              Check your email. We sent a sign-in link to{" "}
              <strong style={{ color: B.text }}>{email.trim().toLowerCase()}</strong>.
              Open it on this device to continue.
            </p>
            <button
              type="button"
              onClick={() => { setSent(false); setErr(null); }}
              style={linkBtn}
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <p style={{ color: B.textMuted, fontSize: 13, margin: "10px 0 18px" }}>
              Enter your email and we'll send you a secure sign-in link — no password needed.
            </p>
            <label style={label}>Email</label>
            <input
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              style={input}
            />
            {err && <div style={errBox}>{err}</div>}
            <button type="submit" disabled={busy} style={primaryBtn(busy)}>
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}
      </div>
      <p style={{ color: B.textMuted, fontSize: 12, marginTop: 18 }}>
        Trouble signing in? Contact your Ring of Fire sales rep.
      </p>
    </div>
  );
}

const pageWrap: React.CSSProperties = {
  minHeight: "100vh", background: B.bg, fontFamily: B.font,
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  padding: "0 20px",
};
const card: React.CSSProperties = {
  width: "100%", maxWidth: 380, background: B.surface, borderRadius: 14,
  padding: 32, border: `1px solid ${B.border}`, boxShadow: `0 4px 24px ${B.shadow}`,
};
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: B.textSub, marginBottom: 6 };
const input: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${B.border}`,
  fontSize: 14, boxSizing: "border-box", fontFamily: "inherit", background: B.surface, color: B.text,
};
const errBox: React.CSSProperties = {
  color: B.danger, fontSize: 13, margin: "12px 0 0", padding: "8px 10px",
  background: B.dangerBg, border: `1px solid ${B.dangerBdr}`, borderRadius: 8,
};
const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  width: "100%", marginTop: 18, padding: "11px 14px", borderRadius: 8, border: "none",
  background: disabled ? B.textMuted : B.primary, color: "#FFFFFF",
  cursor: disabled ? "not-allowed" : "pointer", fontWeight: 600, fontSize: 14, fontFamily: "inherit",
});
const linkBtn: React.CSSProperties = {
  marginTop: 16, background: "none", border: "none", color: B.primary,
  cursor: "pointer", fontSize: 13, fontWeight: 600, padding: 0, fontFamily: "inherit",
};
