// Live-document app for Ask AI (Tier 3J).
//
// A "document" is a saved invocation of a workflow (see workflows.js).
// Operators land here at /ai-documents, pick a doc from the sidebar,
// and the main pane renders the workflow output against LIVE data.
// Re-running is a single click — perfect for the Monday-morning kickoff
// or weekly underperformer review.
//
// Auth: same internal-staff pattern as UserFactsAdmin (read plm_user
// from sessionStorage; bearer header injected by installInternalApiAuth).

import { useEffect, useMemo, useState } from "react";
import SearchableSelect from "../../tanda/components/SearchableSelect";

const PAL = {
  bg: "#0F172A",
  panel: "#1E293B",
  panelAlt: "#162033",
  border: "#334155",
  text: "#F1F5F9",
  textDim: "#94A3B8",
  textMuted: "#6B7280",
  accent: "#3B82F6",
  green: "#10B981",
  yellow: "#F59E0B",
  red: "#EF4444",
} as const;

interface Doc {
  id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  workflow_name: string;
  params: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_rendered_at: string | null;
}

interface RenderResult {
  document: { id: string; name: string; description: string | null; workflow_name: string; params: Record<string, unknown> };
  rendered_at: string;
  payload: Record<string, unknown> & { error?: string };
}

const WORKFLOW_OPTIONS = [
  { value: "monday_briefing",       label: "Monday Briefing" },
  { value: "underperformer_review", label: "Underperformer Review" },
  { value: "customer_churn_check",  label: "Customer Churn Check" },
];

function readPlmUserId(): string | null {
  try {
    const raw = sessionStorage.getItem("plm_user");
    if (!raw) return null;
    const u = JSON.parse(raw) as { id?: string } | null;
    return u?.id || null;
  } catch { return null; }
}

function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function formatNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export default function DocumentsApp() {
  const userId = useMemo(() => readPlmUserId(), []);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Render state
  const [rendering, setRendering] = useState(false);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Create/edit modal
  const [editingDoc, setEditingDoc] = useState<Doc | "new" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [draftWorkflow, setDraftWorkflow] = useState<string>(WORKFLOW_OPTIONS[0].value);
  const [draftParams, setDraftParams] = useState<string>("{}");
  const [draftScope, setDraftScope] = useState<"self" | "shared">("self");
  const [saving, setSaving] = useState(false);

  async function loadDocs() {
    setLoading(true);
    setError(null);
    try {
      const params = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
      const r = await fetch(`/api/internal/ai/documents${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setDocs(Array.isArray(j.documents) ? j.documents : []);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }

  async function renderDoc(id: string) {
    setRendering(true);
    setRenderError(null);
    setResult(null);
    try {
      const r = await fetch(`/api/internal/ai/documents?id=${encodeURIComponent(id)}&action=render`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j: RenderResult = await r.json();
      setResult(j);
    } catch (e) {
      setRenderError(String((e as Error).message || e));
    } finally {
      setRendering(false);
    }
  }

  useEffect(() => { loadDocs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Auto-render the first doc on initial load so the page doesn't feel empty.
  useEffect(() => {
    if (!selectedId && docs.length > 0) {
      setSelectedId(docs[0].id);
      renderDoc(docs[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.length]);

  function selectDoc(id: string) {
    setSelectedId(id);
    renderDoc(id);
  }

  function startCreate() {
    setEditingDoc("new");
    setDraftName("");
    setDraftDesc("");
    setDraftWorkflow(WORKFLOW_OPTIONS[0].value);
    setDraftParams("{}");
    setDraftScope("self");
  }

  function startEdit(d: Doc) {
    setEditingDoc(d);
    setDraftName(d.name);
    setDraftDesc(d.description || "");
    setDraftWorkflow(d.workflow_name);
    setDraftParams(JSON.stringify(d.params || {}, null, 2));
    setDraftScope(d.user_id == null ? "shared" : "self");
  }

  function cancelEdit() {
    setEditingDoc(null);
    setError(null);
  }

  async function saveDoc() {
    if (!draftName.trim()) { setError("Name is required."); return; }
    let parsedParams: Record<string, unknown> = {};
    try {
      const v = JSON.parse(draftParams || "{}");
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("params must be a JSON object");
      parsedParams = v as Record<string, unknown>;
    } catch (e) {
      setError(`Params JSON is invalid: ${(e as Error).message}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: draftName.trim(),
        description: draftDesc.trim() || null,
        workflow_name: draftWorkflow,
        params: parsedParams,
        scope: draftScope,
        user_id: userId,
      };
      let r: Response;
      if (editingDoc === "new") {
        r = await fetch("/api/internal/ai/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else if (editingDoc) {
        r = await fetch(`/api/internal/ai/documents?id=${encodeURIComponent(editingDoc.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        return;
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const j = await r.json();
      setEditingDoc(null);
      await loadDocs();
      if (j.document?.id) selectDoc(j.document.id);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  async function removeDoc(id: string) {
    if (!confirm("Delete this document?")) return;
    try {
      const r = await fetch(`/api/internal/ai/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
      if (selectedId === id) { setSelectedId(null); setResult(null); }
      await loadDocs();
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  if (!userId) {
    return (
      <div style={{ ...page, color: PAL.text, padding: 40, textAlign: "center" }}>
        Sign in to PLM first — <a href="/" style={{ color: PAL.accent }}>go to launcher</a>.
      </div>
    );
  }

  const selectedDoc = docs.find(d => d.id === selectedId) || null;

  return (
    <div style={page}>
      <header style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="/" style={{ color: PAL.textMuted, textDecoration: "none", fontSize: 13 }}>← PLM</a>
          <span style={{ fontWeight: 700, fontSize: 16, color: PAL.text }}>Ask AI — Documents</span>
          <span style={{ fontSize: 11, color: PAL.textMuted }}>(saved workflow runs · re-render against live data)</span>
        </div>
        <button onClick={startCreate} style={btnPrimary} disabled={editingDoc != null}>+ New document</button>
      </header>

      {error && (
        <div style={errorBox}>{error}</div>
      )}

      <div style={layout}>
        <aside style={sidebar}>
          {loading ? (
            <div style={{ padding: 16, color: PAL.textDim, fontSize: 13 }}>Loading…</div>
          ) : docs.length === 0 ? (
            <div style={{ padding: 16, color: PAL.textDim, fontSize: 13 }}>
              No documents yet. Click <strong>+ New document</strong> to create one.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {docs.map(d => (
                <li
                  key={d.id}
                  onClick={() => selectDoc(d.id)}
                  style={{
                    ...sidebarItem,
                    background: d.id === selectedId ? PAL.panelAlt : "transparent",
                    borderLeft: d.id === selectedId ? `3px solid ${PAL.accent}` : "3px solid transparent",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, color: PAL.text }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 2 }}>
                    {d.workflow_name}
                    {d.user_id == null && <span style={{ marginLeft: 6, color: PAL.green }}>· shared</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main style={{ flex: 1, padding: 24, overflowY: "auto" }}>
          {!selectedDoc ? (
            <div style={{ color: PAL.textDim, padding: 40, textAlign: "center", fontSize: 13 }}>
              Select a document from the left, or create a new one.
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
                <h2 style={{ margin: 0, color: PAL.text, fontSize: 22 }}>{selectedDoc.name}</h2>
                <span style={{ color: PAL.textMuted, fontSize: 12 }}>{selectedDoc.workflow_name}</span>
              </div>
              {selectedDoc.description && (
                <p style={{ color: PAL.textDim, fontSize: 13, margin: "0 0 14px 0" }}>{selectedDoc.description}</p>
              )}
              <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                <button onClick={() => renderDoc(selectedDoc.id)} disabled={rendering} style={btnPrimary}>
                  {rendering ? "Rendering…" : "Refresh"}
                </button>
                <button onClick={() => startEdit(selectedDoc)} style={btnSecondary}>Edit</button>
                <button onClick={() => removeDoc(selectedDoc.id)} style={{ ...btnSecondary, color: PAL.red, borderColor: PAL.red }}>Delete</button>
                {result?.rendered_at && (
                  <span style={{ marginLeft: "auto", color: PAL.textMuted, fontSize: 11, alignSelf: "center" }}>
                    Rendered {new Date(result.rendered_at).toLocaleString()}
                  </span>
                )}
              </div>

              {renderError && (
                <div style={errorBox}>{renderError}</div>
              )}

              {rendering && !result && (
                <div style={{ color: PAL.textDim, padding: 40, textAlign: "center" }}>Running workflow…</div>
              )}

              {result && <RenderedPayload payload={result.payload} workflowName={selectedDoc.workflow_name} />}
            </div>
          )}
        </main>
      </div>

      {editingDoc && (
        <div style={modalBackdrop} onClick={cancelEdit}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: PAL.text }}>
              {editingDoc === "new" ? "New document" : "Edit document"}
            </div>
            <label style={label}>Name</label>
            <input value={draftName} onChange={e => setDraftName(e.target.value)} maxLength={120} style={input} />
            <label style={label}>Description <span style={{ color: PAL.textMuted, fontWeight: 400 }}>(optional)</span></label>
            <input value={draftDesc} onChange={e => setDraftDesc(e.target.value)} maxLength={600} style={input} />
            <label style={label}>Workflow</label>
            <SearchableSelect
              value={draftWorkflow || null}
              onChange={v => setDraftWorkflow(v)}
              options={WORKFLOW_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
              inputStyle={input}
            />
            <label style={label}>Params <span style={{ color: PAL.textMuted, fontWeight: 400 }}>(JSON — workflow-specific, e.g. {`{"top_n": 15}`} for underperformer_review)</span></label>
            <textarea value={draftParams} onChange={e => setDraftParams(e.target.value)} rows={5} style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }} />
            <label style={label}>Visibility</label>
            <SearchableSelect
              value={draftScope}
              onChange={v => setDraftScope(v as "self" | "shared")}
              options={[
                { value: "self", label: "Private (just me)" },
                { value: "shared", label: "Shared (everyone)" },
              ]}
              inputStyle={input}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={saveDoc} disabled={saving} style={btnPrimary}>{saving ? "Saving…" : "Save"}</button>
              <button onClick={cancelEdit} disabled={saving} style={btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Payload renderers — workflow-shape aware ───────────────────────────

function RenderedPayload({ payload, workflowName }: { payload: Record<string, unknown> & { error?: string }; workflowName: string }) {
  if (payload?.error) {
    return <div style={errorBox}>Workflow failed: {String(payload.error)}</div>;
  }
  switch (workflowName) {
    case "monday_briefing":       return <MondayBriefing payload={payload as any} />;
    case "underperformer_review": return <UnderperformerReview payload={payload as any} />;
    case "customer_churn_check":  return <CustomerChurn payload={payload as any} />;
    default:
      return (
        <pre style={{ background: PAL.panel, padding: 16, borderRadius: 8, color: PAL.text, fontSize: 12, overflowX: "auto" }}>
          {JSON.stringify(payload, null, 2)}
        </pre>
      );
  }
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ margin: "18px 0 8px 0", fontSize: 13, fontWeight: 700, color: PAL.text, textTransform: "uppercase", letterSpacing: 0.6 }}>
      {children}
    </h3>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8, padding: 14, minWidth: 160 }}>
      <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ color: PAL.text, fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ color: PAL.textDim, fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

interface MondayBriefingPayload {
  windows: { t3: { from: string; to: string } };
  t3_totals: { qty: number; revenue: number };
  top_customers_by_t3_revenue: { customer_id: string; customer_name: string | null; t3_revenue: number; t3_qty: number }[];
  top_styles_by_t3_revenue: { style_code: string; t3_revenue: number; t3_qty: number }[];
  open_sales_orders: { line_count: number; qty_open: number; value: number };
  open_purchase_orders: { line_count: number; qty_open: number; value: number };
}

function MondayBriefing({ payload }: { payload: MondayBriefingPayload }) {
  return (
    <div>
      <div style={{ color: PAL.textDim, fontSize: 12, marginBottom: 12 }}>
        Trailing 3 months: {payload.windows.t3.from} → {payload.windows.t3.to}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatTile label="T3 revenue"  value={formatMoney(payload.t3_totals.revenue)} />
        <StatTile label="T3 units shipped" value={formatNum(payload.t3_totals.qty)} />
        <StatTile label="Open SOs"   value={formatMoney(payload.open_sales_orders.value)}   sub={`${formatNum(payload.open_sales_orders.line_count)} lines · ${formatNum(payload.open_sales_orders.qty_open)} units`} />
        <StatTile label="Open POs"   value={formatMoney(payload.open_purchase_orders.value)} sub={`${formatNum(payload.open_purchase_orders.line_count)} lines · ${formatNum(payload.open_purchase_orders.qty_open)} units`} />
      </div>
      <SectionTitle>Top 5 customers by T3 revenue</SectionTitle>
      <Table
        rows={payload.top_customers_by_t3_revenue}
        cols={[
          { key: "customer_name", label: "Customer", render: r => r.customer_name || r.customer_id },
          { key: "t3_revenue",    label: "T3 revenue", align: "right", render: r => formatMoney(r.t3_revenue) },
          { key: "t3_qty",        label: "T3 units",   align: "right", render: r => formatNum(r.t3_qty) },
        ]}
      />
      <SectionTitle>Top 5 styles by T3 revenue</SectionTitle>
      <Table
        rows={payload.top_styles_by_t3_revenue}
        cols={[
          { key: "style_code", label: "Style" },
          { key: "t3_revenue", label: "T3 revenue", align: "right", render: r => formatMoney(r.t3_revenue) },
          { key: "t3_qty",     label: "T3 units",   align: "right", render: r => formatNum(r.t3_qty) },
        ]}
      />
    </div>
  );
}

interface UnderperformerPayload {
  windows: { t3: { from: string; to: string }; ly: { from: string; to: string } };
  count: number;
  underperformers: {
    style_code: string;
    t3_qty: number; ly_qty: number;
    t3_revenue: number; ly_revenue: number;
    decline_revenue: number; decline_pct: number;
    open_po_qty: number; open_po_value: number;
  }[];
}
function UnderperformerReview({ payload }: { payload: UnderperformerPayload }) {
  return (
    <div>
      <div style={{ color: PAL.textDim, fontSize: 12, marginBottom: 12 }}>
        T3: {payload.windows.t3.from} → {payload.windows.t3.to} · LY: {payload.windows.ly.from} → {payload.windows.ly.to} · {payload.count} flagged
      </div>
      <Table
        rows={payload.underperformers}
        cols={[
          { key: "style_code",      label: "Style" },
          { key: "t3_revenue",      label: "T3 rev",  align: "right", render: r => formatMoney(r.t3_revenue) },
          { key: "ly_revenue",      label: "LY rev",  align: "right", render: r => formatMoney(r.ly_revenue) },
          { key: "decline_pct",     label: "Drop %",  align: "right", render: r => <span style={{ color: PAL.red, fontWeight: 600 }}>−{r.decline_pct}%</span> },
          { key: "decline_revenue", label: "Drop $",  align: "right", render: r => formatMoney(r.decline_revenue) },
          { key: "open_po_value",   label: "Open PO", align: "right", render: r => r.open_po_value > 0 ? formatMoney(r.open_po_value) : "—" },
        ]}
      />
    </div>
  );
}

interface ChurnPayload {
  windows: { t3: { from: string; to: string }; ly: { from: string; to: string } };
  threshold_pct: number;
  count: number;
  churn_risks: {
    customer_id: string; customer_name: string | null;
    t3_revenue: number; ly_revenue: number; drop_pct: number;
    open_so_qty: number; open_so_value: number;
  }[];
}
function CustomerChurn({ payload }: { payload: ChurnPayload }) {
  return (
    <div>
      <div style={{ color: PAL.textDim, fontSize: 12, marginBottom: 12 }}>
        T3: {payload.windows.t3.from} → {payload.windows.t3.to} · LY: {payload.windows.ly.from} → {payload.windows.ly.to} · Drop threshold ≥ {payload.threshold_pct}% · {payload.count} flagged
      </div>
      <Table
        rows={payload.churn_risks}
        cols={[
          { key: "customer_name", label: "Customer", render: r => r.customer_name || r.customer_id },
          { key: "t3_revenue",    label: "T3 rev",   align: "right", render: r => formatMoney(r.t3_revenue) },
          { key: "ly_revenue",    label: "LY rev",   align: "right", render: r => formatMoney(r.ly_revenue) },
          { key: "drop_pct",      label: "Drop %",   align: "right", render: r => <span style={{ color: PAL.red, fontWeight: 600 }}>−{r.drop_pct}%</span> },
          { key: "open_so_value", label: "Open SO",  align: "right", render: r => r.open_so_value > 0 ? formatMoney(r.open_so_value) : "—" },
        ]}
      />
    </div>
  );
}

// Generic small table — keeps the workflow renderers terse.
interface Col<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render?: (row: T) => React.ReactNode;
}
function Table<T extends Record<string, any>>({ rows, cols }: { rows: T[]; cols: Col<T>[] }) {
  if (!rows || rows.length === 0) {
    return <div style={{ color: PAL.textDim, padding: 14, fontSize: 13 }}>No rows.</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 8 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: "10px 14px", textAlign: c.align === "right" ? "right" : "left",
                fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5,
                color: PAL.textDim, borderBottom: `1px solid ${PAL.border}`,
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: i > 0 ? `1px solid ${PAL.border}` : "none" }}>
              {cols.map(c => (
                <td key={c.key} style={{
                  padding: "10px 14px", color: PAL.text, fontSize: 13,
                  textAlign: c.align === "right" ? "right" : "left",
                }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── styles ─────────────────────────────────────────────────────────────
const page: React.CSSProperties = {
  minHeight: "100vh", background: PAL.bg, color: PAL.text,
  fontFamily: "'DM Sans','Segoe UI',sans-serif",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: PAL.panel, borderBottom: `1px solid ${PAL.border}`,
};
const layout: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "260px 1fr", minHeight: "calc(100vh - 56px)",
};
const sidebar: React.CSSProperties = {
  borderRight: `1px solid ${PAL.border}`, background: PAL.panel, overflowY: "auto",
};
const sidebarItem: React.CSSProperties = {
  padding: "12px 14px", cursor: "pointer",
};
const input: React.CSSProperties = {
  display: "block", width: "100%", boxSizing: "border-box",
  background: PAL.bg, color: PAL.text, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "8px 12px", fontSize: 13,
  marginBottom: 10, fontFamily: "inherit",
};
const label: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600, color: PAL.text, marginBottom: 6, marginTop: 4,
};
const btnPrimary: React.CSSProperties = {
  background: PAL.accent, color: "#fff", border: `1px solid ${PAL.accent}`,
  borderRadius: 6, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: PAL.textDim, border: `1px solid ${PAL.border}`,
  borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
const errorBox: React.CSSProperties = {
  margin: "12px 24px", padding: "10px 14px",
  background: "#7F1D1D", color: "#FECACA", border: `1px solid ${PAL.red}`, borderRadius: 6, fontSize: 13,
};
const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999,
};
const modal: React.CSSProperties = {
  background: PAL.panel, border: `1px solid ${PAL.border}`, borderRadius: 10,
  padding: 24, width: 520, maxWidth: "92vw",
  maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
};
