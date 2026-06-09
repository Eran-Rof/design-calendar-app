import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";

// Target of the emailed reset link: /vendor/reset?reset_token=<token>.
// Posts the raw token + new password to /api/password-reset/confirm, which
// validates the token server-side and sets the password in Supabase Auth
// (covers "no password yet" too). On success we sign the vendor straight in.
export default function VendorResetPassword() {
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.search).get("reset_token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!token) { setErr("This reset link is invalid. Request a new one."); return; }
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setErr((body as { error?: string })?.error || `Could not reset (${r.status})`); return; }
      const email = (body as { email?: string })?.email;
      if (email) {
        const { error: sErr } = await supabaseVendor.auth.signInWithPassword({ email, password });
        if (sErr) {
          setErr("Password set, but auto sign-in failed — go to the login page and sign in. (" + sErr.message + ")");
          return;
        }
        nav("/vendor", { replace: true });
        return;
      }
      setDone(true);
    } catch (e) {
      setErr(`Could not connect: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Reset link invalid</h1>
        <p style={{ margin: "0 0 18px", color: TH.textMuted, fontSize: 13 }}>
          This password reset link is missing or invalid. Request a new one from the sign-in page.
        </p>
        <button onClick={() => nav("/vendor/login", { replace: true })} style={buttonStyle(false)}>Back to sign in</button>
      </div>
    );
  }

  if (done) {
    return (
      <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Password updated</h1>
        <p style={{ margin: "0 0 18px", color: TH.textMuted, fontSize: 13 }}>
          Your password has been set. You can now sign in.
        </p>
        <button onClick={() => nav("/vendor/login", { replace: true })} style={buttonStyle(false)}>Go to sign in</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Set a new password</h1>
      <p style={{ margin: "0 0 20px", color: TH.textMuted, fontSize: 13 }}>
        Choose a password for your vendor portal account.
      </p>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>New password</label>
        <input type="password" required autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>Confirm password</label>
        <input type="password" required autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
        {err && <div style={{ color: TH.primary, fontSize: 13, marginTop: 10, padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>{err}</div>}
        <button type="submit" disabled={busy} style={buttonStyle(busy)}>
          {busy ? "Saving…" : "Set password"}
        </button>
      </form>
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
