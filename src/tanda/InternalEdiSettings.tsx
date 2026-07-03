// src/tanda/InternalEdiSettings.tsx
//
// Tangerine — EDI Settings (VAN / interchange configuration).
//
// A single per-entity config form: VAN provider / host / credentials, our
// ISA/GS sender qualifiers + IDs, and a test/production toggle. Wraps
// /api/internal/edi/settings (GET current · PUT upsert).
//
// SCOPE: this is CONFIG only — live transport over the VAN (AS2 / SFTP delivery)
// is a follow-up. The VAN password is a PLACEHOLDER field (stored as-is, not yet
// encrypted at rest).

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 16px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "8px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  boxSizing: "border-box", colorScheme: "dark",
};

type Settings = {
  id?: string;
  van_provider: string;
  van_host: string;
  van_username: string;
  van_password_enc: string;
  isa_sender_qualifier: string;
  isa_sender_id: string;
  gs_sender_id: string;
  test_mode: boolean;
  is_active: boolean;
};

const EMPTY: Settings = {
  van_provider: "", van_host: "", van_username: "", van_password_enc: "",
  isa_sender_qualifier: "", isa_sender_id: "", gs_sender_id: "",
  test_mode: true, is_active: true,
};

export default function InternalEdiSettings() {
  const [form, setForm] = useState<Settings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [existing, setExisting] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/edi/settings");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json() as Settings | null;
      if (data) {
        setExisting(true);
        setForm({
          ...EMPTY,
          ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? (typeof EMPTY[k as keyof Settings] === "boolean" ? false : "")])),
          test_mode: data.test_mode ?? true,
          is_active: data.is_active ?? true,
        } as Settings);
      } else {
        setExisting(false);
        setForm(EMPTY);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    const env = form.test_mode ? "TEST" : "PRODUCTION";
    if (!(await confirmDialog(`Save EDI VAN settings for the ${env} environment?`, { confirmText: "Save", danger: !form.test_mode }))) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch("/api/internal/edi/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("EDI settings saved", "success");
      setExisting(true);
      await load();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      notify(`Save failed: ${m}`, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>EDI Settings</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>{existing ? "Configured" : "Not yet configured"}</span>
      </div>
      <p style={{ color: C.textMuted, fontSize: 13, marginTop: 0, maxWidth: 720 }}>
        VAN / interchange configuration used to build outbound X12 ISA/GS envelopes.
        Config only — live transport over the VAN (AS2 / SFTP delivery) is a planned follow-up.
      </p>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, color: C.textMuted }}>Loading…</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, maxWidth: 760 }}>
          <SectionTitle>Value-Added Network (VAN)</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
            <Field label="VAN provider">
              <input style={inputStyle} value={form.van_provider} onChange={(e) => set("van_provider", e.target.value)} placeholder="e.g. SPS Commerce, TrueCommerce, Cleo" />
            </Field>
            <Field label="VAN host">
              <input style={inputStyle} value={form.van_host} onChange={(e) => set("van_host", e.target.value)} placeholder="sftp.example.com" />
            </Field>
            <Field label="VAN username">
              <input style={inputStyle} value={form.van_username} onChange={(e) => set("van_username", e.target.value)} autoComplete="off" />
            </Field>
            <Field label="VAN password">
              <input style={inputStyle} type="password" value={form.van_password_enc} onChange={(e) => set("van_password_enc", e.target.value)} autoComplete="new-password" />
              <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>Stored as plain text for now — encryption at rest is a follow-up.</div>
            </Field>
          </div>

          <SectionTitle>Our interchange identity (ISA / GS)</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 18 }}>
            <Field label="ISA sender qualifier">
              <input style={inputStyle} value={form.isa_sender_qualifier} onChange={(e) => set("isa_sender_qualifier", e.target.value)} placeholder="e.g. ZZ or 01" />
            </Field>
            <Field label="ISA sender ID">
              <input style={inputStyle} value={form.isa_sender_id} onChange={(e) => set("isa_sender_id", e.target.value)} placeholder="ISA06" />
            </Field>
            <Field label="GS sender ID">
              <input style={inputStyle} value={form.gs_sender_id} onChange={(e) => set("gs_sender_id", e.target.value)} placeholder="GS02" />
            </Field>
          </div>

          <SectionTitle>Environment</SectionTitle>
          <div style={{ display: "flex", gap: 24, alignItems: "center", marginBottom: 20 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub }}>
              <input type="checkbox" checked={form.test_mode} onChange={(e) => set("test_mode", e.target.checked)} />
              Test mode <span style={{ color: C.textMuted, fontSize: 11 }}>(ISA15 = {form.test_mode ? "T" : "P"})</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textSub }}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => set("is_active", e.target.checked)} />
              Active
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={btnPrimary} disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: C.textSub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10, borderBottom: `1px solid ${C.cardBdr}`, paddingBottom: 6 }}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}
