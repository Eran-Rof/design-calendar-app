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
import { useItemResolver, type ResolvedItem } from "./hooks/useItemResolver";
import ContactList, { type Contact } from "./components/ContactList";
import RowHistory from "./components/RowHistory";
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
const tabBtn = (on: boolean): React.CSSProperties => ({ ...btnS, borderColor: on ? C.primary : C.cardBdr, color: on ? C.primary : C.textSub, fontWeight: on ? 700 : 400 });

const SH_COLOR: Record<string, string> = { draft: C.textMuted, in_transit: C.violet, received: C.success, closed: C.success, cancelled: C.danger };

type Provider = { id: string; code: string | null; name: string; kind: string; location_id: string | null; contact_name: string | null; email: string | null; phone: string | null; account_ref: string | null; billing_notes: string | null; is_active: boolean; notes: string | null; contacts?: Contact[] | null; inventory_locations?: { code: string; name: string; kind: string } | null };
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
  const itemIds = useMemo(() => shipments.flatMap((s) => s.tpl_shipment_lines.map((l) => l.inventory_item_id).filter(Boolean) as string[]), [shipments]);
  const { itemMap } = useItemResolver(itemIds, itemIds.length > 0);

  return (
    <div style={{ background: C.bg, minHeight: "100%", color: C.text, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>3PL</h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>third-party logistics — providers + shipments</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={tabBtn(tab === "providers")} onClick={() => setTab("providers")}>Providers ({providers.length})</button>
          <button style={tabBtn(tab === "shipments")} onClick={() => setTab("shipments")}>Shipments ({shipments.length})</button>
        </div>
      </div>
      {loading ? <div style={{ color: C.textMuted }}>Loading…</div> :
        tab === "providers"
          ? <Providers providers={providers} busy={busy} setBusy={setBusy} reload={load} />
          : <Shipments shipments={shipments} providers={providers} provName={provName} itemMap={itemMap} busy={busy} setBusy={setBusy} reload={load} />}
    </div>
  );
}

function Providers({ providers, busy, setBusy, reload }: { providers: Provider[]; busy: boolean; setBusy: (b: boolean) => void; reload: () => Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  // code is auto-generated server-side (TPL-NNNNN) + immutable — not entered here.
  const [f, setF] = useState({ name: "", kind: "contract_3pl", contact_name: "", email: "", phone: "", account_ref: "", billing_notes: "" });

  async function create() {
    if (!f.name.trim()) { notify("Name required", "error"); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/internal/tpl-providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "create failed");
      notify("Provider created", "success");
      setCreating(false); setF({ name: "", kind: "contract_3pl", contact_name: "", email: "", phone: "", account_ref: "", billing_notes: "" });
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

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(providers, {
    persistKey: "tangerine:tpl-providers:sort",
    accessors: {
      location: (p) => p.inventory_locations?.name || "",
      contact: (p) => p.contact_name || "",
      contacts: (p) => (Array.isArray(p.contacts) ? p.contacts.length : 0),
      billing: (p) => p.billing_notes || "",
      active: (p) => (p.is_active ? 1 : 0),
    },
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <ExportButton rows={rows} columns={cols} filename="tpl-providers" />
        <button style={btnP} onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "+ New Provider"}</button>
      </div>
      {creating && (
        <div style={{ background: C.card, border: `1px solid ${C.primary}`, borderRadius: 8, padding: 14, marginBottom: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input style={{ ...input, minWidth: 200 }} placeholder="Provider name *" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          {/* Code is auto-generated (TPL-NNNNN) + immutable — assigned on save. */}
          <span style={{ ...input, width: "12ch", opacity: 0.55, fontFamily: "monospace", display: "flex", alignItems: "center", fontStyle: "italic" }} title="Code is auto-generated (TPL-NNNNN)">auto</span>
          <SearchableSelect
            value={f.kind}
            onChange={(v) => setF({ ...f, kind: v })}
            inputStyle={input}
            options={[
              { value: "contract_3pl", label: "Contract 3PL" },
              { value: "fba", label: "FBA" },
              { value: "wfs", label: "WFS" },
              { value: "other", label: "Other" },
            ]}
          />
          <input style={{ ...input, minWidth: 160 }} placeholder="Contact" value={f.contact_name} onChange={(e) => setF({ ...f, contact_name: e.target.value })} />
          <input style={{ ...input, minWidth: 160 }} placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <input style={{ ...input, width: "14ch" }} placeholder="Acct #" value={f.account_ref} onChange={(e) => setF({ ...f, account_ref: e.target.value })} />
          <input style={{ ...input, minWidth: 200 }} placeholder="Billing / fee notes" value={f.billing_notes} onChange={(e) => setF({ ...f, billing_notes: e.target.value })} />
          <button style={btnP} disabled={busy} onClick={create}>Create</button>
        </div>
      )}
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Kind" sortKey="kind" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Location" sortKey="location" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Contact" sortKey="contact" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Contacts" sortKey="contacts" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Billing" sortKey="billing" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Active" sortKey="active" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
        </tr></thead>
        <tbody>
          {providers.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={8}>No 3PL providers yet.</td></tr>}
          {sorted.map((p) => (
            <tr key={p.id} style={{ opacity: p.is_active ? 1 : 0.5, cursor: "pointer" }} onClick={() => setEditing(p)} title="Open to edit contacts, notes & history">
              <td style={{ ...td, fontFamily: "monospace" }}>{p.code || "—"}</td>
              <td style={td}>{p.name}</td>
              <td style={td}><span style={chip(C.violet)}>{p.kind}</span></td>
              <td style={td}>{p.inventory_locations?.name || "—"}</td>
              <td style={td}>{p.contact_name || "—"}{p.email ? ` · ${p.email}` : ""}</td>
              <td style={td}>{Array.isArray(p.contacts) && p.contacts.length ? `${p.contacts.length}` : "—"}</td>
              <td style={{ ...td, color: C.textMuted, fontSize: 12 }}>{p.billing_notes || "—"}</td>
              <td style={td}><button style={{ ...btnS, padding: "3px 8px" }} disabled={busy} onClick={(e) => { e.stopPropagation(); void toggleActive(p); }}>{p.is_active ? "yes" : "no"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {editing && (
        <ProviderEditModal
          provider={editing}
          busy={busy}
          setBusy={setBusy}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </div>
  );
}

// Provider edit modal (operator items 1 & 2): up-to-8 contacts (name/title/
// department/email/phone), an editable notes field, and the T11 audit trail —
// the same notes + audit wiring as Customer Master.
function ProviderEditModal({ provider, busy, setBusy, onClose, onSaved }: { provider: Provider; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(provider.name || "");
  const [contacts, setContacts] = useState<Contact[]>(Array.isArray(provider.contacts) ? provider.contacts : []);
  const [notes, setNotes] = useState(provider.notes || "");
  const [billingNotes, setBillingNotes] = useState(provider.billing_notes || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { notify("Name required", "error"); return; }
    setSaving(true); setBusy(true);
    try {
      const r = await fetch("/api/internal/tpl-providers", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: provider.id, name: name.trim(), contacts, notes: notes.trim() || null, billing_notes: billingNotes.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "save failed");
      notify("Provider saved", "success");
      onSaved();
    } catch (e) { notify("Save failed — " + (e instanceof Error ? e.message : String(e)), "error"); }
    finally { setSaving(false); setBusy(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 22, width: "min(680px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>{provider.code ? `${provider.code} — ` : ""}{provider.name}</h2>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>Edit provider contacts, notes & review the change history.</div>

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Name</label>
        <input style={{ ...input, width: "100%", marginBottom: 14 }} value={name} onChange={(e) => setName(e.target.value)} />

        {/* Item 1 — up to 8 contacts, each with title + department. */}
        <ContactList label="Contacts" value={contacts} onChange={setContacts} max={8} fields={["name", "title", "department", "email", "phone"]} />

        <label style={{ display: "block", margin: "14px 0 6px", fontSize: 12, color: C.textMuted }}>Notes</label>
        <textarea style={{ ...input, width: "100%", minHeight: 60, resize: "vertical", marginBottom: 12 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="General notes about this provider" />

        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: C.textMuted }}>Billing / fee notes</label>
        <textarea style={{ ...input, width: "100%", minHeight: 44, resize: "vertical", marginBottom: 12 }} value={billingNotes} onChange={(e) => setBillingNotes(e.target.value)} />

        {/* Item 2 — same audit-trail wiring as Customer Master. */}
        <RowHistory source_table="tpl_providers" source_id={provider.id} />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" style={btnS} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" style={btnP} onClick={() => void save()} disabled={saving || busy}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function Shipments({ shipments, providers, provName, itemMap, busy, setBusy, reload }: { shipments: Shipment[]; providers: Provider[]; provName: Map<string, string>; itemMap: Map<string, ResolvedItem>; busy: boolean; setBusy: (b: boolean) => void; reload: () => Promise<void> }) {
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
  const flatRows = shipments.map((s) => ({ num: s.shipment_number || "(draft)", provider: s.tpl_providers?.name || provName.get(s.tpl_provider_id) || "", direction: s.direction, status: s.status, units: units(s) }));
  const rows = flatRows.length === 0 ? flatRows : [
    ...flatRows,
    { num: "TOTAL", provider: "", direction: "", status: "", units: flatRows.reduce((n, r) => n + (Number(r.units) || 0), 0) },
  ];

  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(shipments, {
    persistKey: "tangerine:tpl-shipments:sort",
    accessors: {
      num: (s) => s.shipment_number || "",
      provider: (s) => s.tpl_providers?.name || provName.get(s.tpl_provider_id) || "",
      units: (s) => units(s),
    },
  });

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
            <SearchableSelect
              value={dir}
              onChange={(v) => setDir(v)}
              inputStyle={input}
              options={[
                { value: "inbound", label: "Inbound (to 3PL)" },
                { value: "outbound", label: "Outbound (from 3PL)" },
                { value: "return", label: "Return (back to us)" },
              ]}
            />
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
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <SortableTh label="Shipment #" sortKey="num" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Provider" sortKey="provider" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Direction" sortKey="direction" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} />
          <SortableTh label="Units" sortKey="units" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...th, textAlign: "right" }} />
          <th style={th}>Tracking</th><th style={th}>Actions</th>
        </tr></thead>
        <tbody>
          {shipments.length === 0 && <tr><td style={{ ...td, textAlign: "center", color: C.textMuted, padding: 30 }} colSpan={7}>No shipments yet.</td></tr>}
          {sorted.map((s) => (
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
                        <tr key={l.id}><td style={td}>{l.line_number}</td><td style={{ ...td, color: l.inventory_item_id ? C.text : C.textMuted }}>{(l.inventory_item_id && itemMap.get(l.inventory_item_id)?.sku_code) || "—"}</td><td style={td}>{l.description || "—"}</td><td style={{ ...td, textAlign: "right" }}>{Number(l.qty)}</td></tr>
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
