import { useEffect, useState } from "react";
import InternalRfqDetail from "./InternalRfqDetail";

interface Rfq {
  id: string;
  title: string;
  category: string | null;
  status: string;
  submission_deadline: string | null;
  quote_count: number;
  submitted_count: number;
  entity_id: string;
  created_at: string;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalRfqs() {
  const [rows, setRows] = useState<Rfq[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [create, setCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("status", filter);
      const r = await fetch(`/api/internal/rfqs?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      setRows(await r.json() as Rfq[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [filter]);

  if (selectedId) {
    return <InternalRfqDetail rfqId={selectedId} onClose={() => setSelectedId(null)} onChanged={() => { void load(); }} />;
  }

  if (loading) return <div style={{ color: C.textMuted }}>Loading RFQs…</div>;
  if (err) return <div style={{ color: C.danger }}>Error: {err}</div>;

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>RFQs</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={selectSt}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="closed">Closed</option>
            <option value="awarded">Awarded</option>
          </select>
          <button onClick={() => setCreate(true)} style={btnPrimary}>+ New RFQ</button>
        </div>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 140px 130px 100px 120px 120px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
          <div>Title</div>
          <div>Category</div>
          <div>Deadline</div>
          <div style={{ textAlign: "right" }}>Quotes</div>
          <div>Status</div>
          <div></div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No RFQs yet.</div>
        ) : rows.map((r) => (
          <div key={r.id} onClick={() => setSelectedId(r.id)} style={{ display: "grid", gridTemplateColumns: "2fr 140px 130px 100px 120px 120px", padding: "12px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center", cursor: "pointer" }}>
            <div style={{ fontWeight: 600 }}>{r.title}</div>
            <div style={{ color: C.textSub }}>{r.category || "—"}</div>
            <div style={{ color: C.textSub }}>{r.submission_deadline ? r.submission_deadline.slice(0, 10) : "—"}</div>
            <div style={{ textAlign: "right", color: C.textSub }}>{r.submitted_count} / {r.quote_count}</div>
            <div style={{ color: statusColor(r.status), fontWeight: 600, textTransform: "capitalize" }}>{r.status}</div>
            <div style={{ textAlign: "right", color: C.primary, fontSize: 12, fontWeight: 600 }}>Open →</div>
          </div>
        ))}
      </div>

      {create && <CreateModal onClose={() => setCreate(false)} onCreated={() => { setCreate(false); void load(); }} />}
    </div>
  );
}

function statusColor(s: string) {
  if (s === "awarded") return C.success;
  if (s === "published") return C.primary;
  if (s === "closed") return C.textSub;
  return C.warn;
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [submissionDeadline, setSubmissionDeadline] = useState("");
  const [deliveryBy, setDeliveryBy] = useState("");
  const [estimatedBudget, setEstimatedBudget] = useState("");
  const [entityId, setEntityId] = useState("");
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<string>>(new Set());
  const [lineItems, setLineItems] = useState<{ description: string; quantity: string; unit_of_measure: string }[]>([{ description: "", quantity: "1", unit_of_measure: "" }]);
  const [publishNow, setPublishNow] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [e, v] = await Promise.all([
        fetch("/api/internal/entities?flat=true").then((r) => r.ok ? r.json() : []),
        fetch("/api/internal/vendors").then((r) => r.ok ? r.json() : []),
      ]);
      setEntities(e as { id: string; name: string }[]);
      setVendors(v as { id: string; name: string }[]);
      if ((e as unknown[]).length > 0) setEntityId((e as { id: string }[])[0].id);
    })();
  }, []);

  async function submit() {
    if (!title.trim() || !entityId) { alert("Title and entity are required."); return; }
    const validLines = lineItems.filter((l) => l.description.trim()).map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, unit_of_measure: l.unit_of_measure.trim() || null }));
    if (validLines.length === 0) { alert("At least one line item is required."); return; }
    if (selectedVendorIds.size === 0) { alert("Select at least one vendor to invite."); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/rfqs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_id: entityId,
          title: title.trim(),
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          submission_deadline: submissionDeadline || undefined,
          delivery_required_by: deliveryBy || undefined,
          estimated_budget: estimatedBudget ? Number(estimatedBudget) : undefined,
          line_items: validLines,
          vendor_ids: [...selectedVendorIds],
          status: publishNow ? "published" : "draft",
          created_by: "internal",
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      onCreated();
    } catch (e: unknown) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, color: C.text, width: 640 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>Create RFQ — step {step} of 3</h3>
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[1, 2, 3].map((s) => (
            <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= s ? C.primary : C.cardBdr }} />
          ))}
        </div>

        {step === 1 && (
          <>
            <Row label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} style={inp} /></Row>
            <Row label="Entity">
              <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={inp}>
                {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Row>
            <Row label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...inp, resize: "vertical" }} /></Row>
            <Row label="Category"><input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Apparel" style={inp} /></Row>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Row label="Submission deadline"><input type="date" value={submissionDeadline} onChange={(e) => setSubmissionDeadline(e.target.value)} style={inp} /></Row>
              <Row label="Delivery required by"><input type="date" value={deliveryBy} onChange={(e) => setDeliveryBy(e.target.value)} style={inp} /></Row>
              <Row label="Estimated budget"><input type="number" value={estimatedBudget} onChange={(e) => setEstimatedBudget(e.target.value)} style={inp} /></Row>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>Add the products or services vendors should quote on.</div>
            {lineItems.map((li, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 80px 80px 30px", gap: 6, marginBottom: 6 }}>
                <input placeholder="Description" value={li.description} onChange={(e) => setLineItems(lineItems.map((l, j) => j === i ? { ...l, description: e.target.value } : l))} style={inp} />
                <input placeholder="Qty" type="number" value={li.quantity} onChange={(e) => setLineItems(lineItems.map((l, j) => j === i ? { ...l, quantity: e.target.value } : l))} style={inp} />
                <input placeholder="UoM" value={li.unit_of_measure} onChange={(e) => setLineItems(lineItems.map((l, j) => j === i ? { ...l, unit_of_measure: e.target.value } : l))} style={inp} />
                <button onClick={() => setLineItems(lineItems.filter((_, j) => j !== i))} style={{ ...btnSecondary, padding: "4px 8px" }}>×</button>
              </div>
            ))}
            <button onClick={() => setLineItems([...lineItems, { description: "", quantity: "1", unit_of_measure: "" }])} style={btnSecondary}>+ Add line</button>
          </>
        )}

        {step === 3 && (
          <>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>Select vendors to invite. Filtering by category is a follow-up.</div>
            <div style={{ maxHeight: 280, overflowY: "auto", border: `1px solid ${C.cardBdr}`, borderRadius: 6, padding: 8 }}>
              {vendors.map((v) => (
                <label key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", fontSize: 13 }}>
                  <input type="checkbox" checked={selectedVendorIds.has(v.id)} onChange={(e) => {
                    const n = new Set(selectedVendorIds);
                    if (e.target.checked) n.add(v.id); else n.delete(v.id);
                    setSelectedVendorIds(n);
                  }} />
                  {v.name}
                </label>
              ))}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13 }}>
              <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} />
              Publish and send invitations immediately
            </label>
          </>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 1 && <button onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)} style={btnSecondary}>Back</button>}
            {step < 3 && <button onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)} style={btnPrimary}>Next</button>}
            {step === 3 && <button onClick={() => void submit()} disabled={saving} style={btnPrimary}>{saving ? "Creating…" : "Create RFQ"}</button>}
          </div>
        </div>
      </div>
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
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13 } as const;
const btnPrimary = { padding: "8px 16px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "8px 14px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const };
