import React, { useEffect, useState } from "react";
import { TH } from "../../utils/theme";
import { useGS1Store } from "../store/gs1Store";
import type { CompanySettingsInput } from "../types";
import { maxItemReference, buildGtinFromSettings, maxSerialReference, buildSsccFromSettings } from "../services/gtinService";

const FIELD: React.CSSProperties = {
  display: "flex", flexDirection: "column", gap: 4, marginBottom: 16,
};
const LABEL: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: TH.textSub2, textTransform: "uppercase", letterSpacing: "0.04em",
};
const INPUT: React.CSSProperties = {
  padding: "8px 10px", border: `1px solid ${TH.border}`, borderRadius: 6,
  fontSize: 14, color: TH.text, background: "#fff", outline: "none",
};
const HINT: React.CSSProperties = { fontSize: 11, color: TH.textMuted, marginTop: 2 };
const SECTION: React.CSSProperties = {
  background: TH.surface, borderRadius: 10, padding: "20px 24px",
  boxShadow: `0 1px 4px ${TH.shadow}`, marginBottom: 20,
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={SECTION}>
      <h3 style={{ margin: "0 0 16px", fontSize: 15, color: TH.textSub, fontWeight: 600 }}>{title}</h3>
      {children}
    </div>
  );
}

export default function CompanySetupPanel() {
  const { companySettings, settingsLoading, settingsError, loadCompanySettings, saveCompanySettings } = useGS1Store();
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState<CompanySettingsInput>({
    company_name: "",
    gs1_prefix: "",
    prefix_length: 7,
    gtin_indicator_digit: "1",
    starting_item_reference: 1,
    next_item_reference_counter: 1,
    default_label_format: "",
    xoro_api_base_url: "",
    xoro_api_key_ref: "",
    xoro_item_endpoint: "",
    xoro_enabled: false,
    sscc_extension_digit: "0",
    sscc_starting_serial_reference: 1,
    sscc_next_serial_reference_counter: 1,
  });

  useEffect(() => {
    loadCompanySettings();
  }, []);

  useEffect(() => {
    if (companySettings) {
      setForm({
        company_name: companySettings.company_name,
        gs1_prefix: companySettings.gs1_prefix,
        prefix_length: companySettings.prefix_length,
        gtin_indicator_digit: companySettings.gtin_indicator_digit,
        starting_item_reference: companySettings.starting_item_reference,
        next_item_reference_counter: companySettings.next_item_reference_counter,
        default_label_format: companySettings.default_label_format ?? "",
        xoro_api_base_url: companySettings.xoro_api_base_url ?? "",
        xoro_api_key_ref: companySettings.xoro_api_key_ref ?? "",
        xoro_item_endpoint: companySettings.xoro_item_endpoint ?? "",
        xoro_enabled: companySettings.xoro_enabled ?? false,
        sscc_extension_digit: companySettings.sscc_extension_digit ?? "0",
        sscc_starting_serial_reference: companySettings.sscc_starting_serial_reference ?? 1,
        sscc_next_serial_reference_counter: companySettings.sscc_next_serial_reference_counter ?? 1,
      });
    }
  }, [companySettings]);

  function set(field: keyof CompanySettingsInput, value: string | number) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await saveCompanySettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  // Live preview of what a GTIN would look like
  let gtinPreview = "";
  let gtinPreviewError = "";
  try {
    if (form.gs1_prefix && form.prefix_length && form.gtin_indicator_digit) {
      const fakeSettings = {
        ...form,
        id: "", created_at: "", updated_at: "",
      } as Parameters<typeof buildGtinFromSettings>[0];
      gtinPreview = buildGtinFromSettings(fakeSettings, form.next_item_reference_counter);
    }
  } catch (err) {
    gtinPreviewError = (err as Error).message;
  }

  const maxRef = maxItemReference(form.prefix_length);
  const maxSerial = maxSerialReference(form.prefix_length);

  let ssccPreview = "";
  let ssccPreviewError = "";
  try {
    if (form.gs1_prefix && form.prefix_length && form.sscc_extension_digit) {
      const fakeSettings = {
        ...form,
        id: "", created_at: "", updated_at: "",
        default_label_format: null, xoro_api_base_url: null, xoro_api_key_ref: null,
        xoro_item_endpoint: null, xoro_enabled: false,
      } as Parameters<typeof buildSsccFromSettings>[0];
      ssccPreview = buildSsccFromSettings(fakeSettings, form.sscc_next_serial_reference_counter);
    }
  } catch (err) {
    ssccPreviewError = (err as Error).message;
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "24px 16px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, color: TH.text }}>Company Setup</h2>
      <p style={{ margin: "0 0 24px", color: TH.textMuted, fontSize: 13 }}>
        Configure your GS1 company prefix, GTIN numbering, and SSCC carton numbering. Save before generating any GTINs or SSCCs.
      </p>

      {settingsError && (
        <div style={{ background: "#FFF5F5", border: `1px solid ${TH.accentBdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, color: TH.primary, fontSize: 13 }}>
          {settingsError}
        </div>
      )}

      <form onSubmit={handleSave}>
        <Section title="Company Information">
          <div style={FIELD}>
            <label style={LABEL}>Legal Company Name</label>
            <input style={INPUT} value={form.company_name} onChange={e => set("company_name", e.target.value)} required />
          </div>
        </Section>

        <Section title="GS1 GTIN Numbering">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={FIELD}>
              <label style={LABEL}>GS1 Company Prefix</label>
              <input style={INPUT} value={form.gs1_prefix} onChange={e => set("gs1_prefix", e.target.value.replace(/\D/g, ""))} required placeholder="e.g. 0310927" />
              <span style={HINT}>Numeric digits only</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Prefix Length</label>
              <input style={INPUT} type="number" min={6} max={11} value={form.prefix_length}
                onChange={e => set("prefix_length", parseInt(e.target.value))} required />
              <span style={HINT}>Must match actual prefix digit count</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>GTIN Indicator Digit</label>
              <input style={INPUT} value={form.gtin_indicator_digit}
                onChange={e => set("gtin_indicator_digit", e.target.value.replace(/\D/g, "").slice(0, 1))}
                maxLength={1} required placeholder="1" />
              <span style={HINT}>Usually 1 — varies by product type</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Starting Item Reference</label>
              <input style={INPUT} type="number" min={1} max={maxRef} value={form.starting_item_reference}
                onChange={e => set("starting_item_reference", parseInt(e.target.value))} required />
              <span style={HINT}>Excludes prefix and check digit. Max: {maxRef.toLocaleString()}</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Next Item Reference Counter</label>
              <input style={INPUT} type="number" min={1} max={maxRef} value={form.next_item_reference_counter}
                onChange={e => set("next_item_reference_counter", parseInt(e.target.value))} required />
              <span style={HINT}>Current counter — auto-incremented on each new GTIN</span>
            </div>
          </div>

          {(gtinPreview || gtinPreviewError) && (
            <div style={{ marginTop: 12, padding: "12px 16px", background: gtinPreviewError ? "#FFF5F5" : "#F0FFF4", borderRadius: 8, border: `1px solid ${gtinPreviewError ? TH.accentBdr : "#C6F6D5"}` }}>
              {gtinPreviewError
                ? <span style={{ color: TH.primary, fontSize: 12 }}>Preview error: {gtinPreviewError}</span>
                : <>
                    <span style={{ fontSize: 12, color: TH.textMuted }}>Preview GTIN for current counter: </span>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>{gtinPreview}</span>
                  </>
              }
            </div>
          )}
        </Section>

        <Section title="GS1 SSCC Numbering">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={FIELD}>
              <label style={LABEL}>SSCC Extension Digit</label>
              <input style={INPUT} value={form.sscc_extension_digit}
                onChange={e => set("sscc_extension_digit", e.target.value.replace(/\D/g, "").slice(0, 1))}
                maxLength={1} required placeholder="0" />
              <span style={HINT}>Usually 0 — identifies the shipping company</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Starting Serial Reference</label>
              <input style={INPUT} type="number" min={1} max={maxSerial}
                value={form.sscc_starting_serial_reference}
                onChange={e => set("sscc_starting_serial_reference", parseInt(e.target.value))} required />
              <span style={HINT}>Max: {maxSerial.toLocaleString()}</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Next Serial Reference Counter</label>
              <input style={INPUT} type="number" min={1} max={maxSerial}
                value={form.sscc_next_serial_reference_counter}
                onChange={e => set("sscc_next_serial_reference_counter", parseInt(e.target.value))} required />
              <span style={HINT}>Auto-incremented on each new SSCC carton</span>
            </div>
          </div>

          {(ssccPreview || ssccPreviewError) && (
            <div style={{ marginTop: 12, padding: "12px 16px", background: ssccPreviewError ? "#FFF5F5" : "#F0FFF4", borderRadius: 8, border: `1px solid ${ssccPreviewError ? TH.accentBdr : "#C6F6D5"}` }}>
              {ssccPreviewError
                ? <span style={{ color: TH.primary, fontSize: 12 }}>Preview error: {ssccPreviewError}</span>
                : <>
                    <span style={{ fontSize: 12, color: TH.textMuted }}>Preview SSCC for current counter: </span>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 15 }}>(00) {ssccPreview}</span>
                  </>
              }
            </div>
          )}
        </Section>

        <Section title="Label Output">
          <div style={FIELD}>
            <label style={LABEL}>Default Label Format</label>
            <input style={INPUT} value={form.default_label_format} onChange={e => set("default_label_format", e.target.value)} placeholder="e.g. 4x6_PDF" />
          </div>
        </Section>

        <Section title="Xoro API (Optional)">
          <div style={FIELD}>
            <label style={LABEL}>
              <span>Enable Xoro Sync</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.xoro_enabled}
                onChange={e => setForm(f => ({ ...f, xoro_enabled: e.target.checked }))}
                style={{ width: 16, height: 16 }}
              />
              <span style={{ fontSize: 13, color: TH.text }}>
                Allow UPC sync from Xoro API
              </span>
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={FIELD}>
              <label style={LABEL}>Xoro API Base URL</label>
              <input style={INPUT} value={form.xoro_api_base_url}
                onChange={e => set("xoro_api_base_url", e.target.value)}
                placeholder="https://api.xorosoft.com/api/xoro" />
              <span style={HINT}>Root URL — no trailing slash</span>
            </div>
            <div style={FIELD}>
              <label style={LABEL}>Item Endpoint Path</label>
              <input style={INPUT} value={form.xoro_item_endpoint}
                onChange={e => set("xoro_item_endpoint", e.target.value)}
                placeholder="/v1/items" />
              <span style={HINT}>Appended to base URL (e.g. /v1/items or ItemMasterList)</span>
            </div>
          </div>
          <div style={FIELD}>
            <label style={LABEL}>API Key</label>
            <input style={INPUT} value={form.xoro_api_key_ref}
              onChange={e => set("xoro_api_key_ref", e.target.value)}
              placeholder="xoro_live_xxxxxxxxxxxx" type="password" />
            <span style={HINT}>Sent as Bearer token. Stored in DB — use a read-only API key.</span>
          </div>
        </Section>

        <div style={{ display: "flex", gap: 12 }}>
          <button
            type="submit"
            disabled={settingsLoading}
            style={{
              background: TH.primary, color: "#fff", border: "none", borderRadius: 8,
              padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer",
            }}
          >
            {settingsLoading ? "Saving…" : "Save Settings"}
          </button>
          {saved && <span style={{ alignSelf: "center", color: "#276749", fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
        </div>
      </form>
    </div>
  );
}
