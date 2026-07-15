// src/tanda/InternalDropShip.tsx
//
// P20 / M49 — Drop-ship management. A drop-ship order is shipped by the vendor
// directly to the customer — no warehouse, no inventory movement. Capture the
// customer + vendor + ship-to + lines (customer price vs vendor cost → margin),
// then run the lifecycle: requested → confirmed → shipped → delivered → closed,
// with carrier / tracking. (AR-invoice + AP-bill generation is a follow-up,
// gated on the COA having standard AR / Revenue / COGS / AP accounts.)

import { Fragment, useEffect, useMemo, useState } from "react";
import SearchableSelect from "./components/SearchableSelect";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useCanSeeMargins } from "../hooks/useCanSeeMargins";

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
  requested: C.textMuted, confirmed: C.primary, shipped: C.violet, delivered: C.success, closed: C.success, cancelled: C.danger,
};

type DsLine = {
  id: string; line_number: number; inventory_item_id: string | null; description: string | null;
  qty: number | string; customer_unit_price_cents: number; vendor_unit_cost_cents: number;
};
type Ds = {
  id: string; ds_number: string | null; customer_id: string; vendor_id: string; status: string;
  carrier: string | null; tracking_number: string | null; notes: string | null; created_at: string;
  customers?: { name: string } | null; vendors?: { name: string } | null;
  drop_ship_lines: DsLine[];
};
type Opt = { id: string; name: string; customer_code?: string; code?: string };
type NewLine = { sku_code: string; description: string; qty: string; price: string; cost: string };

export default function InternalDropShip() {
  const [rows, setRows] = useState<Ds[]>([]);
  const [customers, setCustomers] = useState<Opt[]>([]);
  const [vendors, setVendors] = useState<Opt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Margin visibility/export gate (permission-driven; fails open until enforced).
  const { canView: canViewMargins, canExport: canExportMargins } = useCanSeeMargins();

  const [custId, setCustId] = useState("");
  const [vendId, setVendId] = useState("");
  const [notes, setNotes] = useState("");
  const [newLines, setNewLines] = useState<NewLine[]>([{ sku_code: "", description: "", qty: "", price: "", cost: "" }]);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/internal/drop-ship");
      const j = await r.json();
      setRows(Array.isArray(j.orders) ? j.orders : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=1000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setCustomers(a as Opt[]); }).catch(() => {});
    fetch("/api/internal/vendor-master?limit=1000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setVendors(a as Opt[]); }).catch(() => {});
  }, []);

  const custName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const vendName = useMemo(() => new Map(vendors.map((v) => [v.id, v.name])), [vendors]);

  // Resolve line inventory_item_id → human sku_code (no raw UUIDs in the table).
  const [skuById, setSkuById] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = Array.from(new Set(
      rows.flatMap((o) => o.drop_ship_lines.map((l) => l.inventory_item_id)).filter((v): v is string => !!v),
    )).filter((id) => !(id in skuById));
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/internal/items?ids=${encodeURIComponent(ids.join(","))}`);
        if (!r.ok) return;
        const data = (await r.json()) as Array<{ id: string; sku_code: string | null }>;
        if (cancelled) return;
        setSkuById((prev) => {
          const next = { ...prev };
          for (const it of data) next[it.id] = it.sku_code || "—";
          return next;
        });
      } catch { /* leave as "—" */ }
    })();
    return () => { cancelled = true; };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  function margin(o: Ds) { return o.drop_ship_lines.reduce((s, l) => s + Number(l.qty) * (l.customer_unit_price_cents - l.vendor_unit_cost_cents), 0); }
  function revenue(o: Ds) { return o.drop_ship_lines.reduce((s, l) => s + Number(l.qty) * l.customer_unit_price_cents, 0); }

  // #5 — tri-state column sort on the data grid. Derived columns (customer /
  // vendor names, revenue, margin) get explicit accessors; ds_number/status read
  // straight off the row.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:dropship:sort",
    accessors: {
      ds_number: (o) => o.ds_number || "",
      customer: (o) => o.customers?.name || custName.get(o.customer_id) || "",
      vendor: (o) => o.vendors?.name || vendName.get(o.vendor_id) || "",
      revenue: (o) => revenue(o),
      margin: (o) => margin(o),
    },
  });

  async function createDs() {
    if (!custId) { notify("Pick a customer", "error"); return; }
    if (!vendId) { notify("Pick a vendor", "error"); return; }
    const lines = newLines.filter((l) => Number(l.qty) > 0).map((l) => ({
      sku_code: l.sku_code.trim() || undefined, description: l.description.trim() || undefined,
      qty: Number(l.qty),
      customer_unit_price_cents: Math.round((Number(l.price) || 0) * 100),
      vendor_unit_cost_cents: Math.round((Number(l.cost) || 0) * 100),
    }));
    if (lines.length === 0) { notify("Add at least one line with qty > 0", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/drop-ship", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: custId, vendor_id: vendId, notes: notes.trim() || undefined, lines }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("Drop-ship order created", "success");
      setCreating(false); setCustId(""); setVendId(""); setNotes(""); setNewLines([{ sku_code: "", description: "", qty: "", price: "", cost: "" }]);
      await load(); setExpanded(j.id);
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  async function patch(o: Ds, body: Record<string, unknown>, confirmMsg?: string) {
    if (confirmMsg && !(await confirmDialog(confirmMsg))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/internal/drop-ship/${o.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "update failed");
      await load();
    } catch (e) { notify("Action failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }

  type ExportRow = { ds_number: string; customer: string; vendor: string; status: string; lines: number; revenue_dollars: number; margin_dollars: number };
  const exportRows: ExportRow[] = useMemo(() => {
    const body: ExportRow[] = rows.map((o) => ({
      ds_number: o.ds_number || "(draft)",
      customer: o.customers?.name || custName.get(o.customer_id) || "",
      vendor: o.vendors?.name || vendName.get(o.vendor_id) || "",
      status: o.status, lines: o.drop_ship_lines.length,
      revenue_dollars: revenue(o) / 100, margin_dollars: margin(o) / 100,
    }));
    // #23 — append a TOTAL row summing numeric columns (guard empty).
    if (body.length > 0) {
      body.push({
        ds_number: "TOTAL", customer: "", vendor: "", status: "",
        lines: body.reduce((s, r) => s + r.lines, 0),
        revenue_dollars: body.reduce((s, r) => s + r.revenue_dollars, 0),
        margin_dollars: body.reduce((s, r) => s + r.margin_dollars, 0),
      });
    }
    return body;
  }, [rows, custName, vendName]);
  const allExportCols: ExportColumn<ExportRow>[] = [
    { key: "ds_number", header: "DS #" }, { key: "customer", header: "Customer" }, { key: "vendor", header: "Vendor" },
    { key: "status", header: "Status" }, { key: "lines", header: "Lines", format: "number" },
    { key: "revenue_dollars", header: "Revenue $", format: "currency_dollars" }, { key: "margin_dollars", header: "Margin $", format: "currency_dollars" },
  ];
  const exportCols = allExportCols.filter((c) => canExportMargins || c.key !== "margin_dollars");

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Drop-Ship</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>vendor ships direct to customer · no inventory movement</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <ExportButton rows={exportRows} columns={exportCols} filename="drop-ship" />
          <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Drop-Ship"}</button>
        </div>
      </div>

      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ minWidth: 240 }}>
              <SearchableSelect options={customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))} value={custId} onChange={setCustId} placeholder="Customer…" />
            </div>
            <div style={{ minWidth: 240 }}>
              <SearchableSelect options={vendors.map((v) => ({ value: v.id, label: v.name, searchHaystack: `${v.name} ${v.code || ""}` }))} value={vendId} onChange={setVendId} placeholder="Vendor (drop-shipper)…" />
            </div>
            <input style={{ ...input, minWidth: 200 }} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>SKU</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Cust $</th><th style={{ ...th, textAlign: "right" }}>Cost $</th><th style={th}></th></tr></thead>
            <tbody>
              {newLines.map((l, i) => (
                <tr key={i}>
                  <td style={td}><input style={{ ...input, width: "15ch" }} value={l.sku_code} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, sku_code: e.target.value } : x))} placeholder="SKU (optional)" /></td>
                  <td style={td}><input style={{ ...input, width: "100%" }} value={l.description} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "6ch", textAlign: "right" }} value={l.qty} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "8ch", textAlign: "right" }} value={l.price} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, price: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "8ch", textAlign: "right" }} value={l.cost} onChange={(e) => setNewLines((p) => p.map((x, j) => j === i ? { ...x, cost: e.target.value } : x))} /></td>
                  <td style={td}>{newLines.length > 1 && <button style={{ ...btnS, color: C.danger, padding: "4px 8px" }} onClick={() => setNewLines((p) => p.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btnS} onClick={() => setNewLines((p) => [...p, { sku_code: "", description: "", qty: "", price: "", cost: "" }])}>+ line</button>
            <button style={btnP} disabled={busy} onClick={createDs}>Create order</button>
          </div>
        </div>
      )}

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <SortableTh label="DS #" sortKey="ds_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Customer" sortKey="customer" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Vendor" sortKey="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
            <SortableTh label="Rev $" sortKey="revenue" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />
            {canViewMargins && <SortableTh label="Margin $" sortKey="margin" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} cellStyle={{ textAlign: "right" }} />}
            <th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No drop-ship orders yet.</td></tr>}
            {sorted.map((o) => (
              <Fragment key={o.id}>
                <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
                  <td style={{ ...td, fontFamily: "monospace", color: C.primary }}>{o.ds_number || "(draft)"}</td>
                  <td style={td}>{o.customers?.name || custName.get(o.customer_id) || "—"}</td>
                  <td style={td}>{o.vendors?.name || vendName.get(o.vendor_id) || "—"}</td>
                  <td style={td}><span style={chip(STATUS_COLOR[o.status] || C.textMuted)}>{o.status}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>${(revenue(o) / 100).toFixed(2)}</td>
                  {canViewMargins && <td style={{ ...td, textAlign: "right", color: margin(o) >= 0 ? C.success : C.danger }}>${(margin(o) / 100).toFixed(2)}</td>}
                  <td style={td} onClick={(e) => e.stopPropagation()}>
                    {o.status === "requested" && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(o, { action: "confirm" })}>Confirm</button>}
                    {o.status === "confirmed" && <button style={{ ...btnP, padding: "4px 10px" }} disabled={busy} onClick={() => patch(o, { action: "ship" })}>Mark shipped</button>}
                    {o.status === "shipped" && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(o, { action: "deliver" })}>Delivered</button>}
                    {(o.status === "shipped" || o.status === "delivered") && <button style={{ ...btnS, padding: "4px 10px", marginLeft: 6 }} disabled={busy} onClick={() => patch(o, { action: "close" })}>Close</button>}
                    {!["closed", "cancelled"].includes(o.status) && <button style={{ ...btnS, color: C.danger, padding: "4px 10px", marginLeft: 6 }} disabled={busy} onClick={() => patch(o, { action: "cancel" }, "Cancel this drop-ship order?")}>Cancel</button>}
                  </td>
                </tr>
                {expanded === o.id && (
                  <tr>
                    <td style={{ ...td, background: "#0b1220" }} colSpan={7}>
                      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
                        <thead><tr><th style={th}>#</th><th style={th}>Item</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={{ ...th, textAlign: "right" }}>Cust $</th><th style={{ ...th, textAlign: "right" }}>Cost $</th>{canViewMargins && <th style={{ ...th, textAlign: "right" }}>Margin $</th>}</tr></thead>
                        <tbody>
                          {o.drop_ship_lines.sort((a, b) => a.line_number - b.line_number).map((l) => (
                            <tr key={l.id}>
                              <td style={td}>{l.line_number}</td>
                              <td style={{ ...td, color: l.inventory_item_id ? C.text : C.textMuted }}>{l.inventory_item_id ? (skuById[l.inventory_item_id] || "—") : "—"}</td>
                              <td style={td}>{l.description || "—"}</td>
                              <td style={{ ...td, textAlign: "right" }}>{Number(l.qty)}</td>
                              <td style={{ ...td, textAlign: "right" }}>${(l.customer_unit_price_cents / 100).toFixed(2)}</td>
                              <td style={{ ...td, textAlign: "right" }}>${(l.vendor_unit_cost_cents / 100).toFixed(2)}</td>
                              {canViewMargins && <td style={{ ...td, textAlign: "right", color: C.textSub }}>${(Number(l.qty) * (l.customer_unit_price_cents - l.vendor_unit_cost_cents) / 100).toFixed(2)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <TrackingEditor o={o} onSave={(carrier, tracking) => patch(o, { carrier, tracking_number: tracking })} busy={busy} />
                      {o.notes && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 8 }}>Notes: {o.notes}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function TrackingEditor({ o, onSave, busy }: { o: Ds; onSave: (carrier: string, tracking: string) => void; busy: boolean }) {
  const [carrier, setCarrier] = useState(o.carrier || "");
  const [tracking, setTracking] = useState(o.tracking_number || "");
  const editable = !["closed", "cancelled"].includes(o.status);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: C.textMuted, fontSize: 12 }}>Tracking:</span>
      <input style={{ ...input, width: "16ch" }} placeholder="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} disabled={!editable} />
      <input style={{ ...input, width: "22ch" }} placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} disabled={!editable} />
      {editable && <button style={{ ...btnS, padding: "5px 12px" }} disabled={busy} onClick={() => onSave(carrier.trim(), tracking.trim())}>Save</button>}
    </div>
  );
}
