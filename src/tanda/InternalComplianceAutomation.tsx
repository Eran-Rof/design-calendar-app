import { useEffect, useState } from "react";

interface DocType { id: string; name: string; code: string }
interface Entity { id: string; name: string }
interface Rule {
  id: string;
  entity_id: string;
  document_type_id: string;
  trigger_type: "expiry_approaching" | "status_change" | "periodic_review";
  days_before_expiry: number | null;
  auto_request: boolean;
  escalation_after_days: number | null;
  is_active: boolean;
  document_type?: DocType | null;
  entity?: Entity | null;
}
interface Report {
  range: { from: string; to: string };
  requests_sent: number;
  renewals_completed: number;
  escalations_open: number;
  by_document_type: Record<string, { requests: number; renewals: number; escalations: number; name?: string; code?: string }>;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalComplianceAutomation() {
  const [entities, setEntities] = useState<Entity[]>([]);
  const [entityId, setEntityId] = useState("");
  const [types, setTypes] = useState<DocType[]>([]);
  const [rows, setRows] = useState<Rule[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const [rE, rT] = await Promise.all([
        fetch("/api/internal/entities?flat=true").then((r) => r.ok ? r.json() : []),
        fetch("/api/internal/compliance/document-types").then((r) => r.ok ? r.json() : { rows: [] }).catch(() => ({ rows: [] })),
      ]);
      const ents = rE as Entity[]; setEntities(ents);
      if (ents.length && !entityId) setEntityId(ents[0].id);
      const tList = (rT as { rows?: DocType[] }).rows || (Array.isArray(rT) ? rT : []);
      setTypes(tList);
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const [rRules, rReport] = await Promise.all([
        fetch(`/api/internal/compliance/automation-rules?entity_id=${entityId}`),
        fetch("/api/internal/compliance/automation-report"),
      ]);
      if (!rRules.ok) throw new Error(await rRules.text());
      const d = await rRules.json() as { rows: Rule[] };
      setRows(d.rows || []);
      if (rReport.ok) setReport(await rReport.json() as Report);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId]);

  async function toggle(rule: Rule) {
    const r = await fetch(`/api/internal/compliance/automation-rules/${rule.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !rule.is_active }),
    });
    if (!r.ok) { alert(await r.text()); return; }
    await load();
  }

  async function runNow() {
    if (!confirm("Run the compliance automation job now?")) return;
    const r = await fetch("/api/cron/compliance-automation", { method: "POST" });
    if (!r.ok) { alert(await r.text()); return; }
    const d = await r.json();
    alert(`Requests sent: ${d.requests_sent} · Escalations: ${d.escalations_sent}`);
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Compliance automation</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Auto-request renewals and escalate stalled docs. Runs daily at 13:00 UTC.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button onClick={() => void runNow()} style={btnSecondary}>Run now</button>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New rule</button>
        </div>
      </div>

      {report && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
          <Stat label="Requests sent" value={report.requests_sent} color={C.primary} />
          <Stat label="Renewals completed" value={report.renewals_completed} color={C.success} />
          <Stat label="Escalations open" value={report.escalations_open} color={C.warn} />
        </div>
      )}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>
          No automation rules for this entity yet.
        </div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 120px 100px 120px 100px 100px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <div>Document type</div><div>Trigger</div><div>Days before</div><div>Auto-req</div><div>Escalate after</div><div>Active</div><div style={{ textAlign: "right" }}>Action</div>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 120px 100px 120px 100px 100px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>{r.document_type?.name || r.document_type_id}</div>
              <div style={{ color: C.textSub, fontSize: 11, textTransform: "capitalize" }}>{r.trigger_type.replace(/_/g, " ")}</div>
              <div style={{ color: C.textMuted }}>{r.days_before_expiry ?? "—"}</div>
              <div>{r.auto_request ? <span style={{ color: C.success }}>✓</span> : <span style={{ color: C.textMuted }}>—</span>}</div>
              <div style={{ color: C.textMuted }}>{r.escalation_after_days ?? "—"}</div>
              <div>
                <button onClick={() => void toggle(r)} style={{ padding: "3px 10px", borderRadius: 12, border: "none", background: r.is_active ? C.success : C.textMuted, color: "#FFF", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>
                  {r.is_active ? "Active" : "Off"}
                </button>
              </div>
              <div style={{ textAlign: "right" }}>
                <button onClick={() => void toggle(r)} style={btnSecondary}>{r.is_active ? "Disable" : "Enable"}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {createOpen && entityId && (
        <CreateRuleModal
          entityId={entityId} types={types}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

function CreateRuleModal({ entityId, types, onClose, onCreated }: { entityId: string; types: DocType[]; onClose: () => void; onCreated: () => void }) {
  const [docTypeId, setDocTypeId] = useState(types[0]?.id || "");
  const [trigger, setTrigger] = useState<"expiry_approaching" | "status_change" | "periodic_review">("expiry_approaching");
  const [daysBefore, setDaysBefore] = useState("30");
  const [autoRequest, setAutoRequest] = useState(true);
  const [escalate, setEscalate] = useState("7");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!docTypeId && types.length) setDocTypeId(types[0].id); }, [types]);

  async function save() {
    if (!docTypeId) { alert("Choose a document type."); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/compliance/automation-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId, document_type_id: docTypeId, trigger_type: trigger,
          days_before_expiry: trigger === "expiry_approaching" ? Number(daysBefore) : null,
          auto_request: autoRequest,
          escalation_after_days: escalate ? Number(escalate) : null,
          is_active: true,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 520 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>New automation rule</h3>
        <Row label="Document type">
          <select value={docTypeId} onChange={(e) => setDocTypeId(e.target.value)} style={inp}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
        <Row label="Trigger type">
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as "expiry_approaching")} style={inp}>
            <option value="expiry_approaching">Expiry approaching</option>
            <option value="status_change">Status change</option>
            <option value="periodic_review">Periodic review</option>
          </select>
        </Row>
        {trigger === "expiry_approaching" && (
          <Row label="Days before expiry"><input type="number" value={daysBefore} onChange={(e) => setDaysBefore(e.target.value)} style={inp} /></Row>
        )}
        <Row label="Auto-send renewal request">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={autoRequest} onChange={(e) => setAutoRequest(e.target.checked)} />
            Notify the vendor automatically
          </label>
        </Row>
        <Row label="Escalate after (days, blank to disable)"><input type="number" value={escalate} onChange={(e) => setEscalate(e.target.value)} style={inp} /></Row>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
