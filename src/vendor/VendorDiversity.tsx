import { useEffect, useState } from "react";
import { supabaseVendor } from "./supabaseVendor";

interface Profile {
  id: string;
  business_type: string[];
  certifying_body: string | null;
  certification_number: string | null;
  certification_expiry: string | null;
  certificate_file_url: string | null;
  verified: boolean;
  verified_at: string | null;
}

const BUSINESS_TYPES = [
  { value: "minority_owned",   label: "Minority-owned" },
  { value: "women_owned",      label: "Women-owned" },
  { value: "veteran_owned",    label: "Veteran-owned" },
  { value: "lgbtq_owned",      label: "LGBTQ+-owned" },
  { value: "disability_owned", label: "Disability-owned" },
  { value: "small_business",   label: "Small business" },
  { value: "hub_zone",         label: "HUB-Zone" },
];
const CERTIFYING_BODIES = ["NMSDC", "WBENC", "NVBDC", "SBA", "NGLCC", "USBLN", "Other"];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}
async function api(path: string, init: RequestInit = {}) {
  const t = await token();
  return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
}

export default function VendorDiversity() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [types, setTypes] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await api("/api/vendor/diversity-profile");
      if (!r.ok) throw new Error(await r.text());
      const p = await r.json() as Profile | null;
      setProfile(p);
      if (p) {
        setTypes(p.business_type || []);
        setBody(p.certifying_body || "");
        setNumber(p.certification_number || "");
        setExpiry(p.certification_expiry || "");
      }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true); setErr(null); setMsg(null);
    try {
      let fileUrl: string | null = profile?.certificate_file_url || null;
      if (file) {
        if (file.size > 20 * 1024 * 1024) throw new Error("File exceeds 20MB limit.");
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", userRes.user!.id).maybeSingle();
        const vendorId = (vu as { vendor_id: string } | null)?.vendor_id;
        if (!vendorId) throw new Error("Not linked to a vendor.");
        const docId = crypto.randomUUID();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${vendorId}/diversity/${docId}/${safeName}`;
        const up = await supabaseVendor.storage.from("vendor-docs").upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
        if (up.error) throw up.error;
        fileUrl = path;
      }

      const r = await api("/api/vendor/diversity-profile", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_type: types, certifying_body: body || null, certification_number: number || null,
          certification_expiry: expiry || null, certificate_file_url: fileUrl,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setMsg("Saved. Verification will be re-done by the buyer's team.");
      await load();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  function toggleType(v: string) {
    setTypes(types.includes(v) ? types.filter((t) => t !== v) : [...types, v]);
  }

  if (loading) return <div style={{ color: C.textMuted, padding: 20 }}>Loading…</div>;

  return (
    <div style={{ color: C.text, padding: 20, maxWidth: 720 }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Diversity profile</h2>
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4, marginBottom: 16 }}>Used to match you with diversity-focused sourcing goals and to support supplier diversity reporting.</div>

      {profile?.verified && (
        <div style={{ background: "rgba(16,185,129,0.1)", border: `1px solid ${C.success}`, borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 12 }}>
          ✓ Verified on {profile.verified_at ? new Date(profile.verified_at).toLocaleDateString() : "—"}
        </div>
      )}
      {err && <div style={{ color: C.danger, marginBottom: 10 }}>{err}</div>}
      {msg && <div style={{ color: C.success, marginBottom: 10 }}>{msg}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 16 }}>
        <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>Business classification</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6, marginBottom: 18 }}>
          {BUSINESS_TYPES.map((b) => (
            <label key={b.value} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer", padding: "6px 8px", background: C.bg, border: `1px solid ${types.includes(b.value) ? C.primary : C.cardBdr}`, borderRadius: 6 }}>
              <input type="checkbox" checked={types.includes(b.value)} onChange={() => toggleType(b.value)} />
              {b.label}
            </label>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Row label="Certifying body">
            <select value={body} onChange={(e) => setBody(e.target.value)} style={inp}>
              <option value="">Select…</option>
              {CERTIFYING_BODIES.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </Row>
          <Row label="Certification number"><input value={number} onChange={(e) => setNumber(e.target.value)} style={inp} /></Row>
          <Row label="Certification expiry"><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={inp} /></Row>
          <Row label="Certificate file">
            <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ ...inp, padding: 6 }} />
            {profile?.certificate_file_url && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }}>Current: {profile.certificate_file_url.split("/").pop()}</div>}
          </Row>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save profile"}</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
