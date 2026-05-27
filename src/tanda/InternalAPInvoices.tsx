// src/tanda/InternalAPInvoices.tsx
//
// Tangerine P3 Chunk 2 — Accounts Payable invoice admin UI.
// Lists invoices with status/vendor/date/search filters. Add + Edit modal
// supports vendor dropdown, header expense_account/ap_account pickers,
// and mixed expense/inventory lines. Post / Pay / Void actions wired to the
// dedicated handlers.

import { useEffect, useMemo, useState } from "react";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";

type GlStatus = "draft" | "unposted" | "pending_approval" | "posted" | "paid" | "void" | "reversed";

type APInvoice = {
  id: string;
  entity_id: string;
  vendor_id: string;
  invoice_number: string;
  invoice_kind: string;
  gl_status: GlStatus;
  posting_date: string;
  due_date: string | null;
  description: string | null;
  expense_account_id: string | null;
  ap_account_id: string | null;
  accrual_je_id: string | null;
  cash_je_id: string | null;
  total_amount_cents: string;
  paid_amount_cents: string;
  created_at: string;
};

type APInvoiceLine = {
  id?: string;
  invoice_id?: string;
  line_number: number;
  description: string | null;
  expense_account_id: string | null;
  inventory_item_id: string | null;
  quantity: number | null;
  unit_cost_cents: string | null;
};

type APInvoiceFull = APInvoice & { lines: APInvoiceLine[] };

type Vendor = { id: string; name: string; vendor_code?: string };
type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_postable: boolean;
  status: string;
};
type Item = { id: string; sku_code: string; style?: string; color?: string };

type DraftLine = {
  key: number; // stable for React lists
  kind: "expense" | "inventory";
  expense_account_id: string;
  inventory_item_id: string;
  quantity: string;
  amount_dollars: string;     // for expense lines (UI grain = dollars)
  unit_cost_dollars: string;  // for inventory lines
  description: string;
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d" };
const btnWarn: React.CSSProperties = { ...btnSecondary, color: C.warn, borderColor: "#78350f" };
const btnSuccess: React.CSSProperties = { ...btnSecondary, color: C.success, borderColor: "#065f46" };

const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

function statusColor(s: GlStatus): string {
  if (s === "posted" || s === "paid") return C.success;
  if (s === "pending_approval") return C.warn;
  if (s === "void" || s === "reversed") return C.danger;
  return C.textMuted;
}

function fmtCents(c: string | number | null | undefined): string {
  if (c == null) return "$0.00";
  const bi = typeof c === "bigint" ? c : BigInt(String(c).replace(/[^-0-9]/g, "") || "0");
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${w}.${frac}`;
}

function dollarsToCentsBigInt(s: string): bigint | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(trimmed)) return null;
  const neg = trimmed.startsWith("-");
  const u = neg ? trimmed.slice(1) : trimmed;
  const [whole, frac = ""] = u.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -cents : cents;
}

export default function InternalAPInvoices() {
  const [rows, setRows] = useState<APInvoice[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<GlStatus | "">("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [includeVoid, setIncludeVoid] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<APInvoice | null>(null); // null = new
  const [payOpen, setPayOpen] = useState<APInvoice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendor_id", vendorFilter);
      if (search.trim()) params.set("q", search.trim());
      if (includeVoid) params.set("include_void", "true");
      const r = await fetch(`/api/internal/ap-invoices?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as APInvoice[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [statusFilter, vendorFilter, includeVoid]);

  useEffect(() => {
    fetch("/api/internal/vendors")
      .then((r) => r.json())
      .then((arr: unknown) => {
        if (Array.isArray(arr)) {
          // vendors endpoint shape: {id, name, vendor_code?, ...}
          setVendors(arr as Vendor[]);
        }
      })
      .catch(() => {});
  }, []);

  const vendorMap = useMemo(() => {
    const m: Record<string, Vendor> = {};
    for (const v of vendors) m[v.id] = v;
    return m;
  }, [vendors]);

  async function doPost(inv: APInvoice) {
    if (!confirm(`Post invoice ${inv.invoice_number}? This will create the accrual JE.`)) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ap-invoices/${inv.id}/post`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.requires_approval) {
        alert(`Approval required. Approval request id: ${j.approval_request_id || "(see Approvals tab)"}.`);
      }
      await load();
    } catch (e: unknown) {
      alert(`Post failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function doVoid(inv: APInvoice) {
    const reason = prompt(`Void invoice ${inv.invoice_number}? Optional reason:`, "");
    if (reason === null) return;
    setBusy(inv.id);
    try {
      const r = await fetch(`/api/internal/ap-invoices/${inv.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Void failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>AP Invoices</h2>
        <button onClick={() => { setEditing(null); setEditOpen(true); }} style={btnPrimary}>
          + New invoice
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as GlStatus | "")} style={{ ...inputStyle, width: 180 }}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="pending_approval">Pending approval</option>
          <option value="posted">Posted</option>
          <option value="paid">Paid</option>
          <option value="void">Void</option>
        </select>
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} style={{ ...inputStyle, width: 240 }}>
          <option value="">All vendors</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <input
          type="text" placeholder="Search invoice #" value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
          style={{ ...inputStyle, width: 220 }}
        />
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
          Include void
        </label>
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No AP invoices.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Posting</th>
                <th style={th}>Due</th>
                <th style={th}>Vendor</th>
                <th style={th}>Invoice #</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
                <th style={{ ...th, textAlign: "right" }}>Paid</th>
                <th style={{ ...th, width: 260 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const isDraft = inv.gl_status === "draft" || inv.gl_status === "unposted";
                const isPosted = inv.gl_status === "posted";
                const isPaid = inv.gl_status === "paid";
                const isVoid = inv.gl_status === "void" || inv.gl_status === "reversed";
                const isPendingApproval = inv.gl_status === "pending_approval";
                const owedCents = BigInt(inv.total_amount_cents || "0") - BigInt(inv.paid_amount_cents || "0");
                return (
                  <tr
                    key={inv.id}
                    onClick={() => { setEditing(inv); setEditOpen(true); }}
                    style={{ cursor: "pointer", ...(isVoid ? { opacity: 0.5 } : {}) }}
                  >
                    <td style={td}>{inv.posting_date}</td>
                    <td style={td}>{inv.due_date || "—"}</td>
                    <td style={td}>{vendorMap[inv.vendor_id]?.name || inv.vendor_id.slice(0, 8)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{inv.invoice_number}</td>
                    <td style={td}>
                      <span style={{ color: statusColor(inv.gl_status), fontWeight: 600 }}>● {inv.gl_status}</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                      {fmtCents(inv.total_amount_cents)}
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                      {fmtCents(inv.paid_amount_cents)}
                    </td>
                    <td style={{ ...td, textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      {isDraft && (
                        <button
                          onClick={() => void doPost(inv)} style={btnSuccess}
                          disabled={busy === inv.id}
                        >
                          Post
                        </button>
                      )}
                      {isPendingApproval && (
                        <span style={{ fontSize: 11, color: C.warn }}>Awaiting approval</span>
                      )}
                      {isPosted && owedCents > 0n && (
                        <button
                          onClick={() => setPayOpen(inv)} style={btnPrimary}
                          disabled={busy === inv.id}
                        >
                          Pay
                        </button>
                      )}
                      {isPaid && (
                        <span style={{ fontSize: 11, color: C.success }}>Fully paid</span>
                      )}
                      {!isVoid && (
                        <button
                          onClick={() => void doVoid(inv)} style={{ ...btnDanger, marginLeft: 6 }}
                          disabled={busy === inv.id}
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editOpen && (
        <APInvoiceModal
          invoice={editing}
          vendors={vendors}
          onClose={() => { setEditOpen(false); setEditing(null); }}
          onSaved={() => { setEditOpen(false); setEditing(null); void load(); }}
        />
      )}

      {payOpen && (
        <APPaymentModal
          invoice={payOpen}
          onClose={() => setPayOpen(null)}
          onPaid={() => { setPayOpen(null); void load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Add / Edit modal
// ─────────────────────────────────────────────────────────────────────
function APInvoiceModal({
  invoice, vendors, onClose, onSaved,
}: {
  invoice: APInvoice | null;
  vendors: Vendor[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = invoice === null;
  const editable = isNew || invoice?.gl_status === "draft" || invoice?.gl_status === "unposted";

  const [vendorId, setVendorId] = useState(invoice?.vendor_id || "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoice_number || "");
  const [kind, setKind] = useState(invoice?.invoice_kind || "vendor_bill");
  const [postingDate, setPostingDate] = useState(invoice?.posting_date || new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(invoice?.due_date || "");
  const [description, setDescription] = useState(invoice?.description || "");
  const [apAccountId, setApAccountId] = useState(invoice?.ap_account_id || "");
  const [expenseAccountId, setExpenseAccountId] = useState(invoice?.expense_account_id || "");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, kind: "expense", expense_account_id: "", inventory_item_id: "", quantity: "1", amount_dollars: "", unit_cost_dollars: "", description: "" },
  ]);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => setAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active") : []))
      .catch(() => {});
  }, []);

  // Lazy-load existing lines when editing.
  useEffect(() => {
    if (isNew || !invoice) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/internal/ap-invoices/${invoice.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as APInvoiceFull;
        if (cancelled) return;
        if (full.lines?.length > 0) {
          const ll = full.lines.map((l, i) => ({
            key: i + 1,
            kind: (l.inventory_item_id ? "inventory" : "expense") as "expense" | "inventory",
            expense_account_id: l.expense_account_id || "",
            inventory_item_id: l.inventory_item_id || "",
            quantity: l.quantity != null ? String(l.quantity) : "1",
            amount_dollars: l.inventory_item_id ? "" : fmtCentsRaw(centsMul(l.unit_cost_cents, l.quantity)),
            unit_cost_dollars: l.inventory_item_id ? fmtCentsRaw(l.unit_cost_cents) : "",
            description: l.description || "",
          }));
          setLines(ll);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [invoice, isNew]);

  function addLine(kind: "expense" | "inventory") {
    setLines((ll) => [...ll, {
      key: (ll[ll.length - 1]?.key || 0) + 1,
      kind,
      expense_account_id: "",
      inventory_item_id: "",
      quantity: "1",
      amount_dollars: "",
      unit_cost_dollars: "",
      description: "",
    }]);
  }
  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((ll) => ll.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function removeLine(idx: number) {
    if (lines.length <= 1) return;
    setLines((ll) => ll.filter((_, i) => i !== idx));
  }

  const totalCents = useMemo(() => {
    let total = 0n;
    for (const l of lines) {
      if (l.kind === "expense") {
        const c = dollarsToCentsBigInt(l.amount_dollars);
        if (c != null) total += c;
      } else {
        const uc = dollarsToCentsBigInt(l.unit_cost_dollars);
        const qty = Number(l.quantity);
        if (uc != null && Number.isFinite(qty)) {
          total += uc * BigInt(Math.round(qty));
        }
      }
    }
    return total;
  }, [lines]);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const apiLines = lines.map((l) => {
        if (l.kind === "inventory") {
          // Lazy-resolve item — if user typed an inventory sku_code we'd need
          // to look it up; for now we send the explicit uuid in the field.
          const uc = dollarsToCentsBigInt(l.unit_cost_dollars);
          return {
            inventory_item_id: l.inventory_item_id,
            quantity: Number(l.quantity),
            unit_cost_cents: uc != null ? uc.toString() : null,
            description: l.description || null,
          };
        }
        const c = dollarsToCentsBigInt(l.amount_dollars);
        return {
          expense_account_id: l.expense_account_id,
          amount_cents: c != null ? c.toString() : null,
          description: l.description || null,
        };
      });

      const body: Record<string, unknown> = {
        vendor_id: vendorId,
        invoice_number: invoiceNumber.trim(),
        invoice_kind: kind,
        posting_date: postingDate,
        due_date: dueDate || null,
        description: description.trim() || null,
        expense_account_id: expenseAccountId || null,
        ap_account_id: apAccountId || null,
        lines: apiLines,
      };

      let r: Response;
      if (isNew) {
        r = await fetch("/api/internal/ap-invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        r = await fetch(`/api/internal/ap-invoices/${invoice!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const formValid =
    !!vendorId && !!invoiceNumber.trim() && !!postingDate &&
    lines.length > 0 &&
    lines.every((l) =>
      (l.kind === "inventory" &&
        !!l.inventory_item_id && Number(l.quantity) > 0 &&
        dollarsToCentsBigInt(l.unit_cost_dollars) != null) ||
      (l.kind === "expense" &&
        !!l.expense_account_id &&
        (dollarsToCentsBigInt(l.amount_dollars) || 0n) > 0n)
    );

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 1000, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {isNew ? "New AP invoice" : `Edit AP invoice ${invoice?.invoice_number || ""}`}
          {!isNew && (
            <span style={{ marginLeft: 12, fontSize: 12, color: statusColor(invoice!.gl_status) }}>
              ● {invoice!.gl_status}
            </span>
          )}
        </h3>

        {loading ? (
          <div style={{ color: C.textMuted, padding: 24, textAlign: "center" }}>Loading…</div>
        ) : (
          <>
            {!editable && (
              <div style={{ background: "#78350f", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
                This invoice is in status <strong>{invoice!.gl_status}</strong> and cannot be edited. Read-only view.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Vendor">
                <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                  <option value="">(pick vendor…)</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </Field>
              <Field label="Invoice number">
                <input type="text" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Kind">
                <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                  <option value="vendor_bill">vendor_bill</option>
                  <option value="vendor_credit_memo">vendor_credit_memo</option>
                  <option value="expense_report">expense_report</option>
                </select>
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="Posting date">
                <input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Due date">
                <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!editable} style={inputStyle} />
              </Field>
              <Field label="Default expense account">
                <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                  <option value="">(none — set per line)</option>
                  {accounts.filter((a) => a.is_postable).map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="AP account">
                <select value={apAccountId} onChange={(e) => setApAccountId(e.target.value)} disabled={!editable} style={inputStyle as React.CSSProperties}>
                  <option value="">(entity default)</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Description">
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!editable} style={inputStyle} placeholder="optional" />
            </Field>

            <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
              {editable && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => addLine("expense")} style={btnSecondary}>+ Expense line</button>
                  <button type="button" onClick={() => addLine("inventory")} style={btnSecondary}>+ Inventory line</button>
                </div>
              )}
            </div>

            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 36 }}>#</th>
                    <th style={{ ...th, width: 90 }}>Kind</th>
                    <th style={th}>Account / Item</th>
                    <th style={{ ...th, width: 80 }}>Qty</th>
                    <th style={{ ...th, width: 110 }}>Amount $</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.key}>
                      <td style={td}>{idx + 1}</td>
                      <td style={td}>
                        <select value={l.kind} onChange={(e) => updateLine(idx, { kind: e.target.value as "expense" | "inventory" })} disabled={!editable} style={inputStyle as React.CSSProperties}>
                          <option value="expense">expense</option>
                          <option value="inventory">inventory</option>
                        </select>
                      </td>
                      <td style={td}>
                        {l.kind === "expense" ? (
                          <select value={l.expense_account_id} onChange={(e) => updateLine(idx, { expense_account_id: e.target.value })} disabled={!editable} style={inputStyle as React.CSSProperties}>
                            <option value="">(pick account…)</option>
                            {accounts.filter((a) => a.is_postable).map((a) => (
                              <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text" value={l.inventory_item_id}
                            onChange={(e) => updateLine(idx, { inventory_item_id: e.target.value })}
                            disabled={!editable}
                            placeholder="ip_item_master uuid"
                            style={{ ...inputStyle, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}
                          />
                        )}
                      </td>
                      <td style={td}>
                        {l.kind === "inventory" ? (
                          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => updateLine(idx, { quantity: e.target.value })} disabled={!editable} style={inputStyle} />
                        ) : (
                          <span style={{ color: C.textMuted, fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={td}>
                        {l.kind === "inventory" ? (
                          <input type="text" value={l.unit_cost_dollars} onChange={(e) => updateLine(idx, { unit_cost_dollars: e.target.value })} disabled={!editable} placeholder="unit $" style={inputStyle} />
                        ) : (
                          <input type="text" value={l.amount_dollars} onChange={(e) => updateLine(idx, { amount_dollars: e.target.value })} disabled={!editable} placeholder="0.00" style={inputStyle} />
                        )}
                      </td>
                      <td style={td}>
                        <input type="text" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} disabled={!editable} style={inputStyle} />
                      </td>
                      <td style={td}>
                        {editable && lines.length > 1 && (
                          <button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={td} colSpan={4}>
                      <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700 }}>
                      {fmtCents(totalCents.toString())}
                    </td>
                    <td style={td} colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {!isNew && invoice && (
              <div style={{ marginTop: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
                <DocumentAttachmentList
                  contextTable="invoices"
                  contextId={invoice.id}
                  kinds={["vendor_invoice_pdf", "receipt", "approval_correspondence", "other"]}
                />
              </div>
            )}

            {err && (
              <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
                {err}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
              {editable && (
                <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !formValid}>
                  {submitting ? "Saving…" : (isNew ? "Create draft" : "Save changes")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Pay modal (sub-modal over the list)
// ─────────────────────────────────────────────────────────────────────
function APPaymentModal({
  invoice, onClose, onPaid,
}: {
  invoice: APInvoice;
  onClose: () => void;
  onPaid: () => void;
}) {
  const owedCents = BigInt(invoice.total_amount_cents || "0") - BigInt(invoice.paid_amount_cents || "0");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountDollars, setAmountDollars] = useState(centsToDollarsStr(owedCents.toString()));
  const [method, setMethod] = useState("ach");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=1000")
      .then((r) => r.json())
      .then((arr: Account[]) => setAccounts(Array.isArray(arr) ? arr.filter((a) => a.status === "active" && a.is_postable) : []))
      .catch(() => {});
  }, []);

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const c = dollarsToCentsBigInt(amountDollars);
      if (c == null || c <= 0n) throw new Error("Amount must be > 0");
      const body = {
        payment_date: paymentDate,
        amount_cents: c.toString(),
        bank_account_id: bankAccountId || null,
        method,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      };
      const r = await fetch(`/api/internal/ap-invoices/${invoice.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      onPaid();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10,
        padding: 20, width: 600, maxWidth: "95vw", color: C.text,
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 18 }}>
          Record payment — invoice {invoice.invoice_number}
        </h3>
        <div style={{ marginBottom: 12, fontSize: 12, color: C.textMuted }}>
          Outstanding: <strong style={{ color: C.text }}>{fmtCents(owedCents.toString())}</strong>
          {" / "}
          Total: {fmtCents(invoice.total_amount_cents)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Payment date">
            <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Amount $">
            <input type="text" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Method">
            <select value={method} onChange={(e) => setMethod(e.target.value)} style={inputStyle as React.CSSProperties}>
              <option value="ach">ACH</option>
              <option value="wire">Wire</option>
              <option value="check">Check</option>
              <option value="credit_card">Credit card</option>
              <option value="cash">Cash</option>
            </select>
          </Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Bank account">
            <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} style={inputStyle as React.CSSProperties}>
              <option value="">(entity default)</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Reference">
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="check #, wire confirm, etc" style={inputStyle} />
          </Field>
        </div>
        <Field label="Notes">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" style={inputStyle} />
        </Field>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Posting…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function centsMul(unitCostCents: string | null, qty: number | null): string {
  if (!unitCostCents) return "0";
  const uc = BigInt(unitCostCents);
  const q = BigInt(Math.round(qty ?? 1));
  return (uc * q).toString();
}
function fmtCentsRaw(cents: string | null): string {
  if (!cents) return "";
  const bi = BigInt(cents);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const whole = (abs / 100n).toString();
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
function centsToDollarsStr(cents: string | null | undefined): string {
  return fmtCentsRaw(cents || null);
}
