// src/tanda/InternalThreePL.tsx
//
// P21 / M13 — Third-Party Logistics. Two tabs:
//   • Providers — the 3PL provider master (contract warehouses/fulfillment).
//   • Shipments — inbound (to 3PL) / outbound (from 3PL) / return tracking with
//     a draft → in_transit → received → closed lifecycle + carrier/tracking.
// Actual FIFO-layer relocation + 3PL fee posting are follow-ups.

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
const tabBtn = (on: boolean): React.CSSProperties => ({ ...btnS, borderColor: on ? C.primary : C.cardBdr, color: on ? C.primary : C.textSub, fontWeight: on ? 700 : 400 });

const SH_COLOR: Record<string, string> = { draft: C.textMuted, in_transit: C.violet, received: C.success, closed: C.success, cancelled: C.danger };

type Provider = { id: string; code: string | null; name: string; kind: string; location_id: string | null; contact_name: string | null; email: string | null; phone: string | null; account_ref: string | null; billing_notes: string | null; is_active: boolean; notes: string | null; inventory_locations?: { code: string; name: string; kind: string } | null };
type ShLine = { id: string; line_number: number; inventory_item_id: string | null; description: string | null; qty: number | string };
type Shipment = { id: string; shipment_number: string | null; tpl_provider_id: string; direction: string; status: string; reference: string | null; carrier: string | null; tracking_number: string | null; ship_date: string | null; notes: string | null; created_at: string; tpl_providers?: { name: string; code: string | null } | null; tpl_shipment_lines: ShLine[] };
type NewLine = { sku_code: string; description: string; qty: string };

export default function InternalThreePL() {
  const [tab, setTab] = useState<"providers" | "shipments">("providers");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        fetch("/api/internal/tpl-providers").then((r) => r.json()),
        fetch("/api/internal/tpl-shipments").then((r) => r.json()),
      ]);
      setProviders(Array.isArray(p.providers) ? p.providers : []);
      setShipments(Array.isArray(s.shipments) ? s.shipments : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const provName = useMemo(() => new Map(providers.map((p) => [p.id, p.name])), [providers]);

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🚚 3PL</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>third-party logistics — providers + shipments</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={tabBtn(tab === "providers")} onClick={() => setTab("providers")}>Providers ({providers.length})</button>
          <button style={tabBtn(tab === "shipments")} onClick={() => setTab("shipments")}>Shipments ({shipments.length})</button>
        </div>
      </div>
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> :
        tab === "providers"
          ? <Providers providers={providers} busy={busy} setBusy={setBusy} reload={load} />
          : <Shipments shipments={shipments} providers={providers} provName={provName} busy={busy} setBusy={setBusy} reload={load} />}
    </div>
  );
}

function Providers({ providers, busy, setBusy, reload }: { providers: Provider[]; busy: boolean; setBusy: (b: boolean) => void; reload: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: "", code: "", kind: "contract_3pl", contact_name: "", email: "", phone: "", account_ref: "", billing_notes: "" });

  async function create() {
    if (!f.name.trim()) { notify("Name required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/tpl-providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("Provider created", "success");
      setCreating(false); setF({ name: "", code: "", kind: "contract_3pl", contact_name: "", email: "", phone: "", account_ref: "", billing_notes: "" });
      await reload();
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }
  async function toggleActive(p: Provider) {
    setBusy(true);
    try { await fetch("/api/internal/tpl-providers", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, is_active: !p.is_active }) }); await reload(); }
    catch (e) { notify(String(e instanceof Error ? e.message : e), "error"); } finally { setBusy(false); }
  }

  const cols: ExportColumn<{ code: string; name: string; kind: string; location: string; contact: string; active: string }>[] =
    [{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "kind", header: "Kind" }, { key: "location", header: "Location" }, { key: "contact", header: "Contact" }, { key: "active", header: "Active" }];
  const rows = providers.map((p) => ({ code: p.code || "", name: p.name, kind: p.kind, location: p.inventory_locations?.name || "", contact: p.contact_name || "", active: p.is_active ? "yes" : "no" }));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <ExportButton rows={rows} columns={cols} filename="tpl-providers" />
        <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Provider"}</button>
      </div>
      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, minWidth: 200 }} placeholder="Provider name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input style={{ ...input, width: "12ch" }} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <select style={input} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="contract_3pl">Contract 3PL</option><option value="fba">FBA</option><option value="wfs">WFS</option><option value="other">Other</option>
          </select>
          <input style={{ ...input, minWidth: 160 }} placeholder="Contact" value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
          <input style={{ ...input, minWidth: 160 }} placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input style={{ ...input, width: "14ch" }} placeholder="Acct #" value={f.account_ref} onChange={(e) => setF({ ...f, account_ref: e.target.value })} />
          <input style={{ ...input, minWidth: 200 }} placeholder="Billing / fee notes" value={f.billing_notes} onChange={(e) => setF({ ...f, billing_notes: e.target.value })} />
          <button style={btnP} disabled={busy} onClick={create}>Create</button>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Code</th><th style={th}>Name</th><th style={th}>Kind</th><th style={th}>Location</th><th style={th}>Contact</th><th style={th}>Billing</th><th style={th}>Active</th></tr></thead>
        <tbody>
          {providers.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No 3PL providers yet.</td></tr>}
          {providers.map((p) => (
            <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.5 }}>
              <td style={{ ...td, fontFamily: "monospace" }}>{p.code || "—"}</td>
              <td style={td}>{p.name}</td>
              <td style={td}><span style={chip(C.violet)}>{p.kind}</span></td>
              <td style={td}>{p.inventory_locations?.name || "—"}</td>
              <td style={td}>{p.contact_name || "—"}{p.email ? ` · ${p.email}` : ""}</td>
              <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{p.billing_notes || "—"}</td>
              <td style={td}><button style={{ ...btnS, padding: "3px 8px" }} disabled={busy} onClick={() => toggleActive(p)}>{p.is_active ? "yes" : "no"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Shipments({ shipments, providers, provName, busy, setBusy, reload }: { shipments: Shipment[]; providers: Provider[]; provName: Map<string, string>; busy: boolean; setBusy: (b: boolean) => void; reload: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [provId, setProvId] = useState("");
  const [dir, setDir] = useState("inbound");
  const [ref, setRef] = useState("");
  const [lines, setLines] = useState<NewLine[]>([{ sku_code: "", description: "", qty: "" }]);

  async function create() {
    if (!provId) { notify("Pick a provider", "error"); return; }
    const ls = lines.filter((l) => Number(l.qty) > 0).map((l) => ({ sku_code: l.sku_code.trim() || undefined, description: l.description.trim() || undefined, qty: Number(l.qty) }));
    if (ls.length === 0) { notify("Add a line with qty > 0", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/tpl-shipments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tpl_provider_id: provId, direction: dir, reference: ref.trim() || undefined, lines: ls }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("Shipment created", "success");
      setCreating(false); setProvId(""); setRef(""); setLines([{ sku_code: "", description: "", qty: "" }]);
      await reload(); setExpanded(j.id);
    } catch (e) { notify("Create failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setBusy(false); }
  }
  async function patch(s: Shipment, body: Record<string, unknown>, confirmMsg?: string) {
    if (confirmMsg && !(await confirmDialog(confirmMsg))) return;
    setBusy(true);
    try { const r = await fetch(`/api/internal/tpl-shipments/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || "failed"); await reload(); }
    catch (e) { notify("Action failed — " + (e instanceof Error ? e.message : String(e)), "error"); } finally { setBusy(false); }
  }

  const cols: ExportColumn<{ num: string; provider: string; direction: string; status: string; units: number }>[] =
    [{ key: "num", header: "Shipment #" }, { key: "provider", header: "Provider" }, { key: "direction", header: "Direction" }, { key: "status", header: "Status" }, { key: "units", header: "Units", format: "number" }];
  const units = (s: Shipment) => s.tpl_shipment_lines.reduce((n, l) => n + Number(l.qty), 0);
  const rows = shipments.map((s) => ({ num: s.shipment_number || "(draft)", provider: s.tpl_providers?.name || provName.get(s.tpl_provider_id) || "", direction: s.direction, status: s.status, units: units(s) }));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <ExportButton rows={rows} columns={cols} filename="tpl-shipments" />
        <button style={btnP} onClick={() => setCreating((v) => !v)} disabled={providers.length === 0}>{creating ? "Cancel" : "+ New Shipment"}</button>
        {providers.length === 0 && <span style={{ color: C.textMuted, fontSize: 12, alignSelf: "center" }}>add a provider first</span>}
      </div>
      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ minWidth: 220 }}><SearchableSelect options={providers.map((p) => ({ value: p.id, label: p.name, searchHaystack: `${p.name} ${p.code || ""}` }))} value={provId} onChange={setProvId} placeholder="3PL provider…" /></div>
            <select style={input} value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="inbound">Inbound (to 3PL)</option><option value="outbound">Outbound (from 3PL)</option><option value="return">Return (back to us)</option>
            </select>
            <input style={{ ...input, minWidth: 180 }} placeholder="Reference / ASN" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>SKU</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th><th style={th}></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td style={td}><input style={{ ...input, width: "15ch" }} value={l.sku_code} onChange={(e) => setLines((p) => p.map((x, j) => j === i ? { ...x, sku_code: e.target.value } : x))} placeholder="SKU (optional)" /></td>
                  <td style={td}><input style={{ ...input, width: "100%" }} value={l.description} onChange={(e) => setLines((p) => p.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></td>
                  <td style={td}><input style={{ ...input, width: "7ch", textAlign: "right" }} value={l.qty} onChange={(e) => setLines((p) => p.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></td>
                  <td style={td}>{lines.length > 1 && <button style={{ ...btnS, color: C.danger, padding: "4px 8px" }} onClick={() => setLines((p) => p.filter((_, j) => j !== i))}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btnS} onClick={() => setLines((p) => [...p, { sku_code: "", description: "", qty: "" }])}>+ line</button>
            <button style={btnP} disabled={busy} onClick={create}>Create shipment</button>
          </div>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Shipment #</th><th style={th}>Provider</th><th style={th}>Direction</th><th style={th}>Status</th><th style={{ ...th, textAlign: "right" }}>Units</th><th style={th}>Tracking</th><th style={th}>Actions</th></tr></thead>
        <tbody>
          {shipments.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No shipments yet.</td></tr>}
          {shipments.map((s) => (
            <Fragment key={s.id}>
              <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                <td style={{ ...td, fontFamily: "monospace", color: C.primary }}>{s.shipment_number || "(draft)"}</td>
                <td style={td}>{s.tpl_providers?.name || provName.get(s.tpl_provider_id) || "—"}</td>
                <td style={td}>{s.direction}</td>
                <td style={td}><span style={chip(SH_COLOR[s.status] || C.textMuted)}>{s.status.replace("_", " ")}</span></td>
                <td style={{ ...td, textAlign: "right" }}>{units(s)}</td>
                <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{s.tracking_number ? `${s.carrier || ""} ${s.tracking_number}` : "—"}</td>
                <td style={td} onClick={(e) => e.stopPropagation()}>
                  {s.status === "draft" && <button style={{ ...btnP, padding: "4px 10px" }} disabled={busy} onClick={() => patch(s, { action: "send" })}>Send</button>}
                  {s.status === "in_transit" && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(s, { action: "receive" })}>Receive</button>}
                  {s.status === "received" && <button style={{ ...btnS, padding: "4px 10px" }} disabled={busy} onClick={() => patch(s, { action: "close" })}>Close</button>}
                  {!["received", "closed", "cancelled"].includes(s.status) && <button style={{ ...btnS, color: C.danger, padding: "4px 10px", marginLeft: 6 }} disabled={busy} onClick={() => patch(s, { action: "cancel" }, "Cancel this shipment?")}>Cancel</button>}
                </td>
              </tr>
              {expanded === s.id && (
                <tr><td style={{ ...td, background: "#0b1220" }} colSpan={7}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
                    <thead><tr><th style={th}>#</th><th style={th}>Item</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Qty</th></tr></thead>
                    <tbody>
                      {s.tpl_shipment_lines.sort((a, b) => a.line_number - b.line_number).map((l) => (
                        <tr key={l.id}><td style={td}>{l.line_number}</td><td style={{ ...td, fontFamily: "monospace", color: l.inventory_item_id ? C.text : C.textMuted }}>{l.inventory_item_id ? l.inventory_item_id.slice(0, 8) : "—"}</td><td style={td}>{l.description || "—"}</td><td style={{ ...td, textAlign: "right" }}>{Number(l.qty)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <TrackingEditor s={s} busy={busy} onSave={(carrier, tracking) => patch(s, { carrier, tracking_number: tracking })} />
                  {s.notes && <div style={{ color: C.textMuted, fontSize: 12, marginTop: 6 }}>Notes: {s.notes}</div>}
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackingEditor({ s, onSave, busy }: { s: Shipment; onSave: (carrier: string, tracking: string) => void; busy: boolean }) {
  const [carrier, setCarrier] = useState(s.carrier || "");
  const [tracking, setTracking] = useState(s.tracking_number || "");
  const editable = !["closed", "cancelled"].includes(s.status);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: C.textMuted, fontSize: 12 }}>Tracking:</span>
      <input style={{ ...input, width: "16ch" }} placeholder="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} disabled={!editable} />
      <input style={{ ...input, width: "22ch" }} placeholder="Tracking #" value={tracking} onChange={(e) => setTracking(e.target.value)} disabled={!editable} />
      {editable && <button style={{ ...btnS, padding: "5px 12px" }} disabled={busy} onClick={() => onSave(carrier.trim(), tracking.trim())}>Save</button>}
    </div>
  );
}
