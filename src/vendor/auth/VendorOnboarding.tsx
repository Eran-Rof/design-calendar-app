import { useEffect, useState } from "react";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import { TH } from "../theme";
import { supabaseVendor } from "../supabaseVendor";
import { showAlert } from "../ui/AppDialog";

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
  // Which step the operator is currently looking at. null = "follow the
  // workflow's current step". Set when they click a completed/current step
  // pill to go back and review (and optionally edit) previously entered data.
  const [viewStep, setViewStep] = useState<StepName | null>(null);

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
    // The step API expects `skip` / `skip_reason` at the TOP LEVEL of the body
    // (siblings of `data`), not nested inside it. The compliance-docs "I
    // currently do not have any" affordance passes them through onSubmit
    // alongside the step data, so hoist them out here — otherwise the server
    // never sees skip:true, runs the required-docs check, and rejects with
    // "N required compliance document(s) still need to be uploaded".
    const { skip, skip_reason, ...stepData } = data || {};
    const body: Record<string, unknown> = { data: stepData };
    if (skip) {
      body.skip = true;
      if (skip_reason !== undefined) body.skip_reason = skip_reason;
    }
    const res = await api<{ ok: boolean; workflow_status: string }>(`/api/vendor/onboarding/steps/${stepName}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await load();
    // Saving snaps the view back to the workflow's (possibly advanced) current
    // step so the operator resumes the natural flow after editing a past step.
    setViewStep(null);
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

  // Step-pill navigation: while the workflow is still editable, the operator
  // can click any completed step (or the active current step) to go back and
  // review/edit the data they entered. Steps they haven't reached yet stay
  // locked — the server enforces the sequential rule anyway.
  const editable = workflow.status !== "approved" && workflow.status !== "pending_review";
  const canView = (name: StepName) => editable && (completedSet.has(name) || name === currentStepName);
  const activeStep: StepName = viewStep && canView(viewStep) ? viewStep : currentStepName;
  const reviewingPast = activeStep !== currentStepName;

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

      {/* Step indicator — click a completed/current pill to review that step. */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
        {ORDER.map((name, i) => {
          const done = completedSet.has(name);
          const current = name === currentStepName && !done && workflow.status !== "approved";
          const clickable = canView(name);
          const viewing = name === activeStep && editable;
          const bg = done ? "#047857" : current ? TH.primary : "rgba(255,255,255,0.12)";
          return (
            <button
              key={name}
              type="button"
              onClick={clickable ? () => setViewStep(name) : undefined}
              disabled={!clickable}
              aria-current={viewing ? "step" : undefined}
              title={clickable ? `Review ${LABELS[name]}` : `${LABELS[name]} — not available yet`}
              style={{
                padding: "6px 10px", borderRadius: 6, background: bg, color: "#FFFFFF",
                fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                // A constant-width transparent border keeps layout stable; the
                // viewed pill gets a white ring so the operator sees where they are.
                border: viewing ? "2px solid #FFFFFF" : "2px solid transparent",
                cursor: clickable ? "pointer" : "default",
                opacity: clickable ? 1 : 0.8,
              }}
            >
              {done ? "✓ " : `${i + 1}. `}{LABELS[name]}
            </button>
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

      {/* Active step form — the workflow's current step, or a completed step
          the operator clicked back to. `key` forces a remount so each step's
          form re-seeds from its own saved data. */}
      {editable && ((viewStep && canView(viewStep)) || (!viewStep && !allDone)) && (
        <>
          {reviewingPast && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "rgba(255,255,255,0.06)", border: `1px solid ${TH.border}`, borderRadius: 8, marginBottom: 12, fontSize: 13, color: "rgba(255,255,255,0.85)" }}>
              <span>Reviewing a completed step — saving here updates your submission.</span>
              <button type="button" onClick={() => setViewStep(null)} style={{ ...btnSecondary, marginLeft: "auto", whiteSpace: "nowrap" }}>
                Back to current step →
              </button>
            </div>
          )}
          <StepForm
            key={activeStep}
            stepName={activeStep}
            initial={(steps.find((s) => s.step_name === activeStep)?.data || null) as Record<string, unknown> | null}
            onSubmit={(payload) => submitStep(activeStep, payload)}
          />
        </>
      )}

      {/* Submit-for-review button (natural flow only, not while reviewing a past step) */}
      {editable && allDone && !viewStep && (
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
      void showAlert({ title: "Missing fields", message: "Legal name, address, business type, and year founded are required.", tone: "warn" }); return;
    }
    setSaving(true);
    try {
      await onSubmit({ legal_name: legalName.trim(), address: address.trim(), tax_id: taxId.trim(), business_type: businessType.trim(), year_founded: yearFounded.trim() });
    } catch (e: unknown) {
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 1: Company info">
      <Field label="Legal business name"><input value={legalName} onChange={(e) => setLegalName(e.target.value)} style={inp} /></Field>
      <Field label="Business address"><textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Tax ID (EIN / VAT) — optional"><input value={taxId} onChange={(e) => setTaxId(e.target.value)} style={inp} /></Field>
        <Field label="Business type">
          <SearchableSelect
            value={businessType || null}
            onChange={(v) => setBusinessType(v)}
            placeholder="Select…"
            options={[
              { value: "corporation", label: "Corporation" },
              { value: "llc", label: "LLC" },
              { value: "partnership", label: "Partnership" },
              { value: "sole_proprietor", label: "Sole proprietor" },
              { value: "other", label: "Other" },
            ]}
            inputStyle={inp}
          />
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
      void showAlert({ title: "Missing fields", message: "All fields are required.", tone: "warn" }); return;
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
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
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
          <SearchableSelect
            value={accountType}
            onChange={(v) => setAccountType(v)}
            options={[
              { value: "checking", label: "Checking" },
              { value: "savings", label: "Savings" },
              { value: "wire", label: "Wire" },
            ]}
            inputStyle={inp}
          />
        </Field>
        <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} style={inp} /></Field>
      </div>
      <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save and continue"}</button>
    </Card>
  );
}

function TaxStep({ initial, onSubmit }: { initial: Record<string, unknown> | null; onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const initialCollect = typeof initial?.collect_tax === "boolean" ? (initial.collect_tax as boolean) : false;
  const [collectTax, setCollectTax] = useState<boolean>(initialCollect);
  const [classification, setClassification] = useState(String((initial?.classification as string) || "W-9"));
  const [file, setFile] = useState<File | null>(null);
  const [existingUrl] = useState(String((initial?.document_url as string) || ""));
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      if (!collectTax) {
        await onSubmit({ collect_tax: false });
        return;
      }
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
      if (!docUrl) { void showAlert({ title: "Missing tax document", message: "Please upload a tax document.", tone: "warn" }); setSaving(false); return; }
      await onSubmit({ collect_tax: true, classification, document_url: docUrl });
    } catch (e: unknown) {
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally { setSaving(false); }
  }

  return (
    <Card title="Step 3: Tax">
      <p style={{ color: TH.textSub2, fontSize: 13, marginTop: 0 }}>
        Do you collect and remit sales or VAT tax on your invoices to Ring of Fire?
      </p>
      <div style={{ display: "flex", gap: 14, marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: TH.text, cursor: "pointer" }}>
          <input type="radio" name="collect_tax" checked={!collectTax} onChange={() => setCollectTax(false)} />
          No — I do not collect tax
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: TH.text, cursor: "pointer" }}>
          <input type="radio" name="collect_tax" checked={collectTax} onChange={() => setCollectTax(true)} />
          Yes — I collect sales/VAT tax
        </label>
      </div>
      {collectTax && (
        <>
          <Field label="Classification">
            <SearchableSelect
              value={classification}
              onChange={(v) => setClassification(v)}
              options={[
                { value: "W-9", label: "W-9 (US entity)" },
                { value: "W-8BEN", label: "W-8BEN (non-US entity)" },
              ]}
              inputStyle={inp}
            />
          </Field>
          <Field label="Tax document (PDF)">
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            {existingUrl && !file && <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 4 }}>Previously uploaded — re-upload to replace, or continue with existing.</div>}
          </Field>
        </>
      )}
      <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save and continue"}</button>
    </Card>
  );
}

function ComplianceStep({ onSubmit }: { onSubmit: (d: Record<string, unknown>) => Promise<unknown> }) {
  const [saving, setSaving] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  async function submit() {
    setSaving(true);
    try {
      await onSubmit({ acknowledged: true });
    } catch (e: unknown) {
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
    } finally { setSaving(false); }
  }
  async function submitSkip() {
    setSaving(true);
    try {
      await onSubmit({ skip: true, skip_reason: "no_docs" });
      setConfirmSkip(false);
    } catch (e: unknown) {
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
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
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${TH.border}` }}>
        <button
          onClick={() => setConfirmSkip(true)}
          disabled={saving}
          style={btnSkip}
          aria-label="I currently do not have any compliance documents"
        >
          I currently do not have any
        </button>
        <div style={{ fontSize: 12, color: TH.textMuted, marginTop: 6 }}>
          No documents to share yet? You can continue onboarding — our team will follow up before you can submit invoices.
        </div>
      </div>
      {confirmSkip && (
        <ConfirmSkipModal
          saving={saving}
          onCancel={() => setConfirmSkip(false)}
          onConfirm={() => void submitSkip()}
        />
      )}
    </Card>
  );
}

function ConfirmSkipModal({
  saving,
  onCancel,
  onConfirm,
}: {
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-skip-title"
      onClick={(e) => { if (e.currentTarget === e.target && !saving) onCancel(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        style={{
          background: TH.surface,
          border: `1px solid ${TH.border}`,
          borderRadius: 10,
          padding: "22px 24px",
          maxWidth: 480,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxSizing: "border-box",
          color: TH.text,
          boxShadow: `0 8px 32px ${TH.shadow}`,
        }}
      >
        <h3 id="confirm-skip-title" style={{ margin: "0 0 10px", fontSize: 16 }}>
          Skip compliance documents for now?
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: TH.textSub2, lineHeight: 1.5 }}>
          You're telling us you don't have any compliance documents to share yet. You'll still be able to continue onboarding, but our team will follow up with you about these before you can submit invoices. Continue?
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} disabled={saving} style={btnSecondary}>Cancel</button>
          <button onClick={onConfirm} disabled={saving} style={btnPrimary}>
            {saving ? "Saving…" : "Yes, continue without docs"}
          </button>
        </div>
      </div>
    </div>
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
      void showAlert({ title: "Error", message: e instanceof Error ? e.message : String(e), tone: "danger" });
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
// Deliberately muted: this is a fallback (vendors with no docs yet), not
// a one-click out of the step. Outline + smaller text de-emphasises it
// next to the primary "I've uploaded everything…" CTA above it.
const btnSkip = { padding: "6px 14px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "transparent", color: TH.textSub2, cursor: "pointer", fontSize: 12, fontWeight: 500, fontFamily: "inherit" } as const;
