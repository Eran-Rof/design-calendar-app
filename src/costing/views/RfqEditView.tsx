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
import CollapsibleHeader from "../panels/CollapsibleHeader";
import { RfqQuotesPanel, RfqVendorThreadPanel, type RfqTheme } from "../../tanda/rfq/RfqQuotesAndMessages";
import { getRfq, updateRfq, publishRfq, awardRfq } from "../services/costingApi";
import { fmtDateDisplay, navigate, getEditId } from "../helpers";
import { appConfirm } from "../../utils/theme";
import { useCostingStore } from "../store/costingStore";
import type { RfqDetail, RfqListRow, RfqPatch, RfqStatus, RfqLineItem, RfqInvitation } from "../types";

const STATUS_OPTIONS: RfqStatus[] = ["draft", "published", "closed", "awarded"];

// Costing-module palette for the shared RFQ quotes + messages components.
// Matches the dark tokens used throughout RfqEditView (page #0F172A, panels
// #1E293B, borders #334155) with the costing module's blue accent (#60A5FA).
const COSTING_RFQ_THEME: RfqTheme = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#E2E8F0", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#60A5FA", success: "#10B981", warn: "#F59E0B", danger: "#F87171",
};

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
  const [publishing, setPublishing] = useState(false);
  const [awarding, setAwarding] = useState(false);
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

  // "Send to Vendor" — publish + notify every invited vendor. Idempotent on
  // the server, so this doubles as the "Re-send" path once already published.
  const onSendToVendor = useCallback(async () => {
    if (!id || !detail) return;
    const iv = detail.intended_vendor;
    const vendorLabel =
      (detail.invitations || [])
        .map((i) => i.vendors?.name || i.vendors?.legal_name || i.vendors?.code || i.vendor_id)
        .join(", ")
      || iv?.name || iv?.legal_name || iv?.code
      || "the vendor";
    setPublishing(true);
    try {
      const result = await publishRfq(id);
      // Reflect status='published' locally + keep the form in sync so the
      // status dropdown + button state update without a full reload.
      setDetail((prev) => prev ? { ...prev, rfq: { ...prev.rfq, status: "published" } } : prev);
      setForm((prev) => ({ ...prev, status: "published" }));
      const n = result.notified;
      setNotice(
        `RFQ sent to ${vendorLabel} — ${n === 0 ? "no invited vendors to notify yet" : `${n} ${n === 1 ? "vendor has" : "vendors have"} been notified`}.`,
        "info",
      );
    } catch (e) {
      setNotice(`Could not send to vendor: ${(e as Error).message}`, "error");
    } finally {
      setPublishing(false);
    }
  }, [id, detail, setNotice]);

  // "Award" — award the RFQ to its invited vendor. The award handler requires
  // the vendor to have a SUBMITTED quote (it 409s otherwise); we also gate the
  // button on the invitation showing status='submitted' so we don't offer an
  // action that's going to bounce. Confirm → award → reflect status='awarded'.
  const onAward = useCallback(() => {
    if (!id || !detail) return;
    const inv = (detail.invitations || []).find((i) => i.status === "submitted")
      || (detail.invitations || [])[0];
    if (!inv) {
      setNotice("No invited vendor to award.", "error");
      return;
    }
    const vendorLabel = inv.vendors?.name || inv.vendors?.legal_name || inv.vendors?.code || inv.vendor_id;
    appConfirm(
      `Award this RFQ to ${vendorLabel}? This notifies the vendor and the Production Manager and flows the price into the costing project.`,
      "Award",
      async () => {
        setAwarding(true);
        try {
          await awardRfq(id, inv.vendor_id);
          // Reflect awarded locally so the header + status dropdown update
          // without a full reload.
          setDetail((prev) => prev ? { ...prev, rfq: { ...prev.rfq, status: "awarded" } } : prev);
          setForm((prev) => ({ ...prev, status: "awarded" }));
          setNotice(`RFQ awarded to ${vendorLabel}. Vendor + Production Manager notified; price flowed into the costing project.`, "info");
        } catch (e) {
          setNotice(`Could not award: ${(e as Error).message}`, "error");
        } finally {
          setAwarding(false);
        }
      },
    );
  }, [id, detail, setNotice]);

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
        {detail?.rfq.code && (
          <span style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12, fontWeight: 700, color: "#CBD5E1",
            background: "#1E293B", border: "1px solid #334155",
            borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap",
          }}>{detail.rfq.code}</span>
        )}
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
          {detail && (() => {
            const isDraft = (detail.rfq.status || "draft") === "draft";
            const canSend = detail.rfq.status === "draft" || detail.rfq.status === "published";
            if (!canSend) {
              // awarded is shown by the dedicated "✓ Awarded" badge below;
              // here just surface the 'closed' state (publish rejected server-side).
              if (detail.rfq.status === "awarded") return null;
              return (
                <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  {detail.rfq.status}
                </span>
              );
            }
            return (
              <button
                onClick={onSendToVendor}
                disabled={publishing}
                title={isDraft
                  ? "Publish this RFQ and notify the invited vendor(s)"
                  : "Already sent — re-notify the invited vendor(s)"}
                style={{
                  background: isDraft ? "#1D4ED8" : "transparent",
                  color: isDraft ? "#FFFFFF" : "#60A5FA",
                  border: `1px solid ${isDraft ? "#1D4ED8" : "#1D4ED8"}`,
                  padding: "6px 14px", borderRadius: 4,
                  cursor: publishing ? "wait" : "pointer",
                  fontSize: 13, fontWeight: 600,
                  opacity: publishing ? 0.6 : 1,
                }}
              >
                {publishing ? "Sending…" : isDraft ? "Send to Vendor" : "✓ Sent · Re-send"}
              </button>
            );
          })()}
          {detail && (() => {
            const status = detail.rfq.status || "draft";
            if (status === "awarded") {
              return (
                <span style={{
                  fontSize: 11, color: "#10B981", fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: ".04em",
                  border: "1px solid #10B981", borderRadius: 4, padding: "4px 10px",
                }}>✓ Awarded</span>
              );
            }
            // Only offer Award once the RFQ is published. (draft = not sent yet;
            // closed = no longer awardable here.)
            if (status !== "published") return null;
            const hasSubmitted = (detail.invitations || []).some((i) => i.status === "submitted");
            return (
              <button
                onClick={onAward}
                disabled={awarding || !hasSubmitted}
                title={hasSubmitted
                  ? "Award this RFQ to the invited vendor — notifies the vendor + Production Manager and flows the price into costing"
                  : "Award unlocks once the invited vendor submits a quote"}
                style={{
                  background: hasSubmitted ? "#047857" : "transparent",
                  color: hasSubmitted ? "#FFFFFF" : "#475569",
                  border: `1px solid ${hasSubmitted ? "#047857" : "#334155"}`,
                  padding: "6px 14px", borderRadius: 4,
                  cursor: awarding ? "wait" : hasSubmitted ? "pointer" : "not-allowed",
                  fontSize: 13, fontWeight: 600,
                  opacity: awarding ? 0.6 : hasSubmitted ? 1 : 0.55,
                }}
              >
                {awarding ? "Awarding…" : "Award"}
              </button>
            );
          })()}
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
          {/* Header strip: vendor / customer / project / line count — read-only
              context. Collapsible via the ▾ triangle. */}
          <CollapsibleHeader
            storageKey="rfq-context"
            title="context"
            style={{
              marginBottom: 14, padding: "10px 14px",
              background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
              fontSize: 12,
            }}
            collapsedSummary={
              <div style={{ color: "#94A3B8", paddingRight: 24 }}>
                {(invitations.map((i: RfqInvitation) => i.vendors?.name || i.vendors?.legal_name || i.vendors?.code || i.vendor_id).join(", ") || (detail.intended_vendor ? `${detail.intended_vendor.name || detail.intended_vendor.legal_name || detail.intended_vendor.code}` : "—"))}
                {customerName ? ` · ${customerName}` : ""}
                {` · ${items.length} line${items.length === 1 ? "" : "s"}`}
              </div>
            }
          >
            <div style={{ display: "flex", gap: 18 }}>
              <ContextField label="Vendor(s)" value={invitations.map((i: RfqInvitation) => i.vendors?.name || i.vendors?.legal_name || i.vendors?.code || i.vendor_id).join(", ") || (detail.intended_vendor ? `${detail.intended_vendor.name || detail.intended_vendor.legal_name || detail.intended_vendor.code} (not sent yet)` : "—")} />
              <ContextField label="Customer" value={customerName || "—"} />
              <ContextField label="Source project" value={project?.project_name || "—"} />
              <ContextField label="Lines" value={String(items.length)} />
              <ContextField label="Currency" value={detail.rfq.currency || "USD"} />
              <ContextField label="Created" value={detail.rfq.created_at ? fmtDateDisplay(detail.rfq.created_at.slice(0, 10)) : "—"} />
            </div>
          </CollapsibleHeader>

          {/* Header form. Most fields are backfilled from the source costing
              project at generation (generate-rfqs.js) and are READ-ONLY here —
              the project is the single source of truth, edit them there. Only
              Status + Payment terms are RFQ-native and stay editable. */}
          <div style={{ marginBottom: 6, color: "#64748B", fontSize: 11, fontStyle: "italic" }}>
            Fields from the source project are read-only here — edit them on the costing project. Only Status and Payment terms are set on the RFQ.
          </div>
          <div style={{
            background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
            padding: "14px 16px", display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)", gap: "10px 14px",
            maxWidth: 1080,
          }}>
            {/* Backfilled — read-only. */}
            <Field label="Title" span={4}>
              <ReadOnlyValue value={detail.rfq.title} />
            </Field>

            {/* RFQ-native — editable. */}
            <Field label="Status">
              <SearchableSelect
                value={form.status || "draft"}
                onChange={(v) => setField("status", v as RfqStatus)}
                options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
                inputStyle={inp}
              />
            </Field>
            {/* Backfilled — read-only. */}
            <Field label="Brand">
              <ReadOnlyValue value={detail.rfq.category} />
            </Field>
            <Field label="Currency">
              <ReadOnlyValue value={detail.rfq.currency || "USD"} />
            </Field>
            {/* RFQ-native — editable. */}
            <Field label="Payment terms">
              <SearchableSelect
                value={form.payment_terms_id || null}
                onChange={(v) => setField("payment_terms_id", v || null)}
                options={[{ value: "", label: "(select)" }, ...paymentTerms.map((t) => ({ value: t.id, label: t.code ? `${t.code} — ${t.name}` : t.name }))]}
                placeholder="(select)"
              />
            </Field>

            {/* Backfilled dates — read-only, displayed in canonical MMM/DD/YYYY. */}
            <Field label="Request date">
              <ReadOnlyValue value={detail.rfq.request_date ? fmtDateDisplay(detail.rfq.request_date) : null} />
            </Field>
            <Field label="Due date">
              <ReadOnlyValue value={detail.rfq.due_date ? fmtDateDisplay(detail.rfq.due_date) : null} />
            </Field>
            <Field label="Projected delivery date">
              <ReadOnlyValue value={detail.rfq.projected_delivery_date ? fmtDateDisplay(detail.rfq.projected_delivery_date) : null} />
            </Field>
            {/* Backfilled estimates — read-only. */}
            <Field label="Estimated qty">
              <ReadOnlyValue value={typeof detail.rfq.estimated_quantity === "number" ? fmtQty.format(detail.rfq.estimated_quantity) : null} />
            </Field>
            <Field label="Estimated budget">
              <ReadOnlyValue value={typeof detail.rfq.estimated_budget === "number" ? fmtMoney.format(detail.rfq.estimated_budget) : null} />
            </Field>

            <Field label="Description" span={4}>
              <ReadOnlyValue value={detail.rfq.description} multiline />
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
                      <Td title={it.fabric_label && it.fabric_label !== it.fabric_code ? it.fabric_label : undefined}>{it.fabric_label || it.fabric_code || "—"}</Td>
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

          {/* Vendor quote comparison — submitted quotes with vendor notes
              (quote-level + per-line, via the 📝 expander). Display-only here;
              awarding is driven by the Award button in the header above. */}
          <div style={{ marginTop: 24 }}>
            <RfqQuotesPanel
              rfqId={detail.rfq.id}
              theme={COSTING_RFQ_THEME}
              lineLabel={(lineItemId) => {
                const li = items.find((x) => x.id === lineItemId);
                return li ? `#${li.line_index} ${li.description}` : "Line";
              }}
            />
          </div>

          {/* Internal RFQ message thread — PRIVATE per vendor. Pick which
              invited vendor to converse with, then read their messages and
              reply as "Ring of Fire". Same /api/internal/rfqs/:id/messages
              feed (now vendor-scoped) as the Tanda RFQ detail. */}
          <div style={{ maxWidth: 1080 }}>
            <RfqVendorThreadPanel
              rfqId={detail.rfq.id}
              theme={COSTING_RFQ_THEME}
              vendors={invitations.map((i: RfqInvitation) => ({
                vendor_id: i.vendor_id,
                vendor_name: i.vendors?.name || i.vendors?.legal_name || i.vendors?.code || i.vendor_id,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Only the RFQ-NATIVE fields are seeded into the editable form — everything
// else (title, description, brand/category, currency, the three dates,
// estimated qty/budget) is backfilled from the source costing project at
// generation time (see generate-rfqs.js) and is the project's to own, so it
// renders read-only below and is never sent on the PATCH. Status +
// payment_terms_id are the only operator-entered, RFQ-stage fields.
function seedForm(r: RfqListRow): RfqPatch {
  return {
    status: r.status,
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

// Read-only display for a backfilled field — styled to match the disabled
// look of the editable inputs (same box, dimmed text) so the form reads as a
// consistent grid. `multiline` switches to a min-height block for description.
function ReadOnlyValue({ value, multiline }: { value: string | null | undefined; multiline?: boolean }) {
  const text = value != null && String(value).trim() !== "" ? String(value) : "—";
  return (
    <div style={{
      ...inp,
      background: "#162033",
      color: "#94A3B8",
      cursor: "default",
      whiteSpace: multiline ? "pre-wrap" : "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      minHeight: multiline ? 54 : undefined,
    }}>{text}</div>
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
