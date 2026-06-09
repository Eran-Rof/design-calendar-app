import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";

export default function VendorLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Forgot-password sub-flow (inline). Posts to the reset-request endpoint which
  // ALWAYS returns generic success — never reveals whether the account exists.
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotBusy, setForgotBusy] = useState(false);

  async function requestReset() {
    setErr(null);
    if (!email.trim()) { setErr("Enter your email first."); return; }
    setForgotBusy(true);
    try {
      const r = await fetch("/api/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_type: "vendor",
          identifier: email.trim().toLowerCase(),
          site_url: window.location.origin,
        }),
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        setErr((b as { error?: string })?.error || `Request failed (${r.status})`);
        return;
      }
      setForgotSent(true);
    } catch (e) {
      setErr(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setForgotBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { data, error } = await supabaseVendor.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        setErr(error.message);
        return;
      }
      // RLS requires vendor_users row for data access. If login succeeded but
      // the user was never linked, surface it now rather than dumping them on
      // an empty PO list.
      const { data: vu } = await supabaseVendor
        .from("vendor_users")
        .select("id")
        .eq("auth_id", data.user!.id)
        .maybeSingle();
      if (!vu) {
        await supabaseVendor.auth.signOut();
        setErr("This account is not linked to a vendor. Contact your Ring of Fire admin.");
        return;
      }
      nav("/vendor", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return (
      <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Reset your password</h1>
        {forgotSent ? (
          <>
            <p style={{ margin: "0 0 18px", color: TH.textMuted, fontSize: 13, lineHeight: 1.5 }}>
              If an account exists for that email, a reset link has been sent. Check your inbox and follow the link (valid for 1 hour).
            </p>
            <button onClick={() => { setForgot(false); setForgotSent(false); }} style={buttonStyle(false)}>Back to sign in</button>
          </>
        ) : (
          <>
            <p style={{ margin: "0 0 18px", color: TH.textMuted, fontSize: 13, lineHeight: 1.5 }}>
              Enter your email and we'll send a link to set a new password.
            </p>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
            />
            {err && (
              <div style={{ color: TH.primary, fontSize: 13, marginTop: 10, padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>{err}</div>
            )}
            <button onClick={requestReset} disabled={forgotBusy} style={buttonStyle(forgotBusy)}>
              {forgotBusy ? "Sending…" : "Send reset link"}
            </button>
            <button onClick={() => { setForgot(false); setErr(null); }} style={{ width: "100%", marginTop: 10, padding: "8px 14px", borderRadius: 6, border: "none", background: "transparent", color: TH.textMuted, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Sign in</h1>
      <p style={{ margin: 0, marginBottom: 20, color: TH.textMuted, fontSize: 13 }}>
        Use the email address that received your invite.
      </p>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>Email</label>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />
        <label style={labelStyle}>Password</label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={inputStyle}
        />
        {err && (
          <div style={{ color: TH.primary, fontSize: 13, marginBottom: 12, padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>{err}</div>
        )}
        <button type="submit" disabled={busy} style={buttonStyle(busy)}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <button
        type="button"
        onClick={() => { setForgot(true); setErr(null); }}
        style={{ display: "block", margin: "14px auto 0", background: "none", border: "none", color: TH.textMuted, fontSize: 12, cursor: "pointer", textDecoration: "underline", fontFamily: "inherit" }}
      >
        Forgot password?
      </button>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6, marginTop: 12 };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit", background: TH.bg, color: TH.text };
const buttonStyle = (disabled: boolean) => ({
  width: "100%", marginTop: 18, padding: "10px 14px", borderRadius: 6,
  border: "none", background: disabled ? TH.textMuted : TH.primary,
  color: "#FFFFFF", cursor: disabled ? "not-allowed" : "pointer",
  fontWeight: 600, fontSize: 14, fontFamily: "inherit",
});
