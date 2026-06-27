// src/tanda/InternalPromotions.tsx
//
// M43 — Promotions admin. Time-boxed percent/amount discounts layered on the
// resolved list price by the engine. Optional match filters (style / brand /
// customer / tier; NULL = any) + optional code. The engine applies the single
// best (largest-discount) active, in-effect, matching promo (no stacking v1).

import { useEffect, useState } from "react";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };

type Embedded = { id: string; name?: string; style_code?: string | null; style_name?: string | null } | null;
type Promo = {
  id: string; code: string | null; name: string; discount_type: "percent" | "amount"; discount_value: number | string;
  style_id: string | null; brand_id: string | null; customer_id: string | null; customer_tier: string | null;
  min_qty: number | string; effective_from: string | null; effective_to: string | null; priority: number; is_active: boolean;
  style: Embedded; customer: Embedded;
};
type Customer = { id: string; name: string; customer_code?: string | null };
type Style = { id: string; style_code: string | null; style_name?: string | null };
type Brand = { id: string; name: string; code?: string };

const styleLabel = (s: Style | null) => !s ? "" : (s.style_name ? `${s.style_code || "—"} — ${s.style_name}` : (s.style_code || "—"));
function discountLabel(p: Promo) { return p.discount_type === "percent" ? `${Number(p.discount_value)}% off` : `$${(Number(p.discount_value) / 100).toFixed(2)} off`; }
function scopeBits(p: Promo): string {
  const b: string[] = [];
  if (p.style_id) b.push(`style ${p.style?.style_code || "—"}`);
  if (p.brand_id) b.push("brand");
  if (p.customer_id) b.push(`cust ${p.customer?.name || ""}`.trim());
  if (p.customer_tier) b.push(`tier ${p.customer_tier}`);
  return b.length ? b.join(", ") : "all";
}

export default function InternalPromotions() {
  const [rows, setRows] = useState<Promo[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<Promo | "new" | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (qDebounced.trim()) p.set("q", qDebounced.trim());
      if (includeInactive) p.set("include_inactive", "true");
      const r = await fetch(`/api/internal/price-promotions?${p.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Promo[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [qDebounced, includeInactive]);
  useEffect(() => {
    fetch("/api/internal/customer-master?limit=5000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setCustomers(a); }).catch(() => {});
    fetch("/api/internal/style-master?limit=10000").then((r) => r.json()).then((a) => { if (Array.isArray(a)) setStyles(a); }).catch(() => {});
    fetch("/api/internal/brands").then((r) => r.json()).then((d) => setBrands(Array.isArray(d.brands) ? d.brands : [])).catch(() => {});
  }, []);

  async function del(p: Promo) {
    if (!(await confirmDialog(`Delete promotion "${p.name}"?`, { confirmText: "Delete", danger: true }))) return;
    const r = await fetch(`/api/internal/price-promotions/${p.id}`, { method: "DELETE" });
    if (!r.ok) { notify((await r.json().catch(() => ({}))).error || "Delete failed", "error"); return; }
    notify("Promotion deleted.", "success"); void load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Promotions</h2>
        <button style={btnPrimary} onClick={() => setEditing("new")}>+ New promotion</button>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / code…" style={{ ...inputStyle, width: 220 }} />
        <button style={btnSecondary} onClick={() => void load()}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Include inactive
        </label>
        <div style={{ flex: 1 }} />
        <ExportButton rows={rows.map((p) => ({ name: p.name, code: p.code || "", discount: discountLabel(p), scope: scopeBits(p), from: p.effective_from || "", to: p.effective_to || "", active: p.is_active ? "yes" : "no" })) as unknown as Array<Record<string, unknown>>}
          filename="promotions" sheetName="Promotions"
          columns={[{ key: "name", header: "Name" }, { key: "code", header: "Code" }, { key: "discount", header: "Discount" }, { key: "scope", header: "Applies to" }, { key: "from", header: "From", format: "date" }, { key: "to", header: "To", format: "date" }, { key: "active", header: "Active" }] as ExportColumn<Record<string, unknown>>[]} />
      </div>
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}
      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Name</th><th style={th}>Code</th><th style={th}>Discount</th><th style={th}>Applies to</th><th style={th}>Window</th><th style={th}>Active</th><th style={th}></th></tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={7}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={7}>No promotions.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setEditing(p)}>
                <td style={td}>{p.name}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{p.code || <span style={{ color: C.textMuted }}>auto</span>}</td>
                <td style={td}>{discountLabel(p)}</td>
                <td style={{ ...td, fontSize: 12, color: C.textSub }}>{scopeBits(p)}</td>
                <td style={{ ...td, fontSize: 12, color: C.textMuted }}>{p.effective_from || "—"}{p.effective_to ? ` → ${p.effective_to}` : ""}</td>
                <td style={td}>{p.is_active ? "yes" : <span style={{ color: C.textMuted }}>no</span>}</td>
                <td style={td}><button onClick={(e) => { e.stopPropagation(); void del(p); }} style={{ ...btnDanger, padding: "2px 8px" }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <PromoModal promo={editing === "new" ? null : editing} customers={customers} styles={styles} brands={brands} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>{children}</div>;
}

function PromoModal({ promo, customers, styles, brands, onClose, onSaved }: { promo: Promo | null; customers: Customer[]; styles: Style[]; brands: Brand[]; onClose: () => void; onSaved: () => void }) {
  const isNew = promo === null;
  const [name, setName] = useState(promo?.name || "");
  const [code, setCode] = useState(promo?.code || "");
  const [type, setType] = useState<"percent" | "amount">(promo?.discount_type || "percent");
  const [value, setValue] = useState(promo ? (promo.discount_type === "amount" ? (Number(promo.discount_value) / 100).toFixed(2) : String(Number(promo.discount_value))) : "");
  const [styleId, setStyleId] = useState(promo?.style_id || "");
  const [brandId, setBrandId] = useState(promo?.brand_id || "");
  const [customerId, setCustomerId] = useState(promo?.customer_id || "");
  const [tier, setTier] = useState(promo?.customer_tier || "");
  const [minQty, setMinQty] = useState(promo ? String(Number(promo.min_qty)) : "0");
  const [from, setFrom] = useState(promo?.effective_from || "");
  const [to, setTo] = useState(promo?.effective_to || "");
  const [isActive, setIsActive] = useState(promo?.is_active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!name.trim()) { setErr("Name is required."); return; }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) { setErr("Discount value must be ≥ 0."); return; }
    if (type === "percent" && num > 100) { setErr("Percent cannot exceed 100."); return; }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(), code: code.trim() || null, discount_type: type,
        discount_value: type === "amount" ? Math.round(num * 100) : num,
        style_id: styleId || null, brand_id: brandId || null, customer_id: customerId || null,
        customer_tier: tier.trim() || null, min_qty: Number(minQty) || 0,
        effective_from: from || null, effective_to: to || null, is_active: isActive,
      };
      const r = await fetch(isNew ? "/api/internal/price-promotions" : `/api/internal/price-promotions/${promo!.id}`,
        { method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify(isNew ? "Promotion created." : "Promotion saved.", "success"); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(820px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New promotion" : `Promotion — ${promo?.name}`}</h3>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="Spring Sale" /></Field>
          <Field label="Code (optional)"><input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="(auto if blank)" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Type"><SearchableSelect value={type} onChange={(v) => setType(v as "percent" | "amount")} inputStyle={inputStyle} options={[{ value: "percent", label: "Percent %" }, { value: "amount", label: "Amount $" }]} /></Field>
          <Field label={type === "percent" ? "Percent (0–100)" : "Amount ($ off)"}><input type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={inputStyle} placeholder={type === "percent" ? "10" : "5.00"} /></Field>
          <Field label="Min qty"><input type="text" inputMode="decimal" value={minQty} onChange={(e) => setMinQty(e.target.value)} style={inputStyle} placeholder="0" /></Field>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 6px" }}>Applies to (leave blank = any)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Style"><SearchableSelect value={styleId || null} onChange={(v) => setStyleId(v)} options={[{ value: "", label: "(any style)" }, ...styles.map((s) => ({ value: s.id, label: styleLabel(s), searchHaystack: `${s.style_code || ""} ${s.style_name || ""}` }))]} placeholder="(any style)" /></Field>
          <Field label="Brand"><SearchableSelect value={brandId || null} onChange={(v) => setBrandId(v)} options={[{ value: "", label: "(any brand)" }, ...brands.map((b) => ({ value: b.id, label: b.code ? `${b.code} — ${b.name}` : b.name }))]} placeholder="(any brand)" /></Field>
          <Field label="Customer"><SearchableSelect value={customerId || null} onChange={(v) => setCustomerId(v)} options={[{ value: "", label: "(any customer)" }, ...customers.map((c) => ({ value: c.id, label: c.name, searchHaystack: `${c.name} ${c.customer_code || ""}` }))]} placeholder="(any customer)" /></Field>
          <Field label="Customer tier"><input value={tier} onChange={(e) => setTier(e.target.value)} style={inputStyle} placeholder="(any tier)" /></Field>
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
          <button onClick={() => void save()} style={btnPrimary} disabled={submitting}>{submitting ? "…" : isNew ? "Create" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
