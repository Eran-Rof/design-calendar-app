import { useEffect, useState } from "react";

interface Rule {
  id: string;
  entity_id: string;
  jurisdiction: string;
  tax_type: "vat" | "gst" | "sales_tax" | "withholding";
  rate_pct: number;
  applies_to: "goods" | "services" | "all";
  threshold_amount: number | null;
  vendor_type_exemptions: string[];
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
}
interface RemittanceSummary {
  range: { from: string; to: string };
  total_taxable: number;
  total_tax: number;
  by_jurisdiction: { jurisdiction: string; tax_type: string; taxable: number; tax: number; count: number }[];
  by_tax_type: { tax_type: string; taxable: number; tax: number; count: number }[];
}
interface Remittance {
  id: string; jurisdiction: string; tax_type: string;
  period_start: string; period_end: string;
  total_taxable_amount: number; total_tax_amount: number;
  status: "draft" | "filed" | "paid";
  payment_reference: string | null;
  filed_at: string | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalTax() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [rules, setRules] = useState<Rule[]>([]);
  const [summary, setSummary] = useState<RemittanceSummary | null>(null);
  const [remittances, setRemittances] = useState<Remittance[]>([]);
  const [periodStart, setPeriodStart] = useState(monthStart());
  const [periodEnd, setPeriodEnd] = useState(todayStr());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [createRemittanceOpen, setCreateRemittanceOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = await r.json() as { id: string; name: string }[];
        setEntities(e); if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const [rR, rS, rM] = await Promise.all([
        fetch(`/api/internal/tax/rules?entity_id=${entityId}`),
        fetch(`/api/internal/tax/remittance-report?period_start=${periodStart}&period_end=${periodEnd}`),
        fetch(`/api/internal/tax/remittances?entity_id=${entityId}`),
      ]);
      if (!rR.ok) throw new Error(await rR.text());
      setRules(((await rR.json()) as { rows: Rule[] }).rows || []);
      if (rS.ok) setSummary(await rS.json() as RemittanceSummary);
      if (rM.ok) setRemittances(((await rM.json()) as { rows: Remittance[] }).rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, periodStart, periodEnd]);

  async function toggleRule(r: Rule) {
    const resp = await fetch(`/api/internal/tax/rules/${r.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !r.is_active }),
    });
    if (!resp.ok) { alert(await resp.text()); return; }
    await load();
  }

  function exportCsv() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd, format: "csv" });
    window.open(`/api/internal/tax/remittance-report?${params.toString()}`, "_blank");
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Tax compliance</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Rules, per-period roll-up, and filed remittance records.</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={selectSt} />
          <span style={{ color: C.textMuted }}>→</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={selectSt} />
          <button onClick={exportCsv} style={btnSecondary}>Export CSV</button>
        </div>
      </div>

      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="Taxable amount" value={`$${Math.round(summary.total_taxable).toLocaleString()}`} />
          <Stat label="Tax owed" value={`$${Math.round(summary.total_tax).toLocaleString()}`} color={C.warn} />
          <Stat label="Jurisdictions" value={String(summary.by_jurisdiction.length)} color={C.primary} />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "12px 0 8px" }}>
        <h3 style={{ fontSize: 15, margin: 0, color: C.textSub }}>Rules</h3>
        <button onClick={() => setCreateRuleOpen(true)} style={btnPrimary}>+ New rule</button>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rules.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, marginBottom: 14 }}>No tax rules.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 100px 120px 120px 140px 100px 80px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Jurisdiction</div><div>Type</div><div>Rate</div><div>Applies to</div><div>Threshold</div><div>Effective</div><div>Exemptions</div><div>Active</div>
          </div>
          {rules.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 120px 100px 120px 120px 140px 100px 80px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 700 }}>{r.jurisdiction}</div>
              <div style={{ color: C.textSub, textTransform: "uppercase", fontSize: 11 }}>{r.tax_type}</div>
              <div>{Number(r.rate_pct).toFixed(3)}%</div>
              <div style={{ color: C.textMuted, fontSize: 11, textTransform: "capitalize" }}>{r.applies_to}</div>
              <div style={{ color: C.textMuted }}>{r.threshold_amount != null ? `$${Number(r.threshold_amount).toLocaleString()}` : "—"}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{r.effective_from}{r.effective_to ? ` → ${r.effective_to}` : ""}</div>
              <div style={{ color: C.textMuted, fontSize: 10 }}>{(r.vendor_type_exemptions || []).join(", ") || "—"}</div>
              <div>
                <button onClick={() => void toggleRule(r)} style={{ padding: "3px 8px", borderRadius: 10, border: "none", background: r.is_active ? C.success : C.textMuted, color: "#fff", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                  {r.is_active ? "on" : "off"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "12px 0 8px" }}>
        <h3 style={{ fontSize: 15, margin: 0, color: C.textSub }}>Remittance records</h3>
        <button onClick={() => setCreateRemittanceOpen(true)} style={btnPrimary}>+ Record filing</button>
      </div>
      {remittances.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No filings recorded.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 160px 120px 120px 100px 1fr", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Jurisdiction</div><div>Type</div><div>Period</div><div>Taxable</div><div>Tax paid</div><div>Status</div><div>Reference</div>
          </div>
          {remittances.map((m) => (
            <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1fr 100px 160px 120px 120px 100px 1fr", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{m.jurisdiction}</div>
              <div style={{ color: C.textSub, textTransform: "uppercase", fontSize: 11 }}>{m.tax_type}</div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{m.period_start} → {m.period_end}</div>
              <div>${Math.round(Number(m.total_taxable_amount)).toLocaleString()}</div>
              <div style={{ color: C.warn }}>${Math.round(Number(m.total_tax_amount)).toLocaleString()}</div>
              <div>
                <span style={{ fontSize: 10, color: "#fff", background: m.status === "paid" ? C.success : m.status === "filed" ? C.primary : C.textMuted, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{m.status}</span>
              </div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{m.payment_reference || "—"}</div>
            </div>
          ))}
        </div>
      )}

      {createRuleOpen && entityId && <RuleModal entityId={entityId} onClose={() => setCreateRuleOpen(false)} onCreated={() => { setCreateRuleOpen(false); void load(); }} />}
      {createRemittanceOpen && entityId && <RemittanceModal entityId={entityId} onClose={() => setCreateRemittanceOpen(false)} onCreated={() => { setCreateRemittanceOpen(false); void load(); }} />}
    </div>
  );
}

function RuleModal({ entityId, onClose, onCreated }: { entityId: string; onClose: () => void; onCreated: () => void }) {
  const [jurisdiction, setJurisdiction] = useState("");
  const [taxType, setTaxType] = useState<"vat" | "gst" | "sales_tax" | "withholding">("sales_tax");
  const [ratePct, setRatePct] = useState("");
  const [appliesTo, setAppliesTo] = useState<"goods" | "services" | "all">("all");
  const [threshold, setThreshold] = useState("");
  const [exemptions, setExemptions] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayStr());
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!jurisdiction.trim() || !ratePct) { alert("Jurisdiction and rate required"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/tax/rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId, jurisdiction: jurisdiction.trim(), tax_type: taxType,
          rate_pct: Number(ratePct), applies_to: appliesTo,
          threshold_amount: threshold ? Number(threshold) : null,
          vendor_type_exemptions: exemptions.split(",").map((s) => s.trim()).filter(Boolean),
          effective_from: effectiveFrom,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 540 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New tax rule</h3>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Row label="Jurisdiction"><input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="US-CA, GB, DE-BY" style={inp} /></Row>
          <Row label="Tax type">
            <select value={taxType} onChange={(e) => setTaxType(e.target.value as "sales_tax")} style={inp}>
              <option value="sales_tax">sales_tax</option>
              <option value="vat">vat</option>
              <option value="gst">gst</option>
              <option value="withholding">withholding</option>
            </select>
          </Row>
          <Row label="Rate %"><input type="number" step="0.001" value={ratePct} onChange={(e) => setRatePct(e.target.value)} style={inp} /></Row>
          <Row label="Applies to">
            <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as "all")} style={inp}>
              <option value="all">all</option><option value="goods">goods</option><option value="services">services</option>
            </select>
          </Row>
          <Row label="Threshold $ (optional)"><input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} style={inp} /></Row>
          <Row label="Effective from"><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} style={inp} /></Row>
        </div>
        <Row label="Vendor-type exemptions (comma-sep)"><input value={exemptions} onChange={(e) => setExemptions(e.target.value)} placeholder="small_business, women_owned" style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function RemittanceModal({ entityId, onClose, onCreated }: { entityId: string; onClose: () => void; onCreated: () => void }) {
  const [jurisdiction, setJurisdiction] = useState("");
  const [taxType, setTaxType] = useState<"sales_tax" | "vat" | "gst" | "withholding">("sales_tax");
  const [periodStart, setPeriodStart] = useState(monthStart());
  const [periodEnd, setPeriodEnd] = useState(todayStr());
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/internal/tax/remittances", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId, jurisdiction, tax_type: taxType, period_start: periodStart, period_end: periodEnd, payment_reference: reference || null }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 500 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>Record a remittance filing</h3>
        <Row label="Jurisdiction"><input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} style={inp} /></Row>
        <Row label="Tax type">
          <select value={taxType} onChange={(e) => setTaxType(e.target.value as "sales_tax")} style={inp}>
            <option value="sales_tax">sales_tax</option><option value="vat">vat</option>
            <option value="gst">gst</option><option value="withholding">withholding</option>
          </select>
        </Row>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Row label="Period start"><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inp} /></Row>
          <Row label="Period end"><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inp} /></Row>
        </div>
        <Row label="Payment reference (optional — sets status=paid)"><input value={reference} onChange={(e) => setReference(e.target.value)} style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Record"}</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text, marginTop: 4 }}>{value}</div>
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

function todayStr() { return new Date().toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); d.setUTCDate(1); return d.toISOString().slice(0, 10); }

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
