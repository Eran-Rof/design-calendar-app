import { useEffect, useState } from "react";

interface Branding {
  entity_id?: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  favicon_url: string | null;
  company_display_name: string | null;
  portal_welcome_message: string | null;
  email_from_name: string | null;
  email_from_address: string | null;
  custom_domain: string | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalEntityBranding({ entityId, onClose, onSaved }: { entityId: string; onClose: () => void; onSaved: () => void }) {
  const [branding, setBranding] = useState<Branding>({
    logo_url: null, primary_color: null, secondary_color: null, favicon_url: null,
    company_display_name: null, portal_welcome_message: null,
    email_from_name: null, email_from_address: null, custom_domain: null,
  });
  const [entityName, setEntityName] = useState("");
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [eRes, bRes] = await Promise.all([
          fetch(`/api/internal/entities?flat=true`).then((r) => r.ok ? r.json() : []),
          fetch(`/api/internal/entities/${entityId}/branding`).then((r) => r.ok ? r.json() : null),
        ]);
        const entity = (eRes as { id: string; name: string; slug: string }[]).find((e) => e.id === entityId);
        if (entity) { setEntityName(entity.name); setSlug(entity.slug); }
        if (bRes) setBranding({ ...branding, ...bRes });
      } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoading(false); }
    })();
  }, [entityId]);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(`/api/internal/entities/${entityId}/branding`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(branding),
      });
      if (!r.ok) throw new Error(await r.text());
      onSaved();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  function update<K extends keyof Branding>(k: K, v: Branding[K]) { setBranding((b) => ({ ...b, [k]: v })); }

  if (loading) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div onClick={onClose} style={{ color: C.textMuted, fontSize: 13, cursor: "pointer", marginBottom: 10 }}>← Back to entities</div>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Branding — {entityName}</h2>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Editor */}
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: "18px 22px" }}>
          <Row label="Company display name"><input value={branding.company_display_name || ""} onChange={(e) => update("company_display_name", e.target.value || null)} style={inp} /></Row>
          <Row label="Portal welcome message"><textarea value={branding.portal_welcome_message || ""} onChange={(e) => update("portal_welcome_message", e.target.value || null)} rows={3} style={{ ...inp, resize: "vertical" }} /></Row>
          <Row label="Logo URL"><input value={branding.logo_url || ""} onChange={(e) => update("logo_url", e.target.value || null)} placeholder="https://…" style={inp} /></Row>
          <Row label="Favicon URL"><input value={branding.favicon_url || ""} onChange={(e) => update("favicon_url", e.target.value || null)} placeholder="https://…" style={inp} /></Row>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Row label="Primary color">
              <div style={{ display: "flex", gap: 6 }}>
                <input type="color" value={branding.primary_color || "#C8210A"} onChange={(e) => update("primary_color", e.target.value)} style={{ width: 40, height: 34, border: `1px solid ${C.cardBdr}`, borderRadius: 6, background: C.bg }} />
                <input value={branding.primary_color || ""} onChange={(e) => update("primary_color", e.target.value || null)} placeholder="#C8210A" style={{ ...inp, flex: 1 }} />
              </div>
            </Row>
            <Row label="Secondary color">
              <div style={{ display: "flex", gap: 6 }}>
                <input type="color" value={branding.secondary_color || "#4A5568"} onChange={(e) => update("secondary_color", e.target.value)} style={{ width: 40, height: 34, border: `1px solid ${C.cardBdr}`, borderRadius: 6, background: C.bg }} />
                <input value={branding.secondary_color || ""} onChange={(e) => update("secondary_color", e.target.value || null)} placeholder="#4A5568" style={{ ...inp, flex: 1 }} />
              </div>
            </Row>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Row label="Email from name"><input value={branding.email_from_name || ""} onChange={(e) => update("email_from_name", e.target.value || null)} style={inp} /></Row>
            <Row label="Email from address"><input value={branding.email_from_address || ""} onChange={(e) => update("email_from_address", e.target.value || null)} type="email" style={inp} /></Row>
          </div>
          <Row label="Custom domain">
            <input value={branding.custom_domain || ""} onChange={(e) => update("custom_domain", e.target.value || null)} placeholder="vendors.example.com" style={inp} />
          </Row>
          {branding.custom_domain && (
            <div style={{ padding: "10px 12px", background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6, fontSize: 11, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
              <b style={{ color: C.warn }}>DNS instructions:</b> add a CNAME record:<br />
              <span style={{ color: C.textSub }}>{branding.custom_domain} → cname.vercel-dns.com</span>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button onClick={onClose} style={btnSecondary}>Cancel</button>
            <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>

        {/* Live preview */}
        <div style={{ background: branding.secondary_color || "#4A5568", borderRadius: 10, padding: 20, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 460 }}>
          <div style={{ width: 360, background: "#FFFFFF", borderRadius: 12, padding: 28, boxShadow: "0 8px 32px rgba(0,0,0,0.3)" }}>
            {branding.logo_url && <div style={{ textAlign: "center", marginBottom: 16 }}><img src={branding.logo_url} alt="" style={{ maxHeight: 50, maxWidth: "80%" }} /></div>}
            <h1 style={{ margin: "0 0 6px", fontSize: 20, color: "#1A202C", textAlign: "center" }}>{branding.company_display_name || entityName || "Vendor Portal"}</h1>
            <p style={{ margin: "0 0 20px", color: "#718096", fontSize: 12, textAlign: "center", lineHeight: 1.5 }}>{branding.portal_welcome_message || "Use the email address that received your invite."}</p>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: "#718096", fontWeight: 700, textTransform: "uppercase", marginBottom: 3 }}>Email</div>
              <div style={{ padding: "8px 10px", border: "1px solid #CBD5E0", borderRadius: 6, fontSize: 12, color: "#CBD5E0" }}>vendor@example.com</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#718096", fontWeight: 700, textTransform: "uppercase", marginBottom: 3 }}>Password</div>
              <div style={{ padding: "8px 10px", border: "1px solid #CBD5E0", borderRadius: 6, fontSize: 12, color: "#CBD5E0" }}>••••••••</div>
            </div>
            <div style={{ width: "100%", padding: "9px 12px", borderRadius: 6, background: branding.primary_color || "#C8210A", color: "#FFFFFF", textAlign: "center", fontSize: 13, fontWeight: 600 }}>Sign in</div>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 10 }}>Preview URL: /portal/{slug}/login</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
