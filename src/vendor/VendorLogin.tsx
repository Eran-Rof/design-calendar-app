import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabaseVendor } from "./supabaseVendor";

export default function VendorLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div style={{ maxWidth: 400, margin: "48px auto", background: "#FFFFFF", borderRadius: 12, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
      <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: "#111827" }}>Sign in</h1>
      <p style={{ margin: 0, marginBottom: 20, color: "#6B7280", fontSize: 13 }}>
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
          <div style={{ color: "#B91C1C", fontSize: 13, marginBottom: 12 }}>{err}</div>
        )}
        <button type="submit" disabled={busy} style={buttonStyle(busy)}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
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
