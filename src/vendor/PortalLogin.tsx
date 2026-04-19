import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

interface Branding {
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  favicon_url: string | null;
  company_display_name: string | null;
  portal_welcome_message: string | null;
}

export default function PortalLogin() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [branding, setBranding] = useState<Branding | null>(null);
  const [entityName, setEntityName] = useState<string>("");
  const [brandingReady, setBrandingReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!slug) { setBrandingReady(true); return; }
      const { data: entity } = await supabaseVendor
        .from("entities")
        .select("id, name, branding:entity_branding(logo_url, primary_color, secondary_color, favicon_url, company_display_name, portal_welcome_message)")
        .eq("slug", slug)
        .maybeSingle();
      if (cancelled) return;
      if (entity) {
        setEntityName(entity.name);
        const b = Array.isArray(entity.branding) ? entity.branding[0] || null : (entity.branding as Branding | null);
        setBranding(b);
        if (b?.favicon_url) {
          const fav = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null;
          if (fav) fav.href = b.favicon_url;
        }
      }
      setBrandingReady(true);
    })();
    return () => { cancelled = true; };
  }, [slug]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { data, error } = await supabaseVendor.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) { setErr(error.message); return; }
      const { data: vu } = await supabaseVendor
        .from("vendor_users").select("id").eq("auth_id", data.user!.id).maybeSingle();
      if (!vu) {
        await supabaseVendor.auth.signOut();
        setErr("This account is not linked to a vendor. Contact your admin.");
        return;
      }
      nav("/vendor", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  if (!brandingReady) {
    return <div style={{ padding: 40, textAlign: "center", color: TH.textMuted }}>Loading…</div>;
  }

  const primaryColor = branding?.primary_color || TH.primary;
  const displayName = branding?.company_display_name || entityName || "Vendor Portal";
  const welcome = branding?.portal_welcome_message || "Use the email address that received your invite.";

  return (
    <div style={{ minHeight: "100vh", background: branding?.secondary_color || TH.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ maxWidth: 420, width: "100%", background: TH.surface, borderRadius: 12, padding: 32, boxShadow: `0 8px 32px ${TH.shadowMd}`, border: `1px solid ${TH.border}` }}>
        {branding?.logo_url && (
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <img src={branding.logo_url} alt={displayName} style={{ maxHeight: 60, maxWidth: "80%", objectFit: "contain" }} />
          </div>
        )}
        <h1 style={{ margin: "0 0 6px", fontSize: 22, color: TH.text, textAlign: "center" }}>{displayName}</h1>
        <p style={{ margin: "0 0 24px", color: TH.textMuted, fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>{welcome}</p>

        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Email</div>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inp} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: TH.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Password</div>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inp} />
          </div>
          {err && <div style={{ padding: "8px 10px", background: TH.accent, color: TH.primary, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{err}</div>}
          <button type="submit" disabled={busy} style={{ width: "100%", padding: "10px 16px", borderRadius: 6, border: "none", background: primaryColor, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 600, fontFamily: "inherit", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

const inp = { width: "100%", padding: "9px 11px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" } as const;
