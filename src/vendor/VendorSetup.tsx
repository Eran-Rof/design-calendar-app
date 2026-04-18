import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabaseVendor } from "./supabaseVendor";

export default function VendorSetup() {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The invite link carries an access/refresh token in the URL hash. Supabase
  // JS picks it up automatically (detectSessionInUrl: true); we just wait for
  // the session to appear. If it doesn't, the link is bad/expired.
  useEffect(() => {
    let mounted = true;
    supabaseVendor.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      if (data.session) setReady(true);
      else setErr("Invite link is invalid or has expired. Ask your Ring of Fire admin to resend.");
    });
    return () => { mounted = false; };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      const { error } = await supabaseVendor.auth.updateUser({ password });
      if (error) { setErr(error.message); return; }
      nav("/vendor", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "48px auto", background: "#FFFFFF", borderRadius: 12, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: "#111827" }}>Set your password</h1>
      <p style={{ margin: 0, marginBottom: 20, color: "#6B7280", fontSize: 13 }}>
        Choose a password for your vendor portal account.
      </p>
      {!ready && !err && <div style={{ color: "#6B7280", fontSize: 13 }}>Validating invite…</div>}
      {err && !ready && <div style={{ color: "#B91C1C", fontSize: 13 }}>{err}</div>}
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
          {err && <div style={{ color: "#B91C1C", fontSize: 13, marginTop: 10 }}>{err}</div>}
          <button type="submit" disabled={busy} style={buttonStyle(busy)}>
            {busy ? "Saving…" : "Set password and continue"}
          </button>
        </form>
      )}
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6, marginTop: 12 };
const inputStyle = { width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 14, boxSizing: "border-box" as const };
const buttonStyle = (disabled: boolean) => ({
  width: "100%", marginTop: 18, padding: "10px 14px", borderRadius: 6,
  border: "none", background: disabled ? "#9CA3AF" : "#111827",
  color: "#FFFFFF", cursor: disabled ? "not-allowed" : "pointer",
  fontWeight: 600, fontSize: 14,
});
