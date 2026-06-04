// src/tanda/InternalSalesReturns.tsx
//
// P19 / M23 — Customer Returns / RMA. Create a return, disposition each line
// (restock → back to FIFO + COGS reversal; scrap → revenue/AR credit only),
// then issue a customer credit memo (reuses the ar_credit_memo posting rule;
// revenue routes to 4100 Sales Returns & Allowances). Lifecycle:
// requested → approved → received → credited.

import { Fragment, useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const input: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" };
const btnP: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnS: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "7px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const chip = (bg: string): React.CSSProperties => ({ background: bg + "22", color: bg, padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 });

const STATUS_COLOR: Record<string, string> = {
  requested: C.textMuted, approved: C.primary, received: C.violet, credited: C.success, closed: C.success, cancelled: C.danger,
};

type RmaLine = {
  id: string; line_number: number; inventory_item_id: string | null; description: string | null;
  qty_returned: number | string; unit_price_cents: number; disposition: "pending" | "restock" | "scrap";
  restock_location_id: string | null; reason: string | null;
};
type Rma = {
  id: string; rma_number: string | null; customer_id: string; status: string; reason: string | null;
  restocking_fee_cents: number; credit_memo_id: string | null; notes: string | null; created_at: string;
  customers?: { name: string; customer_code?: string } | null;
  sales_return_lines: RmaLine[];
};
type Customer = { id: string; name: string; customer_code?: string };
type NewLine = { sku_code: string; description: string; qty: string; unit_price: string };

export default function InternalSalesReturns() {
  const [rmas, setRmas] = useState<Rma[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // create form
  const [custId, setCustId] = useState("");
  const [reason, setReason] = useState("");
  const [newLines, setNewLines] = useState<NewLine[]>([{ sku_code: "", description: "", qty: "", unit_price: "" }]);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/internal/sales-returns");
      const j = await r.json();
      setRmas(Array.isArray(j.returns) ? j.returns : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setCustomers(a as Customer[]); }).catch(() => {});
  }, []);

  const custName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);

  async function createRma() {
    if (!custId) { notify("Pick a customer", "error"); return; }
    const lines = newLines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({ sku_code: l.sku_code.trim() || undefined, description: l.description.trim() || undefined, qty_returned: Number(l.qty), unit_price_cents: Math.round((Number(l.unit_price) || 0) * 100) }));
    if (lines.length === 0) { notify("Add at least one line with qty > 0", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/sales-returns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: custId, reason: reason.trim() || undefined, lines }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("RMA created", "success");
      setCreating(false); setCustId(""); setReason(""); setNewLines([{ sku_code: "", description: "", qty: "", unit_price: "" }]);
      await load(); setExpanded(j.id);
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  async function patch(rma: Rma, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch(`/api/internal/sales-returns/${rma.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "update failed");
      await load();
    } catch (e) { notify("Action failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  async function setDisposition(rma: Rma, line: RmaLine, disposition: "restock" | "scrap" | "pending") {
    await patch(rma, { line_dispositions: [{ id: line.id, disposition }] });
  }

  async function issueCredit(rma: Rma) {
    if (rma.sales_return_lines.some((l) => l.disposition === "pending")) { notify("Set a disposition on every line first", "error"); return; }
    if (!(await confirmDialog(`Issue + post a credit memo for ${rma.rma_number || "this RMA"}? Restock lines go back to inventory; all lines credit the customer (revenue → Sales Returns 4100).`))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/internal/sales-returns/${rma.id}/credit-memo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "credit failed");
      notify(j.message || "Credit memo posted", "success");
      await load();
    } catch (e) { notify("Credit memo failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  function lineTotal(r: Rma) { return r.sales_return_lines.reduce((s, l) => s + Number(l.qty_returned) * l.unit_price_cents, 0); }

  type ExportRow = { rma_number: string; customer: string; status: string; lines: number; credit_dollars: number };
  const exportRows: ExportRow[] = rmas.map((r) => ({
    rma_number: r.rma_number || "(draft)",
    customer: r.customers?.name || custName.get(r.customer_id) || "",
    status: r.status,
    lines: r.sales_return_lines.length,
    credit_dollars: lineTotal(r) / 100,
  }));
  const exportCols: ExportColumn<ExportRow>[] = [
    { key: "rma_number", header: "RMA #" },
    { key: "customer", header: "Customer" },
    { key: "status", header: "Status" },
    { key: "lines", header: "Lines", format: "number" },
    { key: "credit_dollars", header: "Credit $", format: "currency_dollars" },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>↩️ Returns / RMA</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>customer returns → disposition → credit memo</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <ExportButton rows={exportRows} columns={exportCols} filename="sales-returns" />
          <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Return"}</button>
        </div>
      </div>

      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ minWidth: 280 }}>
              <SearchableSelect
                options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))}
                value={custId} onChange={setCustId} placeholder="Pick customer…" />
            </div>
            <input style={{ ...input, minWidth: 240 }} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>SKU</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Unit $ (orig)</th><th style={th}></th></tr></thead>
            <tbody>
              {newLines.map((l, i) => (
                <tr key={i}>
                  <td style={td}><input style={{ ...input, width: "16ch" }} value={l.sku_code} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, sku_code: e.target.value } : x))} placeholder="STYLE-COLOR-SIZE" /></td>
                  <td style={td}><input style={{ ...input, width: "100%" }} value={l.description} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "7ch", textAlign: "right" }} value={l.qty} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "8ch", textAlign: "right" }} value={l.unit_price} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, unit_price: e.target.value } : x))} /></td>
                  <td style={td}>{newLines.length > 1 && <button style={{ ...btnS, color: C.danger, padding: "4px 8px" }} onClick={() => setNewLines((p) => p.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btnS} onClick={() => setNewLines((p) => [...p, { sku_code: "", description: "", qty: "", unit_price: "" }])}>+ line</button>
            <button style={btnP} disabled={busy} onClick={createRma}>Create RMA</button>
            <span style={{ color: C.textMuted, fontSize: 12, alignSelf: "center" }}>Tip: enter the SKU so a restock can go back to inventory.</span>
          </div>
        </div>
      )}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>RMA #</th><th style={th}>Customer</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Lines</th><th style={{ ...th, textAlign: "right" }}>Credit $</th><th style={th}>Actions</th></tr></thead>
          <tbody>
            {rmas.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={6}>No returns yet.</td></tr>}
            {rmas.map((r) => (
              <Fragment key={r.id}>
                <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                  <td style={{ ...td, fontFamily: "monospace", color: C.primary }}>{r.rma_number || "(draft)"}</td>
                  <td style={td}>{r.customers?.name || custName.get(r.customer_id) || "—"}</td>
                  <td style={td}><span style={chip(STATUS_COLOR[r.status] || C.textMuted)}>{r.status}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>{r.sales_return_lines.length}</td>
                  <td style={{ ...td, textAlign: "right" }}>${(lineTotal(r) / 100).toFixed(2)}</td>
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    {r.status === "requested" && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(r, { action: "approve" })}>Approve</button>}
                    {(r.status === "approved") && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(r, { action: "receive" })}>Receive</button>}
                    {(r.status === "approved" || r.status === "received") && <button style={{ ...btnP, padding: "4px 10px", marginLeft: 6 }} disabled={busy} onClick={() => issueCredit(r)}>Issue credit memo</button>}
                    {!["credited", "closed", "cancelled"].includes(r.status) && <button style={{ ...btnS, color: C.danger, padding: "4px 10px", marginLeft: 6 }} disabled={busy} onClick={() => patch(r, { action: "cancel" })}>Cancel</button>}
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td style={{ ...td, background: "#0b1220" }} colSpan={6}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr><th style={th}>#</th><th style={th}>Item</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Unit $</th><th style={th}>Disposition</th></tr></thead>
                        <tbody>
                          {r.sales_return_lines.sort((a, b) => a.line_number - b.line_number).map((l) => {
                            const editable = !["credited", "closed", "cancelled"].includes(r.status);
                            return (
                              <tr key={l.id}>
                                <td style={td}>{l.line_number}</td>
                                <td style={{ ...td, fontFamily: "monospace", color: l.inventory_item_id ? C.text : C.warn }}>{l.inventory_item_id ? l.inventory_item_id.slice(0, 8) : "no SKU"}</td>
                                <td style={td}>{l.description || "—"}</td>
                                <td style={{ ...td, textAlign: "right" }}>{Number(l.qty_returned)}</td>
                                <td style={{ ...td, textAlign: "right" }}>${(l.unit_price_cents / 100).toFixed(2)}</td>
                                <td style={td}>
                                  {editable ? (
                                    <select style={{ ...input, padding: "3px 6px" }} value={l.disposition} onChange={(e) => setDisposition(r, l, e.target.value as "restock" | "scrap" | "pending")} disabled={busy}>
                                      <option value="pending">— pick —</option>
                                      <option value="restock" disabled={!l.inventory_item_id}>Restock{l.inventory_item_id ? "" : " (needs SKU)"}</option>
                                      <option value="scrap">Scrap</option>
                                    </select>
                                  ) : <span style={chip(l.disposition === "restock" ? C.success : C.textMuted)}>{l.disposition}</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {r.credit_memo_id && <div style={{ color: C.success, fontSize: 12, marginTop: 8 }}>✓ Credit memo posted ({r.credit_memo_id.slice(0, 8)})</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
