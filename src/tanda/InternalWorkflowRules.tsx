import { useEffect, useState } from "react";

interface Rule {
  id: string;
  entity_id: string;
  entity: { id: string; name: string } | null;
  name: string;
  trigger_event: string;
  conditions: { field: string; op: string; value: unknown }[];
  actions: { type: string; [k: string]: unknown }[];
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const TRIGGER_EVENTS = ["po_issued", "invoice_submitted", "invoice_approved", "shipment_created", "compliance_expired", "dispute_opened", "anomaly_detected", "onboarding_submitted", "contract_signed", "rfq_awarded"];
const COND_OPS = ["gt", "lt", "gte", "lte", "eq", "neq", "contains", "in"];
const ACTION_TYPES = ["require_approval", "notify", "auto_approve", "create_task", "webhook"];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalWorkflowRules() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [editRule, setEditRule] = useState<Rule | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const e = await fetch("/api/internal/entities?flat=true").then((r) => r.ok ? r.json() : []);
      setEntities(e as { id: string; name: string }[]);
      if ((e as unknown[]).length > 0 && !entityId) setEntityId((e as { id: string }[])[0].id);
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/workflow-rules?entity_id=${entityId}`);
      if (!r.ok) throw new Error(await r.text());
      setRows(await r.json() as Rule[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId]);

  async function toggle(r: Rule) {
    const res = await fetch(`/api/internal/workflow-rules/${r.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !r.is_active }),
    });
    if (!res.ok) { alert(await res.text()); return; }
    await load();
  }

  async function remove(r: Rule) {
    if (!confirm(`Disable rule "${r.name}"?`)) return;
    const res = await fetch(`/api/internal/workflow-rules/${r.id}`, { method: "DELETE" });
    if (!res.ok) { alert(await res.text()); return; }
    await load();
  }

  if (loading && rows.length === 0) return <div style={{ color: C.textMuted }}>Loading…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Workflow rules</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Scoped to a single entity; switch above.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={selectSt}>
            {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          <button onClick={() => setCreateOpen(true)} style={btnPrimary}>+ New rule</button>
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 160px 1.2fr 100px 200px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Name</div>
          <div>Trigger</div>
          <div>Actions</div>
          <div>Active</div>
          <div style={{ textAlign: "right" }}>Action</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No rules for this entity yet.</div>
        ) : rows.map((r) => (
          <div key={r.id} style={{ display: "grid", gridTemplateColumns: "2fr 160px 1.2fr 100px 200px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <div style={{ color: C.textSub, fontSize: 11, textTransform: "capitalize" }}>{r.trigger_event.replace(/_/g, " ")}</div>
            <div style={{ color: C.textSub, fontSize: 11 }}>{(r.actions || []).map((a) => a.type).join(", ")}</div>
            <div>
              <button onClick={() => void toggle(r)} style={{ padding: "3px 10px", borderRadius: 12, border: "none", background: r.is_active ? C.success : C.textMuted, color: "#FFFFFF", fontSize: 11, cursor: "pointer", fontWeight: 700 }}>
                {r.is_active ? "Active" : "Disabled"}
              </button>
            </div>
            <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button onClick={() => setEditRule(r)} style={btnSecondary}>Edit</button>
              <button onClick={() => void remove(r)} style={{ ...btnSecondary, color: C.danger }}>Disable</button>
            </div>
          </div>
        ))}
      </div>

      {(createOpen || editRule) && (
        <RuleEditor
          rule={editRule}
          entityId={entityId}
          onClose={() => { setCreateOpen(false); setEditRule(null); }}
          onSaved={() => { setCreateOpen(false); setEditRule(null); void load(); }}
        />
      )}
    </div>
  );
}

function RuleEditor({ rule, entityId, onClose, onSaved }: { rule: Rule | null; entityId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule?.name || "");
  const [trigger, setTrigger] = useState(rule?.trigger_event || "invoice_submitted");
  const [conditions, setConditions] = useState<{ field: string; op: string; value: string }[]>(
    (rule?.conditions || []).map((c) => ({ field: c.field, op: c.op, value: String(c.value ?? "") })) || []
  );
  const [actions, setActions] = useState<{ type: string; params: string }[]>(
    (rule?.actions || []).map((a) => ({ type: a.type, params: JSON.stringify({ ...a, type: undefined }) })) || []
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { alert("Name is required."); return; }
    if (actions.length === 0) { alert("At least one action is required."); return; }
    const parsedActions = actions.map((a) => {
      try {
        const p = a.params ? JSON.parse(a.params) : {};
        return { type: a.type, ...p };
      } catch { throw new Error(`Invalid JSON in ${a.type} params`); }
    });
    const parsedConditions = conditions.map((c) => ({
      field: c.field,
      op: c.op,
      value: /^-?\d+(\.\d+)?$/.test(c.value) ? Number(c.value) : c.value,
    }));
    setSaving(true);
    try {
      const payload = {
        entity_id: entityId,
        name: name.trim(),
        trigger_event: trigger,
        conditions: parsedConditions,
        actions: parsedActions,
        is_active: true,
      };
      const res = rule
        ? await fetch(`/api/internal/workflow-rules/${rule.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/internal/workflow-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 720 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>{rule ? "Edit rule" : "New rule"}</h3>

        <Row label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Invoice >$50k needs finance approval" style={inp} /></Row>
        <Row label="Trigger event">
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} style={inp}>
            {TRIGGER_EVENTS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Row>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>Conditions (all must pass)</div>
          {conditions.map((c, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 120px 1fr 30px", gap: 6, marginBottom: 6 }}>
              <input placeholder="field (e.g. amount)" value={c.field} onChange={(e) => setConditions(conditions.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} style={inp} />
              <select value={c.op} onChange={(e) => setConditions(conditions.map((x, j) => j === i ? { ...x, op: e.target.value } : x))} style={inp}>
                {COND_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input placeholder="value" value={c.value} onChange={(e) => setConditions(conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={inp} />
              <button onClick={() => setConditions(conditions.filter((_, j) => j !== i))} style={{ ...btnSecondary, padding: "4px 8px" }}>×</button>
            </div>
          ))}
          <button onClick={() => setConditions([...conditions, { field: "amount", op: "gt", value: "50000" }])} style={btnSecondary}>+ Condition</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>Actions</div>
          {actions.map((a, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "180px 1fr 30px", gap: 6, marginBottom: 6 }}>
              <select value={a.type} onChange={(e) => setActions(actions.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} style={inp}>
                {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input placeholder={actionPlaceholder(a.type)} value={a.params} onChange={(e) => setActions(actions.map((x, j) => j === i ? { ...x, params: e.target.value } : x))} style={{ ...inp, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }} />
              <button onClick={() => setActions(actions.filter((_, j) => j !== i))} style={{ ...btnSecondary, padding: "4px 8px" }}>×</button>
            </div>
          ))}
          <button onClick={() => setActions([...actions, { type: "notify", params: `{"to_role":"finance_manager"}` }])} style={btnSecondary}>+ Action</button>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
            Params are JSON. Examples: require_approval: {`{"approver_role":"finance_manager"}`} ·
            webhook: {`{"url":"https://hooks.slack.com/..."}`} ·
            notify: {`{"to_role":"procurement","to_vendor":true}`}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save rule"}</button>
        </div>
      </div>
    </div>
  );
}

function actionPlaceholder(t: string) {
  if (t === "require_approval") return `{"approver_role":"finance_manager"}`;
  if (t === "notify") return `{"to_role":"procurement"}`;
  if (t === "webhook") return `{"url":"https://..."}`;
  if (t === "create_task") return `{"assigned_role":"finance_manager","title":"..."}`;
  return "{}";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
