// src/tanda/InternalSalesReturns.tsx
//
// P19 / M23 — Customer Returns / RMA. Create a return, disposition each line
// (restock → back to FIFO + COGS reversal; scrap → revenue/AR credit only),
// then issue a customer credit memo (reuses the ar_credit_memo posting rule;
// revenue routes to 4100 Sales Returns & Allowances). Lifecycle:
// requested → approved → received → credited.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import LineColorSizeMatrix, { type MatrixEntry } from "./components/LineColorSizeMatrix";
import { useItemResolver } from "./hooks/useItemResolver";
import LineViewToggle, { type LineView } from "./components/LineViewToggle";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444", violet: "#8B5CF6",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
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
type RmaReason = { id: string; code: string; name: string };
type NewLine = { sku_code: string; description: string; qty: string; unit_price: string; reason: string };

export default function InternalSalesReturns() {
  const [rmas, setRmas] = useState<Rma[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reasons, setReasons] = useState<RmaReason[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Admin gate for the "+ Add new reason…" path — same signal Style Master
  // uses: a cached MS auth user uuid (present only after MS sign-in).
  const isAdmin = !!getCachedAuthUserId();

  // create form
  const [custId, setCustId] = useState("");
  const [reason, setReason] = useState("");
  const [newLines, setNewLines] = useState<NewLine[]>([{ sku_code: "", description: "", qty: "", unit_price: "", reason: "" }]);

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
  useEffect(() => {
    fetch("/api/internal/rma-reasons").then((r) => r.json())
      .then((a) => { if (Array.isArray(a)) setReasons(a as RmaReason[]); }).catch(() => {});
  }, []);

  const custName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);

  // Reason picklist comes from rma_reason_master. The stored value is the
  // reason NAME (free text on sales_returns.reason) — fully backward-compatible
  // with existing free-text reasons. `current` keeps any value that isn't in
  // the master visible/selectable so legacy reasons don't vanish.
  const reasonOptions = useCallback((current: string): SearchableSelectOption[] => {
    const opts: SearchableSelectOption[] = [
      { value: "", label: "(none)" },
      ...reasons.map((r) => ({ value: r.name, label: r.name, searchHaystack: `${r.code} ${r.name}` })),
    ];
    if (current && !reasons.some((r) => r.name === current)) {
      opts.push({ value: current, label: current });
    }
    return opts;
  }, [reasons]);

  // Admin "+ Add new reason…" grows rma_reason_master (POST). Optimistically add
  // it to the local list; a 409 (already exists) is fine — the name is what we
  // wanted on the row anyway.
  const addReason = useCallback((qRaw: string, apply: (name: string) => void) => {
    const name = qRaw.trim();
    if (!name) return;
    apply(name);
    setReasons((prev) => prev.some((r) => r.name === name) ? prev : [...prev, { id: name, code: "", name }]);
    void (async () => {
      try {
        const r = await fetch("/api/internal/rma-reasons", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (r.ok) {
          const created = await r.json().catch(() => null);
          if (created && created.id) {
            setReasons((prev) => prev.map((x) => x.name === name ? { id: created.id, code: created.code || "", name } : x));
          }
        }
      } catch { /* keep optimistic entry; reason name is already applied */ }
    })();
  }, []);

  async function createRma() {
    if (!custId) { notify("Pick a customer", "error"); return; }
    const lines = newLines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({ sku_code: l.sku_code.trim() || undefined, description: l.description.trim() || undefined, qty_returned: Number(l.qty), unit_price_cents: Math.round((Number(l.unit_price) || 0) * 100), reason: l.reason.trim() || undefined }));
    if (lines.length === 0) { notify("Add at least one line with qty > 0", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/sales-returns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: custId, reason: reason.trim() || undefined, lines }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("RMA created", "success");
      setCreating(false); setCustId(""); setReason(""); setNewLines([{ sku_code: "", description: "", qty: "", unit_price: "", reason: "" }]);
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

  // #5 — tri-state column sort on the data grid. Derived columns (customer name,
  // lines count, credit total) get explicit accessors; rma_number/status read
  // straight off the row.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rmas, {
    persistKey: "tangerine:salesreturns:sort",
    accessors: {
      rma_number: (r) => r.rma_number || "",
      customer: (r) => r.customers?.name || custName.get(r.customer_id) || "",
      lines: (r) => r.sales_return_lines.length,
      credit: (r) => lineTotal(r),
    },
  });

  type ExportRow = { rma_number: string; customer: string; status: string; lines: number; credit_dollars: number };
  const exportRows: ExportRow[] = useMemo(() => {
    const body: ExportRow[] = rmas.map((r) => ({
      rma_number: r.rma_number || "(draft)",
      customer: r.customers?.name || custName.get(r.customer_id) || "",
      status: r.status,
      lines: r.sales_return_lines.length,
      credit_dollars: lineTotal(r) / 100,
    }));
    // #23 — append a TOTAL row summing numeric columns (guard empty).
    if (body.length > 0) {
      body.push({
        rma_number: "TOTAL", customer: "", status: "",
        lines: body.reduce((s, r) => s + r.lines, 0),
        credit_dollars: body.reduce((s, r) => s + r.credit_dollars, 0),
      });
    }
    return body;
  }, [rmas, custName]);
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
        <h2 style={{ margin: 0, fontSize: 18 }}>Returns / RMA</h2>
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
            <div style={{ minWidth: 240 }}>
              <SearchableSelect
                options={reasonOptions(reason)}
                value={reason}
                onChange={setReason}
                placeholder="Reason (optional)…"
                onAddNew={isAdmin ? (q) => addReason(q, setReason) : undefined}
                addNewLabel={(q) => { const t = q.trim(); return t ? `+ Add new reason "${t}"` : "+ Add new reason…"; }}
              />
            </div>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>SKU</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Unit $ (orig)</th><th style={th}>Reason</th><th style={th}></th></tr></thead>
            <tbody>
              {newLines.map((l, i) => (
                <tr key={i}>
                  <td style={td}><input style={{ ...input, width: "16ch" }} value={l.sku_code} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, sku_code: e.target.value } : x))} placeholder="STYLE-COLOR-SIZE" /></td>
                  <td style={td}><input style={{ ...input, width: "100%" }} value={l.description} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "7ch", textAlign: "right" }} value={l.qty} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "8ch", textAlign: "right" }} value={l.unit_price} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, unit_price: e.target.value } : x))} /></td>
                  <td style={{ ...td, minWidth: 200 }}>
                    <SearchableSelect
                      options={reasonOptions(l.reason)}
                      value={l.reason}
                      onChange={(v) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, reason: v } : x))}
                      placeholder="Reason…"
                      onAddNew={isAdmin ? (q) => addReason(q, (name) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, reason: name } : x))) : undefined}
                      addNewLabel={(q) => { const t = q.trim(); return t ? `+ Add new reason "${t}"` : "+ Add new reason…"; }}
                    />
                  </td>
                  <td style={td}>{newLines.length > 1 && <button style={{ ...btnS, color: C.danger, padding: "4px 8px" }} onClick={() => setNewLines((p) => p.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btnS} onClick={() => setNewLines((p) => [...p, { sku_code: "", description: "", qty: "", unit_price: "", reason: "" }])}>+ line</button>
            <button style={btnP} disabled={busy} onClick={createRma}>Create RMA</button>
            <span style={{ color: C.textMuted, fontSize: 12, alignSelf: "center" }}>Tip: enter the SKU so a restock can go back to inventory.</span>
          </div>
        </div>
      )}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="RMA #" sortKey="rma_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Lines" sortKey="lines" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
            <SortableTh label="Credit $" sortKey="credit" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
            <th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {rmas.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={6}>No returns yet.</td></tr>}
            {sorted.map((r) => (
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
                      <RmaLinesDetail rma={r} busy={busy} onSetDisposition={setDisposition} />
                      {r.credit_memo_id && <div style={{ color: C.success, fontSize: 12, marginTop: 8 }}>✓ Credit memo posted</div>}
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

// Expanded RMA detail — lines as an editable list (disposition pickers) or a
// read-only color × size matrix. Each line stores only inventory_item_id; the
// matrix resolves those ids → {color,size} via /api/internal/items?ids=…. Lines
// with no SKU (item id) or whose item lacks color/size fall back to a list.
function RmaLinesDetail({
  rma, busy, onSetDisposition,
}: {
  rma: Rma;
  busy: boolean;
  onSetDisposition: (rma: Rma, line: RmaLine, disposition: "restock" | "scrap" | "pending") => void;
}) {
  const [view, setView] = useState<LineView>("list");
  const editable = !["credited", "closed", "cancelled"].includes(rma.status);

  const itemIds = useMemo(
    () => rma.sales_return_lines.map((l) => l.inventory_item_id).filter(Boolean) as string[],
    [rma.sales_return_lines],
  );
  const { itemMap } = useItemResolver(itemIds, itemIds.length > 0);

  const matrixData = useMemo(() => {
    const matrixEntries: MatrixEntry[] = [];
    const fallback: { label: string; qty: number }[] = [];
    for (const l of rma.sales_return_lines) {
      const qty = Number(l.qty_returned) || 0;
      const resolved = l.inventory_item_id ? itemMap.get(l.inventory_item_id) : undefined;
      if (resolved && resolved.color && resolved.size) {
        matrixEntries.push({ color: resolved.color, size: resolved.size, qty });
      } else {
        fallback.push({ label: resolved?.sku_code || l.description || "(no SKU)", qty });
      }
    }
    return { matrixEntries, fallback };
  }, [rma.sales_return_lines, itemMap]);

  const sorted = [...rma.sales_return_lines].sort((a, b) => a.line_number - b.line_number);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <LineViewToggle value={view} onChange={setView} />
      </div>
      {view === "matrix" ? (
        <div>
          <LineColorSizeMatrix entries={matrixData.matrixEntries} />
          {matrixData.fallback.length > 0 && (
            <div style={{ marginTop: 10, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: "8px 12px" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                Non-matrix lines (no SKU / no color&size)
              </div>
              {matrixData.fallback.map((f, i) => (
                <div key={i} style={{ fontSize: 12, color: C.textSub, display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span>{f.label}</span>
                  {f.qty > 0 && <span style={{ fontFamily: "monospace", color: C.textMuted }}>qty {f.qty.toLocaleString()}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>#</th><th style={th}>Item</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Unit $</th><th style={th}>Disposition</th></tr></thead>
          <tbody>
            {sorted.map((l) => (
              <tr key={l.id}>
                <td style={td}>{l.line_number}</td>
                <td style={{ ...td, color: l.inventory_item_id ? C.text : C.warn }}>{(l.inventory_item_id && itemMap.get(l.inventory_item_id)?.sku_code) || (l.inventory_item_id ? "—" : "no SKU")}</td>
                <td style={td}>{l.description || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{Number(l.qty_returned)}</td>
                <td style={{ ...td, textAlign: "right" }}>${(l.unit_price_cents / 100).toFixed(2)}</td>
                <td style={td}>
                  {editable ? (
                    <SearchableSelect inputStyle={{ ...input, padding: "3px 6px" }} value={l.disposition} onChange={(v) => onSetDisposition(rma, l, v as "restock" | "scrap" | "pending")} disabled={busy}
                      options={[
                        { value: "pending", label: "— pick —" },
                        { value: "restock", label: `Restock${l.inventory_item_id ? "" : " (needs SKU)"}`, disabled: !l.inventory_item_id },
                        { value: "scrap", label: "Scrap" },
                      ]} />
                  ) : <span style={chip(l.disposition === "restock" ? C.success : C.textMuted)}>{l.disposition}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
