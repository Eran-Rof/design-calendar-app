import { useEffect, useState } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

type StepName = "company_info" | "banking" | "tax" | "compliance_docs" | "portal_tour" | "agreement";
const ORDER: StepName[] = ["company_info", "banking", "tax", "compliance_docs", "portal_tour", "agreement"];
const LABELS: Record<StepName, string> = {
  company_info: "Company info",
  banking: "Banking",
  tax: "Tax",
  compliance_docs: "Compliance docs",
  portal_tour: "Portal tour",
  agreement: "Agreement",
};

interface WorkflowResponse {
  workflow: {
    id: string;
    status: "not_started" | "in_progress" | "pending_review" | "approved" | "rejected";
    current_step: number;
    completed_steps: string[];
    rejection_reason: string | null;
  };
  steps: { step_name: StepName; status: string; data: Record<string, unknown> | null }[];
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await token();
  const r = await fetch(path, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json() as Promise<T>;
}

export default function VendorOnboarding() {
  const [wf, setWf] = useState<WorkflowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const data = await api<WorkflowResponse>("/api/vendor/onboarding", { method: "POST" });
      setWf(data);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function submitStep(stepName: StepName, data: Record<string, unknown>) {
    const res = await api<{ ok: boolean; workflow_status: string }>(`/api/vendor/onboarding/steps/${stepName}`, {
      method: "PUT",
      body: JSON.stringify({ data }),
    });
    await load();
    return res;
  }

  async function submitReview() {
    await api("/api/vendor/onboarding/submit", { method: "POST" });
    await load();
  }

  if (loading) return <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading onboarding…</div>;
  if (err) return <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!wf) return null;

  const { workflow, steps } = wf;
  const completedSet = new Set(workflow.completed_steps);
  const currentStepName = ORDER[workflow.current_step] || "agreement";
  const allDone = completedSet.size === ORDER.length;
  const progressPct = Math.round((completedSet.size / ORDER.length) * 100);

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ color: "#FFFFFF", fontSize: 22, margin: "0 0 6px" }}>Vendor onboarding</h2>
      <div style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, marginBottom: 20 }}>
        Complete all 6 steps to activate your account. You won't be able to submit invoices until we've approved your workflow.
      </div>

      {/* Progress bar */}
      <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 999, height: 8, overflow: "hidden", marginBottom: 8 }}>
        <div style={{ background: TH.primary, height: "100%", width: `${progressPct}%`, transition: "width 0.3s" }} />
      </div>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginBottom: 20 }}>
        {completedSet.size} of {ORDER.length} steps complete ({progressPct}%)
      </div>

      {/* Step indicator */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {ORDER.map((name, i) => {
          const done = completedSet.has(name);
          const current = name === currentStepName && !done && workflow.status !== "approved";
          const bg = done ? "#047857" : current ? TH.primary : "rgba(255,255,255,0.12)";
          return (
            <div key={name} style={{ padding: "6px 10px", borderRadius: 6, background: bg, color: "#FFFFFF", fontSize: 12, fontWeight: 600 }}>
              {done ? "✓ " : `${i + 1}. `}{LABELS[name]}
            </div>
          );
        })}
      </div>

      {/* State banners */}
      {workflow.status === "approved" && (
        <div style={{ padding: "16px 18px", background: "#F0FFF4", border: "1px solid #C6F6D5", borderRadius: 8, color: "#276749", marginBottom: 16 }}>
          <b>Approved.</b> Your account is active — you can submit invoices and use all portal features.
        </div>
      )}
      {workflow.status === "pending_review" && (
        <div style={{ padding: "16px 18px", background: "#EBF4FF", border: "1px solid #BEE3F8", borderRadius: 8, color: "#2B6CB0", marginBottom: 16 }}>
          <b>Under review</b> — we'll notify you when approved. Usually within 1-2 business days.
        </div>
      )}
      {workflow.status === "rejected" && workflow.rejection_reason && (
        <div style={{ padding: "16px 18px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 8, color: TH.primary, marginBottom: 16 }}>
          <b>Updates needed:</b> {workflow.rejection_reason}
        </div>
      )}

      {/* Current step form */}
      {workflow.status !== "approved" && !allDone && (
        <StepForm
          stepName={currentStepName}
          initial={(steps.find((s) => s.step_name === currentStepName)?.data || null) as Record<string, unknown> | null}
          onSubmit={(payload) => submitStep(currentStepName, payload)}
        />
      )}

      {/* Submit-for-review button */}
      {workflow.status !== "approved" && workflow.status !== "pending_review" && allDone && (
        <div style={{ marginTop: 16 }}>
          <button onClick={() => void submitReview()} style={btnPrimary}>Submit for review</button>
        </div>
      )}
    </div>
  );
}

function StepForm({ stepName, initial, onSubmit }: { stepName: StepName; initial: Record<string, unknown> | null; onSubmit: (data: Record<string, unknown>) => Promise<{ workflow_status: string; ok: boolean }> }) {
  if (stepName === "company_info") return <CompanyInfoStep initial={initial} onSubmit={onSubmit} />;
  if (stepName === "banking") return <BankingStep onSubmit={onSubmit} />;
  if (stepName === "tax") return <TaxStep initial={initial} onSubmit={onSubmit} />;
  if (stepName === "compliance_docs") return <ComplianceStep onSubmit={onSubmit} />;
  if (stepName === "portal_tour") return <TourStep onSubmit={onSubmit} />;
  if (stepName === "agreement") return <AgreementStep onSubmit={onSubmit} />;
  return null;
}

function CompanyInfoStep({ initial, onSubmit }: { initial: Record<string, unknown> | null; onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [legalName, setLegalName] = useState(String((initial?.legal_name as string) || ""));
  const [address, setAddress] = useState(String((initial?.address as string) || ""));
  const [taxId, setTaxId] = useState(String((initial?.tax_id as string) || ""));
  const [businessType, setBusinessType] = useState(String((initial?.business_type as string) || ""));
  const [yearFounded, setYearFounded] = useState(String((initial?.year_founded as string) || ""));
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!legalName.trim() || !address.trim() || !businessType.trim() || !yearFounded.trim()) {
      alert("Legal name, address, business type, and year founded are required."); return;
    }
    setSaving(true);
    try {
      await onSubmit({ legal_name: legalName.trim(), address: address.trim(), tax_id: taxId.trim(), business_type: businessType.trim(), year_founded: yearFounded.trim() });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 1: Company info">
      <Field label="Legal business name"><input value={legalName} onChange={(e) => setLegalName(e.target.value)} style={inp} /></Field>
      <Field label="Business address"><textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Tax ID (EIN / VAT) — optional"><input value={taxId} onChange={(e) => setTaxId(e.target.value)} style={inp} /></Field>
        <Field label="Business type">
          <select value={businessType} onChange={(e) => setBusinessType(e.target.value)} style={inp}>
            <option value="">Select…</option>
            <option value="corporation">Corporation</option>
            <option value="llc">LLC</option>
            <option value="partnership">Partnership</option>
            <option value="sole_proprietor">Sole proprietor</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>
      <Field label="Year founded"><input value={yearFounded} onChange={(e) => setYearFounded(e.target.value)} type="number" style={inp} /></Field>
      <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save and continue"}</button>
    </Card>
  );
}

function BankingStep({ onSubmit }: { onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [accountName, setAccountName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountType, setAccountType] = useState("checking");
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!accountName.trim() || !bankName.trim() || !accountNumber.trim() || !routingNumber.trim()) {
      alert("All fields are required."); return;
    }
    setSaving(true);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/banking", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ account_name: accountName.trim(), bank_name: bankName.trim(), account_number: accountNumber, routing_number: routingNumber, account_type: accountType, currency }),
      });
      if (!r.ok) throw new Error(await r.text());
      const bd = await r.json();
      await onSubmit({ banking_detail_id: bd.id });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 2: Banking">
      <p style={{ color: TH.textSub2, fontSize: 13, marginTop: 0 }}>
        Account and routing numbers are AES-256 encrypted at rest. Only the last 4 digits are ever shown back.
      </p>
      <Field label="Account holder name"><input value={accountName} onChange={(e) => setAccountName(e.target.value)} style={inp} /></Field>
      <Field label="Bank name"><input value={bankName} onChange={(e) => setBankName(e.target.value)} style={inp} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Account number"><input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} style={inp} /></Field>
        <Field label="Routing number"><input value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value)} style={inp} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Account type">
          <select value={accountType} onChange={(e) => setAccountType(e.target.value)} style={inp}>
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="wire">Wire</option>
          </select>
        </Field>
        <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} style={inp} /></Field>
      </div>
      <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save and continue"}</button>
    </Card>
  );
}

function TaxStep({ initial, onSubmit }: { initial: Record<string, unknown> | null; onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [classification, setClassification] = useState(String((initial?.classification as string) || "W-9"));
  const [file, setFile] = useState<File | null>(null);
  const [existingUrl] = useState(String((initial?.document_url as string) || ""));
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      let docUrl = existingUrl;
      if (file) {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not authenticated");
        const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
        const vid = (vu as { vendor_id: string } | null)?.vendor_id;
        if (!vid) throw new Error("Not linked to a vendor");
        const path = `${vid}/tax/${Date.now()}_${file.name}`;
        const { error: upErr } = await supabaseVendor.storage.from("vendor-docs").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        docUrl = path;
      }
      if (!docUrl) { alert("Please upload a tax document."); setSaving(false); return; }
      await onSubmit({ classification, document_url: docUrl });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 3: Tax">
      <p style={{ color: TH.textSub2, fontSize: 13, marginTop: 0 }}>Upload your W-9 (US) or W-8BEN (non-US) form.</p>
      <Field label="Classification">
        <select value={classification} onChange={(e) => setClassification(e.target.value)} style={inp}>
          <option value="W-9">W-9 (US entity)</option>
          <option value="W-8BEN">W-8BEN (non-US entity)</option>
        </select>
      </Field>
      <Field label="Tax document (PDF)">
        <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        {existingUrl && !file && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 4 }}>Previously uploaded — re-upload to replace, or continue with existing.</div>}
      </Field>
      <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save and continue"}</button>
    </Card>
  );
}

function ComplianceStep({ onSubmit }: { onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [saving, setSaving] = useState(false);
  async function submit() {
    setSaving(true);
    try {
      await onSubmit({ acknowledged: true });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }
  return (
    <Card title="Step 4: Compliance docs">
      <p style={{ color: TH.textSub2, fontSize: 13, marginTop: 0 }}>
        Upload all required compliance documents from the Compliance tab. Come back here once they're submitted — we'll verify on the next step.
      </p>
      <a href="/vendor/compliance" style={{ ...btnSecondary, display: "inline-block", marginBottom: 12, textDecoration: "none" }}>Open Compliance →</a>
      <div>
        <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Checking…" : "I've uploaded everything — verify and continue"}</button>
      </div>
      <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 8 }}>
        The server checks that every required document type has a submitted or approved doc. If something's missing, you'll get a specific error.
      </div>
    </Card>
  );
}

function TourStep({ onSubmit }: { onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [saving, setSaving] = useState(false);
  async function submit() {
    setSaving(true);
    try { await onSubmit({ completed_at: new Date().toISOString() }); }
    finally { setSaving(false); }
  }
  return (
    <Card title="Step 5: Portal tour">
      <p style={{ color: TH.textSub2, fontSize: 13, marginTop: 0 }}>A quick tour of what's here:</p>
      <ul style={{ color: TH.textSub2, fontSize: 13, lineHeight: 1.8 }}>
        <li><b>Purchase Orders</b> — acknowledge and track POs.</li>
        <li><b>Shipments</b> — submit ASN + tracking.</li>
        <li><b>Invoices</b> — submit invoices against a PO.</li>
        <li><b>Compliance</b> — upload insurance, certifications, tax forms.</li>
        <li><b>Messages</b> — chat with the internal team per-PO.</li>
        <li><b>Reports & Scorecard</b> — your performance over time.</li>
      </ul>
      <button onClick={() => void submit()} style={btnPrimary} disabled={saving}>I've completed the tour</button>
    </Card>
  );
}

function AgreementStep({ onSubmit }: { onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!accepted) return;
    setSaving(true);
    try {
      let ip = "";
      try {
        const r = await fetch("https://api.ipify.org?format=json");
        if (r.ok) ip = (await r.json()).ip || "";
      } catch { /* ignore */ }
      await onSubmit({ accepted_at: new Date().toISOString(), ip: ip || "unknown" });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 6: Agreement">
      <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 0, padding: "12px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, maxHeight: 200, overflowY: "auto" }}>
        <p><b>Vendor Portal Terms of Service</b></p>
        <p>By completing this onboarding, you agree to submit accurate PO acknowledgments, shipments, and invoices through this portal. Payment terms follow the terms specified on each PO. You will maintain current compliance documentation. Breach of these terms may result in account suspension. Your acceptance timestamp and IP address will be recorded for audit purposes.</p>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0", fontSize: 14, color: TH.text }}>
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        I agree to the Vendor Portal Terms of Service
      </label>
      <button onClick={() => void submit()} disabled={!accepted || saving} style={{ ...btnPrimary, opacity: !accepted ? 0.5 : 1 }}>
        {saving ? "Submitting…" : "Accept and finish"}
      </button>
    </Card>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: "20px 22px", boxShadow: `0 1px 2px ${TH.shadow}` }}>
      <h3 style={{ margin: "0 0 14px", color: TH.text, fontSize: 16 }}>{title}</h3>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const btnPrimary = { padding: "10px 20px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: TH.surfaceHi, color: TH.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
