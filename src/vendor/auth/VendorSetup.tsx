import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";

export default function VendorSetup() {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const loginUrl = `${window.location.origin}/vendor/login`;

  // Custom 72h invite: the link is /vendor/setup?invite=<token>. When present we
  // use the accept-invite endpoint (Supabase's own link caps at 24h). Falls back
  // to the legacy Supabase-session flow (hash tokens) when there's no ?invite=.
  const inviteToken = new URLSearchParams(window.location.search).get("invite");

  useEffect(() => {
    let mounted = true;
    if (inviteToken) { setReady(true); return; }
    // Legacy Supabase-session path: the invite link carries access/refresh
    // tokens in the URL hash; supabase-js picks them up (detectSessionInUrl).
    supabaseVendor.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) setReady(true);
      else setErr("Invite link is invalid or has expired. Ask your Ring of Fire admin to resend.");
    });
    return () => { mounted = false; };
  }, [inviteToken]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      if (inviteToken) {
        // Custom-token path: set the password server-side, then sign in.
        const r = await fetch("/api/vendor/accept-invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: inviteToken, password }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { setErr(body?.error || `Could not complete setup (${r.status})`); return; }
        if (body?.email) {
          const { error: sErr } = await supabaseVendor.auth.signInWithPassword({ email: body.email, password });
          if (sErr) { setErr("Password set, but auto sign-in failed — go to the login page and sign in. (" + sErr.message + ")"); return; }
        }
        setDone(true);
        return;
      }
      const { error } = await supabaseVendor.auth.updateUser({ password });
      if (error) { setErr(error.message); return; }
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  async function copyLoginUrl() {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API blocked — fall back silently
    }
  }

  if (done) {
    return (
      <div style={{ maxWidth: 460, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>You're all set</h1>
        <p style={{ margin: 0, marginBottom: 18, color: TH.textMuted, fontSize: 13 }}>
          Your password has been saved. Bookmark this URL to sign in later — you'll also receive an email confirmation.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          <code style={{ flex: 1, padding: "9px 10px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {loginUrl}
          </code>
          <button
            onClick={copyLoginUrl}
            style={{ padding: "9px 12px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surface, color: TH.textSub, cursor: "pointer", fontSize: 13, whiteSpace: "nowrap", fontFamily: "inherit" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <button onClick={() => nav("/vendor", { replace: true })} style={buttonStyle(false)}>
          Continue to dashboard
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "48px auto", background: TH.surface, borderRadius: 12, padding: 28, boxShadow: `0 1px 3px ${TH.shadow}`, border: `1px solid ${TH.border}` }}>
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Set your password</h1>
      <p style={{ margin: 0, marginBottom: 20, color: TH.textMuted, fontSize: 13 }}>
        Choose a password for your vendor portal account.
      </p>
      {!ready && !err && <div style={{ color: TH.textMuted, fontSize: 13 }}>Validating invite…</div>}
      {err && !ready && <div style={{ color: TH.primary, fontSize: 13, padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>{err}</div>}
      {ready && (
        <form onSubmit={onSubmit}>
          <label style={labelStyle}>New password</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
          <label style={labelStyle}>Confirm password</label>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={inputStyle}
          />
          {err && <div style={{ color: TH.primary, fontSize: 13, marginTop: 10, padding: "8px 10px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>{err}</div>}
          <button type="submit" disabled={busy} style={buttonStyle(busy)}>
            {busy ? "Saving…" : "Set password and continue"}
          </button>
        </form>
      )}
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6, marginTop: 12 };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit" };
const buttonStyle = (disabled: boolean) => ({
  width: "100%", marginTop: 18, padding: "10px 14px", borderRadius: 6,
  border: "none", background: disabled ? TH.textMuted : TH.primary,
  color: "#FFFFFF", cursor: disabled ? "not-allowed" : "pointer",
  fontWeight: 600, fontSize: 14, fontFamily: "inherit",
});
