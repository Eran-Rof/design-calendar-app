// src/tanda/InternalPartInventory.tsx
//
// Tangerine — Manufacturing Part Inventory.
// On-hand by part (from part_inventory_layers) + an Adjust action that posts a
// part_adjustment (opening balance / found / correction / damage / shrinkage /
// write-off) through the part FIFO engine and GL. Parts are kept separate from
// style inventory — this view never shows style SKUs.

import { Fragment, useEffect, useMemo, useState } from "react";
import { notify } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";

type PartLite = { id: string; code: string; name: string };
type Account = { id: string; code: string; name: string; is_postable: boolean };
type OnHandChild = { part_id: string; code: string | null; size: string | null; on_hand_qty: number; avg_unit_cost_cents: number; value_cents: number };
type OnHandRow = {
  part_id: string;
  code: string | null;
  name: string;
  part_type: string | null;
  uom: string | null;
  on_hand_qty: number;
  value_cents: number;
  avg_unit_cost_cents: number;
  layer_count: number;
  is_matrix?: boolean;
  children?: OnHandChild[];
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box" };
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InternalPartInventory() {
  const [rows, setRows] = useState<OnHandRow[]>([]);
  const [parts, setParts] = useState<PartLite[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // matrix parents whose sizes are shown
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustPart, setAdjustPart] = useState<string>("");
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchasePart, setPurchasePart] = useState<string>("");

  const totalValue = useMemo(() => rows.reduce((s, r) => s + r.value_cents, 0), [rows]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (includeZero) params.set("include_zero", "true");
      const r = await fetch(`/api/internal/part-inventory?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as OnHandRow[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  async function loadParts() {
    try {
      const r = await fetch(`/api/internal/part-master?include_inactive=false`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setParts(d as PartLite[]); }
    } catch { /* non-fatal */ }
  }
  async function loadAccounts() {
    try {
      const r = await fetch(`/api/internal/gl-accounts?limit=1000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setAccounts(d as Account[]); }
    } catch { /* non-fatal */ }
  }
  async function loadVendors() {
    try {
      const r = await fetch(`/api/internal/vendor-master?limit=5000`);
      if (r.ok) { const d = await r.json(); if (Array.isArray(d)) setVendors(d as { id: string; name: string }[]); }
    } catch { /* non-fatal */ }
  }

  useEffect(() => { void load(); }, [includeZero]);
  useEffect(() => { void loadParts(); void loadAccounts(); void loadVendors(); }, []);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Part Inventory</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textMuted }}>
            On-hand parts in their own FIFO pool — separate from finished-style inventory. Adjust posts to GL (1360 Inventory-Parts).
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setPurchasePart(""); setPurchaseOpen(true); }} style={btnPrimary}>+ Receive purchase</button>
          <button onClick={() => { setAdjustPart(""); setAdjustOpen(true); }} style={btnSecondary}>+ Adjust / opening balance</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input type="text" placeholder="Search part code or name…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load()} style={{ ...inputStyle, maxWidth: 280 }} />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
          Show zero on-hand
        </label>
        <div style={{ marginLeft: "auto", fontSize: 13, color: C.textSub }}>
          Total parts value: <strong style={{ color: C.text }}>{fmtMoney(totalValue)}</strong>
        </div>
        <ExportButton
          rows={rows.map((r) => ({ ...r })) as unknown as Array<Record<string, unknown>>}
          filename="part-inventory"
          sheetName="Part Inventory"
          columns={[
            { key: "code", header: "Code" },
            { key: "name", header: "Name" },
            { key: "part_type", header: "Type" },
            { key: "uom", header: "UOM" },
            { key: "on_hand_qty", header: "On Hand", format: "number" },
            { key: "avg_unit_cost_cents", header: "Avg Unit Cost", format: "currency_cents" },
            { key: "value_cents", header: "Value", format: "currency_cents" },
            { key: "layer_count", header: "Layers", format: "number" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No parts on hand. Use &quot;+ Adjust / opening balance&quot; to seed stock, or tick &quot;Show zero on-hand&quot;.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={{ ...th, textAlign: "right" }}>On Hand</th>
                <th style={{ ...th, textAlign: "right" }}>Avg Cost</th>
                <th style={{ ...th, textAlign: "right" }}>Value</th>
                <th style={{ ...th, textAlign: "right" }}>Layers</th>
                <th style={{ ...th, width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isMatrix = !!r.is_matrix;
                const open = expanded.has(r.part_id);
                return (
                <Fragment key={r.part_id}>
                <tr style={r.on_hand_qty === 0 ? { opacity: 0.55 } : undefined}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>
                    {isMatrix && (
                      <button onClick={() => setExpanded((s) => { const n = new Set(s); n.has(r.part_id) ? n.delete(r.part_id) : n.add(r.part_id); return n; })}
                        title="Show sizes" style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 11, marginRight: 4 }}>{open ? "▾" : "▸"}</button>
                    )}
                    {r.code ?? "—"}
                  </td>
                  <td style={td}>{r.name}{isMatrix && <span style={{ color: C.textMuted, fontSize: 11 }}> · by size ({(r.children || []).length})</span>}</td>
                  <td style={{ ...td, color: C.textSub }}>{r.part_type ?? "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{r.on_hand_qty.toLocaleString()} {r.uom ?? ""}</td>
                  <td style={{ ...td, textAlign: "right", color: C.textSub }}>{fmtMoney(r.avg_unit_cost_cents)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{fmtMoney(r.value_cents)}</td>
                  <td style={{ ...td, textAlign: "right", color: C.textSub }}>{r.layer_count}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {/* Matrix parents hold no stock of their own — buy/adjust happen per size (via the size rows or a part PO). */}
                    {!isMatrix && <>
                      <button onClick={() => { setPurchasePart(r.part_id); setPurchaseOpen(true); }} style={btnSecondary}>Buy</button>
                      <button onClick={() => { setAdjustPart(r.part_id); setAdjustOpen(true); }} style={{ ...btnSecondary, marginLeft: 6 }}>Adjust</button>
                    </>}
                  </td>
                </tr>
                {isMatrix && open && (r.children || []).map((c) => (
                  <tr key={c.part_id} style={{ background: "#0b1220" }}>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", paddingLeft: 28, color: C.textSub }}>{c.code ?? "—"}</td>
                    <td style={{ ...td, color: C.textSub }}>size {c.size ?? "—"}</td>
                    <td style={td} />
                    <td style={{ ...td, textAlign: "right" }}>{c.on_hand_qty.toLocaleString()} {r.uom ?? ""}</td>
                    <td style={{ ...td, textAlign: "right", color: C.textSub }}>{fmtMoney(c.avg_unit_cost_cents)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmtMoney(c.value_cents)}</td>
                    <td style={td} />
                    <td style={{ ...td, textAlign: "right" }}>
                      <button onClick={() => { setPurchasePart(c.part_id); setPurchaseOpen(true); }} style={btnSecondary}>Buy</button>
                      <button onClick={() => { setAdjustPart(c.part_id); setAdjustOpen(true); }} style={{ ...btnSecondary, marginLeft: 6 }}>Adjust</button>
                    </td>
                  </tr>
                ))}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {adjustOpen && (
        <AdjustModal
          parts={parts}
          accounts={accounts}
          presetPartId={adjustPart}
          onClose={() => setAdjustOpen(false)}
          onSaved={() => { setAdjustOpen(false); void load(); }}
        />
      )}
      {purchaseOpen && (
        <PurchaseModal
          parts={parts}
          vendors={vendors}
          presetPartId={purchasePart}
          onClose={() => setPurchaseOpen(false)}
          onSaved={() => { setPurchaseOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

function PurchaseModal({ parts, vendors, presetPartId, onClose, onSaved }: {
  parts: PartLite[]; vendors: { id: string; name: string }[]; presetPartId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [partId, setPartId] = useState(presetPartId || "");
  const [vendorId, setVendorId] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const partOptions: SearchableSelectOption[] = useMemo(() => parts.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })), [parts]);
  const vendorOptions: SearchableSelectOption[] = useMemo(() => vendors.map((v) => ({ value: v.id, label: v.name })), [vendors]);

  async function submit() {
    setSubmitting(true); setErr(null);
    try {
      const qtyNum = parseFloat(qty); const costNum = parseFloat(unitCost);
      if (!partId) throw new Error("Pick a part");
      if (!vendorId) throw new Error("Pick a vendor");
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) throw new Error("Enter a quantity");
      if (!Number.isFinite(costNum) || costNum < 0) throw new Error("Enter a unit cost");
      const r = await fetch(`/api/internal/part-purchases`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ part_id: partId, vendor_id: vendorId, qty: qtyNum, unit_cost_cents: Math.round(costNum * 100), invoice_number: invoiceNumber.trim() || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Part purchase posted — stock received.", "success");
      onSaved();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 18 }}>Receive part purchase</h3>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: C.textMuted }}>Creates a vendor bill and stocks the part — posts DR 1360 Inventory-Parts / CR Accounts Payable.</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Part *</Label>
            <SearchableSelect value={partId} onChange={setPartId} options={partOptions} placeholder="Pick a part…" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Vendor *</Label>
            <SearchableSelect value={vendorId} onChange={setVendorId} options={vendorOptions} placeholder="Pick a vendor…" />
          </div>
          <div><Label>Quantity *</Label><input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} style={inputStyle} placeholder="0" autoFocus /></div>
          <div><Label>Unit cost ($) *</Label><input type="number" min="0" step="0.0001" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} style={inputStyle} placeholder="0.00" /></div>
          <div style={{ gridColumn: "1 / -1" }}><Label>Bill / invoice # (optional)</Label><input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} style={inputStyle} placeholder="auto-generated if blank" /></div>
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !partId || !vendorId}>{submitting ? "Posting…" : "Receive & post"}</button>
        </div>
      </div>
    </div>
  );
}

const TYPE_BY_DIR: Record<"increase" | "decrease", { value: string; label: string }[]> = {
  increase: [
    { value: "opening_balance", label: "Opening balance" },
    { value: "found", label: "Found" },
    { value: "correction", label: "Correction up" },
  ],
  decrease: [
    { value: "damage", label: "Damage" },
    { value: "shrinkage", label: "Shrinkage" },
    { value: "write_off", label: "Write-off" },
    { value: "correction", label: "Correction down" },
  ],
};

function AdjustModal({ parts, accounts, presetPartId, onClose, onSaved }: {
  parts: PartLite[]; accounts: Account[]; presetPartId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [partId, setPartId] = useState(presetPartId || "");
  const [direction, setDirection] = useState<"increase" | "decrease">("increase");
  const [adjType, setAdjType] = useState("opening_balance");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [glAccountId, setGlAccountId] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const partOptions: SearchableSelectOption[] = useMemo(
    () => parts.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
    [parts],
  );
  const acctOptions: SearchableSelectOption[] = useMemo(
    () => accounts.filter((a) => a.is_postable).map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
    [accounts],
  );
  const typeOptions = TYPE_BY_DIR[direction];

  function onDir(d: "increase" | "decrease") {
    setDirection(d);
    setAdjType(TYPE_BY_DIR[d][0].value);
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const qtyNum = parseFloat(qty);
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) throw new Error("Enter a positive quantity");
      const qtyDelta = direction === "increase" ? qtyNum : -qtyNum;
      const body: Record<string, unknown> = {
        part_id: partId,
        adjustment_type: adjType,
        qty_delta: qtyDelta,
        reason: reason.trim(),
        gl_account_id: glAccountId,
      };
      if (direction === "increase") {
        const c = parseFloat(unitCost);
        if (!Number.isFinite(c) || c < 0) throw new Error("Enter a unit cost for an increase");
        body.unit_cost_cents = Math.round(c * 100);
      }
      const r = await fetch(`/api/internal/part-adjustments`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Part adjustment posted.", "success");
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>Adjust part inventory</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Part *</Label>
            <SearchableSelect value={partId} onChange={setPartId} options={partOptions} placeholder="Pick a part…" />
          </div>
          <div>
            <Label>Direction</Label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["increase", "decrease"] as const).map((d) => (
                <button key={d} onClick={() => onDir(d)} style={{ ...btnSecondary, flex: 1, background: direction === d ? C.primary : C.card, color: direction === d ? "white" : C.textSub }}>
                  {d === "increase" ? "Increase" : "Decrease"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Type</Label>
            <SearchableSelect value={adjType} onChange={setAdjType} options={typeOptions} placeholder="Pick a type…" />
          </div>
          <div>
            <Label>Quantity *</Label>
            <input type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)} style={inputStyle} placeholder="0" autoFocus />
          </div>
          {direction === "increase" && (
            <div>
              <Label>Unit cost ($) *</Label>
              <input type="number" min="0" step="0.0001" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} style={inputStyle} placeholder="0.00" />
            </div>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>{direction === "increase" ? "Counter account (credit) *" : "Expense account (debit) *"}</Label>
            <SearchableSelect value={glAccountId} onChange={setGlAccountId} options={acctOptions} placeholder="Pick a GL account…" />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
              {direction === "increase"
                ? "Increases debit 1360 Inventory-Parts and credit this account (e.g. an opening-balance equity / found income account)."
                : "Decreases credit 1360 Inventory-Parts and debit this account (e.g. shrinkage / write-off expense)."}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Reason *</Label>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} placeholder="e.g. Opening balance count 2026-06" />
          </div>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !partId || !glAccountId || !reason.trim()}>
            {submitting ? "Posting…" : "Post adjustment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{children}</div>;
}
