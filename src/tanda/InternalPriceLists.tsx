// src/tanda/InternalPriceLists.tsx
//
// M43 — Price Lists admin. Master/detail: a list of price lists (scope =
// default / tier / customer), each opening a detail modal that manages its
// per-style prices + quantity breaks (price_list_items). Supersedes the interim
// B2B Price List panel; the B2B portal + internal SO/AR auto-fill resolve through
// the same engine (api/_lib/pricing/engine.js).

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type EmbeddedCustomer = { id: string; name: string; customer_code: string | null } | null;
type EmbeddedStyle = { id: string; style_code: string | null; style_name: string | null } | null;
type PriceList = { id: string; code: string; name: string; currency: string; customer_id: string | null; customer_tier: string | null; is_default: boolean; is_active: boolean; customer: EmbeddedCustomer; item_count?: number };
type Item = { id: string; price_list_id: string; style_id: string; price_cents: number | string; min_qty: number | string; effective_from: string | null; effective_to: string | null; is_active: boolean; style: EmbeddedStyle };
type Customer = { id: string; name: string; customer_code?: string | null };
type Style = { id: string; style_code: string | null; style_name?: string | null };

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  return `$${Math.trunc(n / 100).toLocaleString()}.${String(Math.round(n % 100)).padStart(2, "0")}`;
}
function scopeLabel(l: PriceList): string {
  if (l.customer_id) return `Customer: ${l.customer?.name || l.customer_id.slice(0, 8)}`;
  if (l.customer_tier) return `Tier: ${l.customer_tier}`;
  if (l.is_default) return "Default (fallback)";
  return "—";
}
const styleLabel = (s: EmbeddedStyle | Style | null) => !s ? "—" : (s.style_name ? `${s.style_code || s.id.slice(0, 8)} — ${s.style_name}` : (s.style_code || s.id.slice(0, 8)));

export default function InternalPriceLists() {
  const [rows, setRows] = useState<PriceList[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState<PriceList | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (includeInactive) p.set("include_inactive", "true");
      const r = await fetch(`/api/internal/price-lists?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as PriceList[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [includeInactive]);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=500").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setCustomers(a); }).catch(() => {});
    fetch("/api/internal/style-master?limit=500").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setStyles(a); }).catch(() => {});
  }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>🏷️ Price Lists</h2>
        <button style={btnPrimary} onClick={() => setNewOpen(true)}>+ New price list</button>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} placeholder="Search code / name…" style={{ ...inputStyle, width: 220 }} />
        <button style={btnSecondary} onClick={() => void load()}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive
        </label>
        <div style={{ flex: 1 }} />
        <ExportButton rows={rows.map((l) => ({ code: l.code, name: l.name, scope: scopeLabel(l), currency: l.currency, items: l.item_count || 0, active: l.is_active ? "yes" : "no" })) as unknown as Array<Record<string, unknown>>}
          filename="price-lists" sheetName="Price Lists"
          columns={[{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "scope", header: "Scope" }, { key: "currency", header: "Currency" }, { key: "items", header: "Items" }, { key: "active", header: "Active" }] as ExportColumn<Record<string, unknown>>[]} />
      </div>
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Code</th><th style={th}>Name</th><th style={th}>Scope</th><th style={th}>Currency</th><th style={{ ...th, textAlign: "right" }}>Items</th><th style={th}>Active</th></tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={6}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={6}>No price lists.</td></tr>}
            {rows.map((l) => (
              <tr key={l.id} style={{ cursor: "pointer" }} onClick={() => setDetail(l)}>
                <td style={{ ...td, fontFamily: "monospace" }}>{l.code}</td>
                <td style={td}>{l.name}</td>
                <td style={td}>{l.is_default && <span style={{ fontSize: 11, color: C.success, border: `1px solid ${C.success}`, borderRadius: 4, padding: "1px 6px", marginRight: 6 }}>default</span>}{scopeLabel(l)}</td>
                <td style={td}>{l.currency}</td>
                <td style={{ ...td, textAlign: "right" }}>{l.item_count ?? 0}</td>
                <td style={td}>{l.is_active ? "yes" : <span style={{ color: C.textMuted }}>no</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {newOpen && <ListModal list={null} customers={customers} onClose={() => setNewOpen(false)} onSaved={() => { setNewOpen(false); void load(); }} />}
      {detail && <ListModal list={detail} customers={customers} styles={styles} onClose={() => setDetail(null)} onSaved={() => { setDetail(null); void load(); }} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>{children}</div>;
}

function ListModal({ list, customers, styles, onClose, onSaved }: { list: PriceList | null; customers: Customer[]; styles?: Style[]; onClose: () => void; onSaved: () => void }) {
  const isNew = list === null;
  const [code, setCode] = useState(list?.code || "");
  const [name, setName] = useState(list?.name || "");
  const [currency, setCurrency] = useState(list?.currency || "USD");
  const [scope, setScope] = useState<"default" | "tier" | "customer">(list?.customer_id ? "customer" : list?.customer_tier ? "tier" : list?.is_default ? "default" : "default");
  const [tier, setTier] = useState(list?.customer_tier || "");
  const [customerId, setCustomerId] = useState(list?.customer_id || "");
  const [isActive, setIsActive] = useState(list?.is_active ?? true);
  const [items, setItems] = useState<Item[]>([]);
  const [itemModal, setItemModal] = useState<Item | "new" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadItems() {
    if (isNew || !list) return;
    const r = await fetch(`/api/internal/price-lists/${list.id}`);
    if (r.ok) { const j = await r.json(); setItems(Array.isArray(j.items) ? j.items : []); }
  }
  useEffect(() => { void loadItems(); /* eslint-disable-next-line */ }, [list?.id]);

  async function saveList() {
    setErr(null);
    if (!code.trim() || !name.trim()) { setErr("Code and name are required."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        code: code.trim(), name: name.trim(), currency: currency.trim().toUpperCase(), is_active: isActive,
        is_default: scope === "default",
        customer_id: scope === "customer" ? (customerId || null) : null,
        customer_tier: scope === "tier" ? (tier.trim() || null) : null,
      };
      const r = await fetch(isNew ? "/api/internal/price-lists" : `/api/internal/price-lists/${list!.id}`,
        { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(isNew ? "Price list created." : "Price list saved.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }
  async function deleteList() {
    if (!list) return;
    if (!(await confirmDialog(`Delete price list "${list.code}" and all its prices?`, { confirmText: "Delete", danger: true, icon: "🗑️" }))) return;
    const r = await fetch(`/api/internal/price-lists/${list.id}`, { method: "DELETE" });
    if (!r.ok) { notify((await r.json().catch(() => ({}))).error || "Delete failed", "error"); return; }
    notify("Price list deleted.", "success"); onSaved();
  }
  async function deleteItem(it: Item) {
    if (!(await confirmDialog(`Remove price for ${styleLabel(it.style)} (min qty ${Number(it.min_qty)})?`, { confirmText: "Remove", danger: true }))) return;
    const r = await fetch(`/api/internal/price-list-items/${it.id}`, { method: "DELETE" });
    if (!r.ok) { notify((await r.json().catch(() => ({}))).error || "Delete failed", "error"); return; }
    void loadItems();
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 720, maxWidth: 920, maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New price list" : `Price list ${list?.code}`}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="DISTRIBUTOR" /></Field>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="Distributor Wholesale" /></Field>
          <Field label="Currency"><input value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle} maxLength={3} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
          <Field label="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value as "default" | "tier" | "customer")} style={inputStyle}>
              <option value="default">Default (fallback)</option>
              <option value="tier">Customer tier</option>
              <option value="customer">Specific customer</option>
            </select>
          </Field>
          {scope === "tier" && <Field label="Customer tier"><input value={tier} onChange={(e) => setTier(e.target.value)} style={inputStyle} placeholder="distributor" /></Field>}
          {scope === "customer" && <Field label="Customer"><SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v)} options={[{ value: "", label: "(pick customer)" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]} placeholder="(pick customer)" /></Field>}
          {scope === "default" && <div style={{ alignSelf: "end", fontSize: 11, color: C.textMuted }}>Applied when a customer has no own / assigned / tier list pricing the style.</div>}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, marginBottom: 12 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        {/* Items (prices + qty breaks) — only after the list exists. */}
        {!isNew && (
          <div style={{ marginTop: 4, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Prices &amp; quantity breaks</div>
              <button style={{ ...btnSecondary, padding: "4px 10px", fontSize: 12 }} onClick={() => setItemModal("new")}>+ Add price</button>
            </div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr><th style={th}>Style</th><th style={{ ...th, textAlign: "right" }}>Min qty</th><th style={{ ...th, textAlign: "right" }}>Price</th><th style={th}>Effective</th><th style={th}></th></tr></thead>
                <tbody>
                  {items.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={5}>No prices yet.</td></tr>}
                  {items.map((it) => (
                    <tr key={it.id} style={{ cursor: "pointer" }} onClick={() => setItemModal(it)}>
                      <td style={td}>{styleLabel(it.style)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{Number(it.min_qty)}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(it.price_cents)}{!it.is_active && <span style={{ color: C.textMuted, fontSize: 11 }}> (inactive)</span>}</td>
                      <td style={{ ...td, fontSize: 12, color: C.textMuted }}>{it.effective_from || "—"}{it.effective_to ? ` → ${it.effective_to}` : ""}</td>
                      <td style={td}><button onClick={(e) => { e.stopPropagation(); void deleteItem(it); }} style={btnDanger}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <div>{!isNew && <button onClick={() => void deleteList()} style={btnDanger} disabled={submitting}>Delete list</button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            <button onClick={() => void saveList()} style={btnPrimary} disabled={submitting}>{submitting ? "…" : isNew ? "Create" : "Save"}</button>
          </div>
        </div>

        {itemModal && list && <ItemModal listId={list.id} item={itemModal === "new" ? null : itemModal} styles={styles || []} onClose={() => setItemModal(null)} onSaved={() => { setItemModal(null); void loadItems(); }} />}
      </div>
    </div>
  );
}

function ItemModal({ listId, item, styles, onClose, onSaved }: { listId: string; item: Item | null; styles: Style[]; onClose: () => void; onSaved: () => void }) {
  const isNew = item === null;
  const [styleId, setStyleId] = useState(item?.style_id || "");
  const [priceDollars, setPriceDollars] = useState(item ? (Number(item.price_cents) / 100).toFixed(2) : "");
  const [minQty, setMinQty] = useState(item ? String(Number(item.min_qty)) : "0");
  const [from, setFrom] = useState(item?.effective_from || "");
  const [to, setTo] = useState(item?.effective_to || "");
  const [isActive, setIsActive] = useState(item?.is_active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (isNew && !styleId) { setErr("Pick a style."); return; }
    const cents = Math.round((Number(priceDollars) || 0) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setErr("Price must be ≥ 0."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { price_cents: cents, min_qty: Number(minQty) || 0, effective_from: from || null, effective_to: to || null, is_active: isActive };
      if (isNew) { body.price_list_id = listId; body.style_id = styleId; }
      const r = await fetch(isNew ? "/api/internal/price-list-items" : `/api/internal/price-list-items/${item!.id}`,
        { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Price saved.", "success"); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 460, color: C.text }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 16 }}>{isNew ? "Add price / quantity break" : "Edit price"}</h3>
        <div style={{ marginBottom: 12 }}>
          <Field label="Style">
            <SearchableSelect value={styleId || null} onChange={(v) => setStyleId(v)} disabled={!isNew}
              options={[{ value: "", label: "(pick style)" }, ...styles.map((s) => ({ value: s.id, label: styleLabel(s), searchHaystack: `${s.style_code || ""} ${s.style_name || ""}` }))]} placeholder="(pick style)" />
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Price ($)"><input type="text" inputMode="decimal" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} style={inputStyle} placeholder="24.00" /></Field>
          <Field label="Min qty (break)"><input type="text" inputMode="decimal" value={minQty} onChange={(e) => setMinQty(e.target.value)} style={inputStyle} placeholder="0" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Effective from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} /></Field>
          <Field label="Effective to"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} /></Field>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub, marginBottom: 12 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void save()} style={btnPrimary} disabled={submitting}>{submitting ? "…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
