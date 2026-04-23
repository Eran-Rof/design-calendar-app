import React, { useEffect, useState } from "react";
import { showAlert, showFileViewer } from "./ui/AppDialog";
import { Link, useParams } from "react-router-dom";
import { TH } from "./theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtDate, fmtMoney } from "./utils";

interface Invoice {
  id: string;
  invoice_number: string;
  po_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string;
  status: string;
  submitted_at: string;
  approved_at: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  payment_method: string | null;
  rejection_reason: string | null;
  notes: string | null;
  file_url: string | null;
}

interface LineRow {
  id: string;
  line_index: number;
  description: string | null;
  quantity_invoiced: number | null;
  unit_price: number | null;
  line_total: number | null;
  po_line_item_id: string | null;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  submitted:    { bg: "#FEF3C7", fg: "#92400E" },
  under_review: { bg: "#DBEAFE", fg: "#1E40AF" },
  approved:     { bg: "#D1FAE5", fg: "#065F46" },
  paid:         { bg: "#A7F3D0", fg: "#064E3B" },
  rejected:     { bg: "#FECACA", fg: "#991B1B" },
  disputed:     { bg: "#FED7AA", fg: "#9A3412" },
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [poNumber, setPoNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editHeader, setEditHeader] = useState({ invoice_number: "", invoice_date: "", due_date: "", notes: "", tax: "0" });
  const [editLines, setEditLines] = useState<LineRow[]>([]);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [{ data: inv, error: iErr }, { data: lineData, error: lErr }] = await Promise.all([
          supabaseVendor.from("invoices").select("*").eq("id", id).maybeSingle(),
          supabaseVendor
            .from("invoice_line_items")
            .select("id, line_index, description, quantity_invoiced, unit_price, line_total, po_line_item_id")
            .eq("invoice_id", id)
            .order("line_index"),
        ]);
        if (iErr) throw iErr;
        if (lErr) throw lErr;
        if (!inv) throw new Error("Invoice not found.");
        setInvoice(inv as Invoice);
        setLines((lineData ?? []) as LineRow[]);

        if (inv.po_id) {
          const { data: po } = await supabaseVendor
            .from("tanda_pos").select("po_number").eq("uuid_id", inv.po_id).maybeSingle();
          if (po) setPoNumber(po.po_number);
        }
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function openAttachment() {
    if (!invoice?.file_url) return;
    const { data, error } = await supabaseVendor.storage.from("vendor-docs").createSignedUrl(invoice.file_url, 300);
    if (error || !data?.signedUrl) { await showAlert({ title: "Unable to open", message: error?.message || "unknown error", tone: "danger" }); return; }
    const filename = invoice.file_url.split("/").pop() || "attachment";
    await showFileViewer({ signedUrl: data.signedUrl, filename });
  }

  function startEdit() {
    if (!invoice) return;
    setEditHeader({
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.invoice_date || "",
      due_date: invoice.due_date || "",
      notes: invoice.notes || "",
      tax: invoice.tax != null ? String(invoice.tax) : "0",
    });
    setEditLines(lines.map((l) => ({ ...l })));
    setReplacementFile(null);
    setEditing(true);
  }

  function updateEditLine(idx: number, patch: Partial<LineRow>) {
    setEditLines((xs) => xs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function saveEdit() {
    if (!invoice) return;
    setSaving(true);
    setErr(null);
    try {
      let fileUrlPatch: string | undefined;
      if (replacementFile) {
        const MAX = 10 * 1024 * 1024;
        if (replacementFile.size > MAX) throw new Error("File exceeds 10 MB limit.");
        const allowedExts = ["pdf", "xls", "xlsx"];
        const ext = replacementFile.name.split(".").pop()?.toLowerCase();
        if (!ext || !allowedExts.includes(ext)) throw new Error("Only PDF or Excel files are accepted.");
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor.from("vendor_users").select("vendor_id").eq("auth_id", uid).maybeSingle();
        const vid = (vu as { vendor_id: string } | null)?.vendor_id;
        if (!vid) throw new Error("Not linked to a vendor.");
        const path = `${vid}/invoices/${Date.now()}_${replacementFile.name.replace(/\s+/g, "_")}`;
        const { error: upErr } = await supabaseVendor.storage.from("vendor-docs").upload(path, replacementFile, { upsert: false });
        if (upErr) throw upErr;
        fileUrlPatch = path;
      }

      const { data: session } = await supabaseVendor.auth.getSession();
      const accessToken = session?.session?.access_token;
      if (!accessToken) throw new Error("Not signed in.");

      const subtotal = editLines.reduce((a, l) => a + (Number(l.quantity_invoiced) || 0) * (Number(l.unit_price) || 0), 0);
      const taxNum = Number(editHeader.tax) || 0;
      const total = subtotal + taxNum;

      const r = await fetch(`/api/vendor/invoices/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          invoice_number: editHeader.invoice_number.trim(),
          invoice_date: editHeader.invoice_date || null,
          due_date: editHeader.due_date || null,
          notes: editHeader.notes.trim() || null,
          tax: taxNum,
          subtotal,
          total,
          ...(fileUrlPatch !== undefined ? { file_url: fileUrlPatch } : {}),
          line_items: editLines.map((l, idx) => ({
            po_line_item_id: l.po_line_item_id,
            line_index: idx + 1,
            description: l.description,
            quantity_invoiced: Number(l.quantity_invoiced) || 0,
            unit_price: Number(l.unit_price) || 0,
            line_total: (Number(l.quantity_invoiced) || 0) * (Number(l.unit_price) || 0),
          })),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);

      setInvoice(body as Invoice);
      // Reload line items since the handler fully replaces them.
      // Use the route `id` (stable) rather than `invoice.id` (the
      // newly-set state may not be flushed by the time we query).
      const { data: freshLines } = await supabaseVendor
        .from("invoice_line_items")
        .select("id, line_index, description, quantity_invoiced, unit_price, line_total, po_line_item_id")
        .eq("invoice_id", id).order("line_index");
      setLines((freshLines ?? []) as LineRow[]);
      setEditing(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ color: "#FFFFFF" }}>Loading invoice…</div>;
  if (err && !editing) return <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>;
  if (!invoice) return null;

  const c = STATUS_COLORS[invoice.status] ?? { bg: TH.surfaceHi, fg: TH.text };
  const canEdit = invoice.status === "submitted";

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/vendor/invoices" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to invoices</Link>
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 16, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 4 }}>INVOICE</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: TH.text, fontFamily: "Menlo, monospace" }}>{invoice.invoice_number}</div>
            <div style={{ fontSize: 13, color: TH.textSub2, marginTop: 4 }}>
              {poNumber && <>PO <strong>{poNumber}</strong> · </>}
              Submitted {fmtDate(invoice.submitted_at)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {canEdit && !editing && (
              <button onClick={startEdit} style={{ padding: "6px 14px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
                Edit
              </button>
            )}
            <span style={{ fontSize: 13, padding: "6px 14px", borderRadius: 999, background: c.bg, color: c.fg, fontWeight: 700, textTransform: "capitalize" }}>
              {invoice.status.replace("_", " ")}
            </span>
          </div>
        </div>

        {invoice.file_url && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ color: TH.textSub2 }}>
              <strong style={{ color: TH.text }}>Attachment:</strong>{" "}
              <span style={{ fontFamily: "Menlo, monospace", fontSize: 12 }}>{invoice.file_url.split("/").pop()}</span>
            </div>
            <button onClick={() => void openAttachment()} style={{ padding: "4px 12px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
              Download
            </button>
          </div>
        )}

        {editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 18 }}>
            <Labelled label="Invoice number">
              <input value={editHeader.invoice_number} onChange={(e) => setEditHeader((h) => ({ ...h, invoice_number: e.target.value }))} style={editInp} />
            </Labelled>
            <Labelled label="Invoice date">
              <input type="date" value={editHeader.invoice_date} onChange={(e) => setEditHeader((h) => ({ ...h, invoice_date: e.target.value }))} style={editInp} />
            </Labelled>
            <Labelled label="Due date">
              <input type="date" value={editHeader.due_date} onChange={(e) => setEditHeader((h) => ({ ...h, due_date: e.target.value }))} style={editInp} />
            </Labelled>
            <Labelled label="Tax">
              <input type="number" step="any" value={editHeader.tax} onChange={(e) => setEditHeader((h) => ({ ...h, tax: e.target.value }))} style={editInp} />
            </Labelled>
            <Labelled label="Replace attachment (optional, PDF/Excel)">
              <input type="file" accept="application/pdf,.pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,.xlsx" onChange={(e) => setReplacementFile(e.target.files?.[0] || null)} />
            </Labelled>
            <Labelled label="Notes">
              <textarea rows={2} value={editHeader.notes} onChange={(e) => setEditHeader((h) => ({ ...h, notes: e.target.value }))} style={{ ...editInp, fontFamily: "inherit", resize: "vertical" }} />
            </Labelled>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginTop: 18 }}>
            <InfoCell label="Invoice date" value={fmtDate(invoice.invoice_date)} />
            <InfoCell label="Due date" value={fmtDate(invoice.due_date)} />
            <InfoCell label="Currency" value={invoice.currency} />
            {invoice.approved_at && <InfoCell label="Approved" value={fmtDate(invoice.approved_at)} tone="ok" />}
            {invoice.paid_at && <InfoCell label="Paid" value={fmtDate(invoice.paid_at)} tone="ok" />}
          </div>
        )}
        {editing && err && (
          <div style={{ marginTop: 12, color: TH.primary, padding: "8px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, fontSize: 13 }}>
            {err}
          </div>
        )}
        {editing && (
          <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => { setEditing(false); setErr(null); }} disabled={saving} style={{ padding: "8px 16px", borderRadius: 6, border: `1px solid ${TH.border}`, background: "none", color: TH.text, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>Cancel</button>
            <button onClick={() => void saveEdit()} disabled={saving} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: TH.primary, color: "#FFFFFF", cursor: saving ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}

        {invoice.payment_reference && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13 }}>
            <strong style={{ color: TH.text }}>Payment:</strong>{" "}
            <span style={{ color: TH.textSub2 }}>{invoice.payment_method || "—"} · Ref {invoice.payment_reference}</span>
          </div>
        )}
        {invoice.rejection_reason && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, fontSize: 13, color: TH.primary }}>
            <strong>Rejection reason:</strong> {invoice.rejection_reason}
          </div>
        )}
        {invoice.notes && (
          <div style={{ marginTop: 14, padding: "10px 14px", background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.textSub2 }}>
            <strong style={{ color: TH.text }}>Notes:</strong> {invoice.notes}
          </div>
        )}
      </div>

      <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <div style={{ padding: "12px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 14, fontWeight: 700, color: TH.text }}>
          Line items
        </div>
        {lines.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>No line items on this invoice.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 100px 140px 140px", padding: "10px 20px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
              <div>#</div>
              <div>Description</div>
              <div>Qty</div>
              <div>Unit price</div>
              <div style={{ textAlign: "right" }}>Line total</div>
            </div>
            {(editing ? editLines : lines).map((l, idx) => {
              const lineTotal = editing
                ? (Number(l.quantity_invoiced) || 0) * (Number(l.unit_price) || 0)
                : (l.line_total ?? undefined);
              return (
                <div key={l.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr 100px 140px 140px", padding: "10px 20px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", gap: 6 }}>
                  <div style={{ color: TH.textMuted }}>{editing ? idx + 1 : l.line_index}</div>
                  {editing ? (
                    <input value={l.description ?? ""} onChange={(e) => updateEditLine(idx, { description: e.target.value })} style={editInp} />
                  ) : (
                    <div style={{ color: TH.text }}>{l.description ?? "—"}</div>
                  )}
                  {editing ? (
                    <input type="number" step="any" value={l.quantity_invoiced ?? ""} onChange={(e) => updateEditLine(idx, { quantity_invoiced: e.target.value === "" ? null : Number(e.target.value) })} style={editInp} />
                  ) : (
                    <div style={{ color: TH.textSub2 }}>{l.quantity_invoiced ?? "—"}</div>
                  )}
                  {editing ? (
                    <input type="number" step="any" value={l.unit_price ?? ""} onChange={(e) => updateEditLine(idx, { unit_price: e.target.value === "" ? null : Number(e.target.value) })} style={editInp} />
                  ) : (
                    <div style={{ color: TH.textSub2 }}>{fmtMoney(l.unit_price ?? undefined)}</div>
                  )}
                  <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(lineTotal)}</div>
                </div>
              );
            })}
            <div style={{ padding: "14px 20px", display: "flex", justifyContent: "flex-end" }}>
              <div style={{ minWidth: 280 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2, marginBottom: 6 }}>
                  <span>Subtotal</span><strong style={{ color: TH.text }}>{fmtMoney(invoice.subtotal ?? undefined)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2, marginBottom: 6 }}>
                  <span>Tax</span><strong style={{ color: TH.text }}>{fmtMoney(invoice.tax ?? undefined)}</strong>
                </div>
                <div style={{ borderTop: `1px solid ${TH.border}`, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 16 }}>
                  <strong>Total</strong><strong style={{ color: TH.primary }}>{fmtMoney(invoice.total ?? undefined)}</strong>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: tone === "ok" ? "#047857" : TH.text }}>{value}</div>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: 0.05, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const editInp: React.CSSProperties = { width: "100%", padding: "6px 8px", borderRadius: 5, border: `1px solid ${TH.border}`, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" };
