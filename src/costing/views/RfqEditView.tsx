// Costing Module — RFQ edit view.
//
// Loads the RFQ header + line items + invitation(s) + source costing
// project (for the customer + project_name display). Header form
// autosaves with the same 800ms debounce pattern as ProjectEditView,
// and keeps a per-open undo stack of up to 4 prior snapshots — the
// Back button pops the most recent and re-fires autosave so the
// snapshot ends up persisted too.
//
// Line items are read-only here — the operator generated them from a
// costing project and shouldn't be hand-editing description / qty per
// row in the RFQ list (that would diverge from the source costing
// lines). If they want to change a line, do it back in the costing
// project + regenerate.

import React, { useEffect, useState, useCallback, useRef } from "react";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import { getRfq, updateRfq } from "../services/costingApi";
import { fmtDateDisplay, navigate, getEditId } from "../helpers";
import { useCostingStore } from "../store/costingStore";
import type { RfqDetail, RfqListRow, RfqPatch, RfqStatus, RfqLineItem, RfqInvitation } from "../types";

const STATUS_OPTIONS: RfqStatus[] = ["draft", "published", "closed", "awarded"];

const UNDO_LIMIT = 4;

const fmtQty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function RfqEditView() {
  const id = getEditId();
  const setNotice = useCostingStore((s) => s.setNotice);

  const [detail, setDetail] = useState<RfqDetail | null>(null);
  const [form, setForm] = useState<RfqPatch>({});
  // Tangerine Payment Terms master — drives the payment-terms picker.
  const [paymentTerms, setPaymentTerms] = useState<Array<{ id: string; code: string | null; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Undo stack — capped at UNDO_LIMIT. Each snapshot is the form state
  // BEFORE the change that pushed it.
  const [undoStack, setUndoStack] = useState<RfqPatch[]>([]);
  // Skip-autosave-on-next-form-change flag — set by undo so the popped
  // snapshot gets one chance to land via the autosave effect without
  // pushing itself back onto the undo stack.
  const skipUndoCaptureRef = useRef(false);

  // Initial load.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const d = await getRfq(id);
        if (cancelled) return;
        setDetail(d);
        setForm(seedForm(d.rfq));
        setUndoStack([]);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Load Tangerine Payment Terms for the picker (same endpoint as Sales Orders).
  useEffect(() => {
    fetch("/api/internal/payment-terms?limit=200")
      .then((r) => r.json())
      .then((a) => setPaymentTerms(Array.isArray(a) ? a : []))
      .catch(() => {});
  }, []);

  const dirty = !!detail && Object.keys(form).some((k) => {
    const v1 = (form as Record<string, unknown>)[k];
    const v2 = (detail.rfq as unknown as Record<string, unknown>)[k];
    return v1 !== v2;
  });

  // Debounced autosave.
  useEffect(() => {
    if (!id || !dirty || !detail) return;
    const t = window.setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await updateRfq(id, form);
        setDetail((prev) => prev ? { ...prev, rfq: updated } : prev);
      } catch (e) {
        setNotice(`Auto-save failed: ${(e as Error).message}`, "error");
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => window.clearTimeout(t);
  }, [form, id, dirty, detail, setNotice]);

  const setField = useCallback(<K extends keyof RfqPatch>(k: K, v: RfqPatch[K]) => {
    setForm((prev) => {
      // Capture the current state onto the undo stack before applying the
      // change — unless the change comes from popping the undo stack
      // (in which case skipUndoCaptureRef is set).
      if (skipUndoCaptureRef.current) {
        skipUndoCaptureRef.current = false;
      } else {
        setUndoStack((stack) => {
          const next = [...stack, prev];
          // Cap at UNDO_LIMIT — drop the oldest snapshot if over.
          if (next.length > UNDO_LIMIT) next.shift();
          return next;
        });
      }
      return { ...prev, [k]: v };
    });
  }, []);

  const onUndo = () => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const next = [...stack];
      const prev = next.pop()!;
      // Mark the next setField as a no-capture so the popped state can
      // settle without re-pushing itself.
      skipUndoCaptureRef.current = true;
      setForm(prev);
      return next;
    });
  };

  if (!id) {
    return (
      <div style={{ padding: 24, color: "#E2E8F0", background: "#0F172A", minHeight: "100%" }}>
        <div>No RFQ selected. <a href="#" onClick={(e) => { e.preventDefault(); navigate("rfq-list"); }} style={{ color: "#60A5FA" }}>← Back to RFQs</a></div>
      </div>
    );
  }

  const project = detail?.source_project;
  const customer = project?.customer;
  // Preference chain matches the customer picker: server-resolved Xoro
  // friendly name (ip_customer_master.name via display_name) → billing_address.name
  // → stripped customers.code.
  const friendly = typeof customer?.display_name === "string" && customer.display_name.trim().length > 0
    ? customer.display_name
    : null;
  const billingName = (customer && typeof customer.billing_address === "object" && customer.billing_address && typeof (customer.billing_address as Record<string, unknown>).name === "string")
    ? (customer.billing_address as Record<string, string>).name
    : null;
  const rawCustomerName = friendly || billingName || customer?.code || null;
  // Final EXCEL: guard in case ip_customer_master is missing a row for some
  // new code that hasn't synced yet.
  const customerName = rawCustomerName ? rawCustomerName.replace(/^EXCEL:/i, "") : null;
  const invitations = detail?.invitations || [];
  const items = detail?.line_items || [];

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate("rfq-list"); }} style={{ color: "#60A5FA", textDecoration: "none", fontSize: 13 }}>← RFQs</a>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {detail?.rfq.title || "Loading…"}
        </h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{
            fontSize: 11, color: saving ? "#FBBF24" : dirty ? "#94A3B8" : "#10B981",
            fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
          }}>
            {saving ? "Saving…" : dirty ? "Unsaved" : "✓ Saved"}
          </span>
          <button
            onClick={onUndo}
            disabled={undoStack.length === 0}
            title={undoStack.length === 0
              ? "Nothing to undo"
              : `Undo last change (${undoStack.length} of ${UNDO_LIMIT} snapshots available)`}
            style={{
              background: undoStack.length > 0 ? "transparent" : "transparent",
              color: undoStack.length > 0 ? "#F59E0B" : "#475569",
              border: `1px solid ${undoStack.length > 0 ? "#F59E0B" : "#334155"}`,
              padding: "6px 14px", borderRadius: 4,
              cursor: undoStack.length > 0 ? "pointer" : "not-allowed",
              fontSize: 13, fontWeight: 600,
              opacity: undoStack.length > 0 ? 1 : 0.55,
            }}
          >↶ Back ({undoStack.length})</button>
        </div>
      </div>

      {loading && <div style={{ color: "#94A3B8", fontSize: 13 }}>Loading…</div>}
      {error && <div style={{ color: "#F87171", fontSize: 13, padding: 8, background: "#7F1D1D33", borderRadius: 4, marginBottom: 12 }}>{error}</div>}

      {detail && (
        <>
          {/* Header strip: vendor / customer / project / line count — read-only context. */}
          <div style={{
            display: "flex", gap: 18, marginBottom: 14, padding: "10px 14px",
            background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
            fontSize: 12,
          }}>
            <ContextField label="Vendor(s)" value={invitations.map((i: RfqInvitation) => i.vendors?.name || i.vendors?.legal_name || i.vendors?.code || i.vendor_id).join(", ") || "—"} />
            <ContextField label="Customer" value={customerName || "—"} />
            <ContextField label="Source project" value={project?.project_name || "—"} />
            <ContextField label="Lines" value={String(items.length)} />
            <ContextField label="Currency" value={detail.rfq.currency || "USD"} />
            <ContextField label="Created" value={detail.rfq.created_at ? fmtDateDisplay(detail.rfq.created_at.slice(0, 10)) : "—"} />
          </div>

          {/* Editable header form. */}
          <div style={{
            background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
            padding: "14px 16px", display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)", gap: "10px 14px",
            maxWidth: 1080,
          }}>
            <Field label="Title" span={4}>
              <input value={form.title || ""} onChange={(e) => setField("title", e.target.value)} style={inp} />
            </Field>
            <Field label="Status">
              <select value={form.status || "draft"} onChange={(e) => setField("status", e.target.value as RfqStatus)} style={inp}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <input value={form.category || ""} onChange={(e) => setField("category", e.target.value || null)} style={inp} placeholder="e.g. BOYS" />
            </Field>
            <Field label="Currency">
              <input value={form.currency || ""} onChange={(e) => setField("currency", e.target.value || "USD")} style={inp} placeholder="USD" />
            </Field>
            <Field label="Payment terms">
              <SearchableSelect
                value={form.payment_terms_id || null}
                onChange={(v) => setField("payment_terms_id", v || null)}
                options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]}
                placeholder="(select)"
              />
            </Field>

            {/* Three date fields mirror the costing project header (request,
                due, projected delivery). Replaces the legacy submission_deadline
                + delivery_required_by inputs — those columns still exist on the
                row for other procurement readers, just not surfaced here. */}
            <Field label="Request date">
              <input type="date" value={form.request_date || ""} onChange={(e) => setField("request_date", e.target.value || null)} style={dateInp} />
            </Field>
            <Field label="Due date">
              <input type="date" value={form.due_date || ""} onChange={(e) => setField("due_date", e.target.value || null)} style={dateInp} />
            </Field>
            <Field label="Projected delivery date">
              <input type="date" value={form.projected_delivery_date || ""} onChange={(e) => setField("projected_delivery_date", e.target.value || null)} style={dateInp} />
            </Field>
            {/* type="text" + inputMode removes the up/down stepper arrows
                while keeping the field typeable (mirrors the inventory-planning
                numeric cells). */}
            <Field label="Estimated qty">
              <input type="text" inputMode="numeric" value={form.estimated_quantity ?? ""} onChange={(e) => { const t = e.target.value.trim(); const n = Number(t); setField("estimated_quantity", t === "" || Number.isNaN(n) ? null : n); }} style={inp} />
            </Field>
            <Field label="Estimated budget">
              <input type="text" inputMode="decimal" value={form.estimated_budget ?? ""} onChange={(e) => { const t = e.target.value.trim(); const n = Number(t); setField("estimated_budget", t === "" || Number.isNaN(n) ? null : n); }} style={inp} />
            </Field>

            <Field label="Description" span={4}>
              <textarea value={form.description || ""} onChange={(e) => setField("description", e.target.value || null)} rows={3} style={{ ...inp, fontFamily: "inherit", resize: "vertical" }} />
            </Field>
          </div>

          {/* Line items — read-only. Operators edit them upstream in the costing project + regenerate the RFQ. */}
          <div style={{ marginTop: 20 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#E2E8F0", letterSpacing: ".04em", textTransform: "uppercase", marginBottom: 8 }}>
              Line items · {items.length}
            </h3>
            <div style={{ border: "1px solid #334155", borderRadius: 6, background: "#1E293B", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ background: "#0F172A" }}>
                  <tr>
                    <Th width={40}>#</Th>
                    <Th>Description</Th>
                    <Th width={90}>Fabric</Th>
                    <Th width={70}>Fit</Th>
                    <Th width={80}>Closure</Th>
                    <Th width={70}>Scale</Th>
                    <Th width={80}>Waist</Th>
                    <Th align="right" width={80}>Qty</Th>
                    <Th width={50}>UOM</Th>
                    <Th align="right" width={90}>Trgt Cost</Th>
                    <Th>Comments</Th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr><td colSpan={11} style={{ padding: 20, textAlign: "center", color: "#64748B" }}>No line items.</td></tr>
                  )}
                  {items.map((it: RfqLineItem) => (
                    <tr key={it.id} style={{ borderTop: "1px solid #334155" }}>
                      <Td>{it.line_index}</Td>
                      <Td>{it.description}</Td>
                      <Td>{it.fabric_code || "—"}</Td>
                      <Td>{it.fit || "—"}</Td>
                      <Td>{it.bottom_closure || "—"}</Td>
                      <Td>{it.size_scale_label || "—"}</Td>
                      <Td>{it.waist_type || "—"}</Td>
                      <Td align="right">{fmtQty.format(it.quantity)}</Td>
                      <Td>{it.unit_of_measure || "—"}</Td>
                      <Td align="right">{typeof it.target_price === "number" ? fmtMoney.format(it.target_price) : "—"}</Td>
                      <Td><span style={{ color: "#94A3B8" }}>{it.specifications || "—"}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 6, color: "#64748B", fontSize: 11, fontStyle: "italic" }}>
              Line items are read-only here — edit them back in the source costing project and regenerate the RFQ.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function seedForm(r: RfqListRow): RfqPatch {
  return {
    title: r.title,
    description: r.description,
    category: r.category,
    status: r.status,
    submission_deadline: r.submission_deadline,
    delivery_required_by: r.delivery_required_by,
    request_date: r.request_date,
    due_date: r.due_date,
    projected_delivery_date: r.projected_delivery_date,
    estimated_quantity: r.estimated_quantity,
    estimated_budget: r.estimated_budget,
    currency: r.currency,
    payment_terms_id: r.payment_terms_id,
  };
}

function ContextField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 2 }}>{label}</div>
      <div style={{ color: "#E2E8F0", fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Field({ label, span, children }: { label: string; span?: 1 | 2 | 3 | 4; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", gridColumn: span ? `span ${span}` : undefined }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

function Th({ children, align, width }: { children: React.ReactNode; align?: "left" | "right" | "center"; width?: number }) {
  return <th style={{ textAlign: align || "left", padding: "6px 10px", fontWeight: 600, fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", width }}>{children}</th>;
}
function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return <td style={{ padding: "6px 10px", color: "#E2E8F0", textAlign: align || "left" }}>{children}</td>;
}

const inp: React.CSSProperties = {
  width: "100%", background: "#0F172A", color: "#E2E8F0",
  border: "1px solid #334155", borderRadius: 4, padding: "5px 8px", fontSize: 12,
  outline: "none",
};

const dateInp: React.CSSProperties = {
  ...inp,
  colorScheme: "dark",
};
