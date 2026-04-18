import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";
import { fmtMoney } from "./utils";

interface POOption {
  uuid_id: string;
  po_number: string;
  data: { BuyerName?: string; TotalAmount?: number } | null;
}

interface LineItem {
  id: string;
  line_index: number;
  item_number: string | null;
  description: string | null;
  qty_ordered: number | null;
  unit_price: number | null;
}

interface LineInput {
  line_id: string;
  line_index: number;
  description: string;
  qty: string;
  unit_price: string;
  include: boolean;
}

export default function InvoiceSubmit() {
  const nav = useNavigate();
  const [pos, setPOs] = useState<POOption[]>([]);
  const [selectedPoId, setSelectedPoId] = useState<string>("");
  const [poLines, setPoLines] = useState<LineItem[]>([]);
  const [lineInputs, setLineInputs] = useState<LineInput[]>([]);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [tax, setTax] = useState("0");
  const [notes, setNotes] = useState("");

  const [vendorUserId, setVendorUserId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load vendor PO list
  useEffect(() => {
    (async () => {
      try {
        const { data: userRes } = await supabaseVendor.auth.getUser();
        const uid = userRes.user?.id;
        if (!uid) throw new Error("Not signed in.");
        const { data: vu } = await supabaseVendor
          .from("vendor_users").select("id").eq("auth_id", uid).maybeSingle();
        if (vu) setVendorUserId(vu.id as string);

        const { data, error } = await supabaseVendor
          .from("tanda_pos")
          .select("uuid_id, po_number, data")
          .order("date_order", { ascending: false });
        if (error) throw error;
        const active = (data ?? []).filter((r: { data: { _archived?: boolean } | null }) => !r.data?._archived);
        setPOs(active as POOption[]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // When PO changes, load its line items
  useEffect(() => {
    if (!selectedPoId) { setPoLines([]); setLineInputs([]); return; }
    (async () => {
      const { data, error } = await supabaseVendor
        .from("po_line_items")
        .select("id, line_index, item_number, description, qty_ordered, unit_price")
        .eq("po_id", selectedPoId)
        .order("line_index");
      if (error) { setErr(error.message); return; }
      const lines = (data ?? []) as LineItem[];
      setPoLines(lines);
      setLineInputs(
        lines.map((l) => ({
          line_id: l.id,
          line_index: l.line_index,
          description: l.description ?? "",
          qty: l.qty_ordered != null ? String(l.qty_ordered) : "",
          unit_price: l.unit_price != null ? String(l.unit_price) : "",
          include: true,
        }))
      );
    })();
  }, [selectedPoId]);

  const subtotal = useMemo(() => {
    return lineInputs.reduce((acc, l) => {
      if (!l.include) return acc;
      const q = Number(l.qty) || 0;
      const p = Number(l.unit_price) || 0;
      return acc + q * p;
    }, 0);
  }, [lineInputs]);

  const total = useMemo(() => subtotal + (Number(tax) || 0), [subtotal, tax]);

  function updateLine(idx: number, patch: Partial<LineInput>) {
    setLineInputs((xs) => xs.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);

    if (!invoiceNumber.trim()) { setErr("Invoice number is required."); return; }
    if (!selectedPoId) { setErr("Select a PO."); return; }
    const includedLines = lineInputs.filter((l) => l.include && (Number(l.qty) || 0) > 0);
    if (includedLines.length === 0) { setErr("Add at least one line with quantity > 0."); return; }

    const vendorIdRes = await supabaseVendor.from("vendor_users")
      .select("vendor_id").eq("id", vendorUserId!).maybeSingle();
    const vendor_id = vendorIdRes.data?.vendor_id;
    if (!vendor_id) { setErr("Could not resolve vendor id."); return; }

    setBusy(true);
    try {
      const { data: inv, error: invErr } = await supabaseVendor
        .from("invoices")
        .insert({
          vendor_id,
          po_id: selectedPoId,
          invoice_number: invoiceNumber.trim(),
          invoice_date: invoiceDate || null,
          due_date: dueDate || null,
          subtotal,
          tax: Number(tax) || 0,
          total,
          currency,
          status: "submitted",
          submitted_by: vendorUserId,
          notes: notes.trim() || null,
        })
        .select("id")
        .single();
      if (invErr) throw invErr;

      const lineRows = includedLines.map((l, idx) => {
        const q = Number(l.qty) || 0;
        const p = Number(l.unit_price) || 0;
        return {
          invoice_id: inv!.id,
          po_line_item_id: l.line_id,
          line_index: idx + 1,
          description: l.description || null,
          quantity_invoiced: q,
          unit_price: p,
          line_total: q * p,
        };
      });
      const { error: lineErr } = await supabaseVendor.from("invoice_line_items").insert(lineRows);
      if (lineErr) throw lineErr;

      nav(`/vendor/invoices/${inv!.id}`, { replace: true });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 12 }}>
        <a href="/vendor/invoices" style={{ color: "#FFFFFF", fontSize: 13, textDecoration: "none" }}>← Back to invoices</a>
      </div>

      <form onSubmit={submit} style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 24, boxShadow: `0 1px 2px ${TH.shadow}` }}>
        <h1 style={{ margin: 0, marginBottom: 6, fontSize: 20, color: TH.text }}>Submit invoice</h1>
        <p style={{ margin: 0, marginBottom: 20, color: TH.textMuted, fontSize: 13 }}>
          Select a PO, review line quantities, and submit. You can edit while status is "submitted" — once under review, changes must go through your Ring of Fire contact.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Purchase Order</label>
            <select
              value={selectedPoId}
              onChange={(e) => setSelectedPoId(e.target.value)}
              style={inputStyle}
              required
            >
              <option value="">— Select PO —</option>
              {pos.map((p) => (
                <option key={p.uuid_id} value={p.uuid_id}>
                  {p.po_number} {p.data?.BuyerName ? ` · ${p.data.BuyerName}` : ""} {p.data?.TotalAmount ? ` · ${fmtMoney(p.data.TotalAmount)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Invoice number</label>
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="e.g. INV-2026-0042"
              style={inputStyle}
              required
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
          <div>
            <label style={labelStyle}>Invoice date</label>
            <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Due date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Currency</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="CNY">CNY</option>
              <option value="HKD">HKD</option>
              <option value="INR">INR</option>
            </select>
          </div>
        </div>

        {selectedPoId && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: TH.text, marginBottom: 8 }}>
              Line items ({lineInputs.filter((l) => l.include).length} included)
            </div>
            {poLines.length === 0 ? (
              <div style={{ padding: 16, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, fontSize: 13, color: TH.textMuted, marginBottom: 14 }}>
                This PO has no line items materialized yet. Ask your Ring of Fire contact to sync the PO in TandA.
              </div>
            ) : (
              <div style={{ border: `1px solid ${TH.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 100px 120px 120px", padding: "8px 12px", background: TH.surfaceHi, borderBottom: `1px solid ${TH.border}`, fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase" }}>
                  <div></div>
                  <div>Item</div>
                  <div>Description</div>
                  <div>Qty</div>
                  <div>Unit price</div>
                  <div style={{ textAlign: "right" }}>Line total</div>
                </div>
                {lineInputs.map((l, idx) => {
                  const po = poLines[idx];
                  const lineTotal = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
                  return (
                    <div key={l.line_id} style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 100px 120px 120px", padding: "8px 12px", borderBottom: `1px solid ${TH.border}`, fontSize: 13, alignItems: "center", gap: 6, opacity: l.include ? 1 : 0.5 }}>
                      <input type="checkbox" checked={l.include} onChange={(e) => updateLine(idx, { include: e.target.checked })} />
                      <div style={{ fontFamily: "Menlo, monospace", fontSize: 12, color: TH.textSub2 }}>{po?.item_number ?? "—"}</div>
                      <input value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} style={{ ...inputStyle, marginBottom: 0, fontSize: 12, padding: "5px 8px" }} />
                      <input type="number" step="any" value={l.qty} onChange={(e) => updateLine(idx, { qty: e.target.value })} style={{ ...inputStyle, marginBottom: 0, fontSize: 12, padding: "5px 8px" }} />
                      <input type="number" step="any" value={l.unit_price} onChange={(e) => updateLine(idx, { unit_price: e.target.value })} style={{ ...inputStyle, marginBottom: 0, fontSize: 12, padding: "5px 8px" }} />
                      <div style={{ textAlign: "right", fontWeight: 600, color: TH.text }}>{fmtMoney(lineTotal)}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 14, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>Notes (optional)</label>
                <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, fontFamily: "inherit", resize: "vertical" }} />
              </div>
              <div style={{ background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, padding: "14px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: TH.textSub2, marginBottom: 8 }}>
                  <span>Subtotal</span>
                  <strong style={{ color: TH.text }}>{fmtMoney(subtotal)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: TH.textSub2, marginBottom: 8 }}>
                  <span>Tax</span>
                  <input type="number" step="any" value={tax} onChange={(e) => setTax(e.target.value)} style={{ width: 120, padding: "4px 8px", borderRadius: 4, border: `1px solid ${TH.border}`, fontFamily: "inherit", fontSize: 13, textAlign: "right" }} />
                </div>
                <div style={{ borderTop: `1px solid ${TH.border}`, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 15 }}>
                  <strong>Total</strong>
                  <strong style={{ color: TH.primary }}>{fmtMoney(total)}</strong>
                </div>
              </div>
            </div>
          </>
        )}

        {err && (
          <div style={{ color: TH.primary, padding: "10px 12px", background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" onClick={() => nav("/vendor/invoices")} style={{ padding: "9px 16px", borderRadius: 7, border: `1px solid ${TH.border}`, background: "none", color: TH.textMuted, cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !selectedPoId} style={{ padding: "9px 20px", borderRadius: 7, border: "none", background: busy || !selectedPoId ? TH.textMuted : TH.primary, color: "#FFFFFF", cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>
            {busy ? "Submitting…" : "Submit invoice"}
          </button>
        </div>
      </form>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: TH.textSub, marginBottom: 6 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${TH.border}`, fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit", marginBottom: 0 };
