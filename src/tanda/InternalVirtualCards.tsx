import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import { notify, confirmDialog } from "../shared/ui/warn";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import SearchableSelect from "./components/SearchableSelect";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { useSort, type SortDir } from "./hooks/useSort";

interface Card {
  id: string;
  entity_id: string;
  invoice_id: string | null;
  vendor_id: string;
  card_number_last4: string;
  expiry_month: number;
  expiry_year: number;
  credit_limit: number;
  amount_spent: number;
  status: "active" | "spent" | "cancelled" | "expired";
  provider: string;
  issued_at: string;
  expires_at: string;
  vendor?: { id: string; name: string } | null;
  invoice?: { id: string; invoice_number: string; total: number } | null;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

export default function InternalVirtualCards() {
  const [entities, setEntities] = useState<{ id: string; name: string }[]>([]);
  const [entityId, setEntityId] = useState("");
  const [rows, setRows] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const [issueOpen, setIssueOpen] = useState(false);
  const [docsCard, setDocsCard] = useState<Card | null>(null);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/internal/entities?flat=true");
      if (r.ok) {
        const e = await r.json() as { id: string; name: string }[];
        setEntities(e); if (e.length && !entityId) setEntityId(e[0].id);
      }
    })();
  }, []);

  async function load() {
    if (!entityId) return;
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ entity_id: entityId });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetch(`/api/internal/virtual-cards?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      setRows(((await r.json()) as { rows: Card[] }).rows || []);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [entityId, statusFilter]);

  // #5 Sortable columns — div-grid "table".
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "tangerine:virtualcards:sort",
    accessors: {
      vendor: (c) => c.vendor?.name || "",
      card: (c) => c.card_number_last4,
      limit: (c) => Number(c.credit_limit),
      spent: (c) => Number(c.amount_spent),
      provider: (c) => c.provider,
      status: (c) => c.status,
      issued: (c) => c.issued_at,
    },
  });

  async function cancel(c: Card) {
    if (!(await confirmDialog(`Cancel the card ending in ${c.card_number_last4}? It can no longer be charged.`))) return;
    const r = await fetch(`/api/internal/virtual-cards/${c.id}/cancel`, { method: "PUT" });
    if (!r.ok) { notify(await r.text(), "error"); return; }
    await load();
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Virtual cards</h2>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>PAN + CVV are AES-256-GCM encrypted; only last4 is ever shown here. Vendors see the full details for 24 hours via a one-time reveal link.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <SearchableSelect
            value={entityId || null}
            onChange={(v) => setEntityId(v)}
            options={entities.map((e) => ({ value: e.id, label: e.name }))}
            inputStyle={selectSt}
          />
          <SearchableSelect
            value={statusFilter || null}
            onChange={(v) => setStatusFilter(v)}
            options={[{ value: "active", label: "Active" }, { value: "spent", label: "Spent" }, { value: "cancelled", label: "Cancelled" }, { value: "expired", label: "Expired" }, { value: "", label: "All" }]}
            inputStyle={selectSt}
          />
          <button onClick={() => setIssueOpen(true)} style={btnPrimary}>+ Issue card</button>
          <ExportButton
            rows={rows.map((c) => ({
              ...c,
              vendor_name: c.vendor?.name || c.vendor_id,
              invoice_number: c.invoice?.invoice_number || null,
              expiry: `${String(c.expiry_month).padStart(2, "0")}/${c.expiry_year}`,
            })) as unknown as Array<Record<string, unknown>>}
            filename="virtual-cards"
            sheetName="Virtual Cards"
            columns={[
              { key: "vendor_name",          header: "Vendor" },
              { key: "invoice_number",       header: "Invoice #" },
              { key: "card_number_last4",    header: "Last 4" },
              { key: "expiry",               header: "Expiry" },
              { key: "credit_limit",         header: "Limit",      format: "number" },
              { key: "amount_spent",         header: "Spent",      format: "number" },
              { key: "provider",             header: "Provider" },
              { key: "status",               header: "Status" },
              { key: "issued_at",            header: "Issued",     format: "datetime" },
              { key: "expires_at",           header: "Expires",    format: "datetime" },
            ] as ExportColumn<Record<string, unknown>>[]}
          />
        </div>
      </div>

      {loading ? <div style={{ color: C.textMuted }}>Loading…</div>
      : err ? <div style={{ color: C.danger }}>Error: {err}</div>
      : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: "center", color: C.textMuted, fontSize: 13, background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8 }}>No cards match.</div>
      ) : (
        <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 120px 100px 100px 100px 140px 110px", padding: "10px 14px", background: C.bg, borderBottom: `1px solid ${C.cardBdr}`, fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase" }}>
            <SortHeader label="Vendor / Invoice" k="vendor" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Card" k="card" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Limit" k="limit" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Spent" k="spent" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Provider" k="provider" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Status" k="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <SortHeader label="Issued" k="issued" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} />
            <div style={{ textAlign: "right" }}>Action</div>
          </div>
          {sortedRows.map((c) => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 120px 100px 100px 100px 140px 110px", padding: "10px 14px", borderBottom: `1px solid ${C.cardBdr}`, fontSize: 13, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600 }}>{c.vendor?.name || "—"}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>Inv {c.invoice?.invoice_number || "—"}</div>
              </div>
              <div style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>•••• {c.card_number_last4} · {String(c.expiry_month).padStart(2, "0")}/{c.expiry_year}</div>
              <div>${Number(c.credit_limit).toLocaleString()}</div>
              <div style={{ color: C.warn }}>${Number(c.amount_spent).toLocaleString()}</div>
              <div style={{ color: C.textSub, fontSize: 11, textTransform: "uppercase" }}>{c.provider}</div>
              <div><StatusChip status={c.status} /></div>
              <div style={{ color: C.textMuted, fontSize: 11 }}>{fmtDateDisplay(c.issued_at)}</div>
              <div style={{ textAlign: "right", display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button onClick={() => setDocsCard(c)} style={btnMini} title="Attach / view supporting documents">Docs</button>
                {c.status === "active" && <button onClick={() => void cancel(c)} style={{ ...btnMini, color: C.danger }}>Cancel</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {issueOpen && <IssueModal onClose={() => setIssueOpen(false)} onIssued={() => { setIssueOpen(false); void load(); }} />}

      {docsCard && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => setDocsCard(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>
                Documents — card •••• {docsCard.card_number_last4}
                <span style={{ color: C.textMuted, fontSize: 12, marginLeft: 8 }}>{docsCard.vendor?.name || "—"}</span>
              </h3>
              <button onClick={() => setDocsCard(null)} style={{ ...btnMini }}>Close</button>
            </div>
            <DocumentAttachmentList
              contextTable="virtual_cards"
              contextId={docsCard.id}
              kinds={["supporting_doc", "authorization", "receipt", "other"]}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function IssueModal({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) {
  const [invoiceId, setInvoiceId] = useState("");
  const [provider, setProvider] = useState<"stripe" | "marqeta" | "railsbank">("stripe");
  const [saving, setSaving] = useState(false);
  // Approved AP invoices, picked by number (no raw UUID input).
  const [invoiceOpts, setInvoiceOpts] = useState<Array<{ id: string; invoice_number: string | null; vendor_id: string | null }>>([]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/internal/ap-invoices?status=posted`);
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data)) setInvoiceOpts(data);
      } catch { /* non-fatal */ }
    })();
  }, []);
  const [result, setResult] = useState<{ reveal_url: string; card: { card_number_last4: string; credit_limit: number } } | null>(null);

  async function issue() {
    if (!invoiceId.trim()) { notify("Invoice ID required", "error"); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/internal/payments/virtual-card", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invoiceId.trim(), provider }),
      });
      if (!r.ok) throw new Error(await r.text());
      setResult(await r.json());
    } catch (e: unknown) { notify(e instanceof Error ? e.message : String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div style={overlay} onClick={() => { if (result) onIssued(); else onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modal, width: 500 }}>
        <h3 style={{ margin: "0 0 14px", fontSize: 18 }}>{result ? "Card issued" : "Issue virtual card"}</h3>
        {!result ? (
          <>
            <Row label="Invoice">
              <SearchableSelect
                value={invoiceId || null}
                onChange={(v) => setInvoiceId(v || "")}
                options={invoiceOpts.map((iv) => ({
                  value: iv.id,
                  label: iv.invoice_number || "(no number)",
                  searchHaystack: `${iv.invoice_number || ""}`,
                }))}
                placeholder="Search approved invoice by number…"
                emptyText="No posted AP invoices"
              />
            </Row>
            <Row label="Provider">
              <SearchableSelect
                value={provider}
                onChange={(v) => setProvider(v as "stripe")}
                options={[{ value: "stripe", label: "Stripe" }, { value: "marqeta", label: "Marqeta" }, { value: "railsbank", label: "Railsbank" }]}
                inputStyle={inp}
              />
            </Row>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={btnSecondary}>Cancel</button>
              <button onClick={() => void issue()} disabled={saving} style={btnPrimary}>{saving ? "Issuing…" : "Issue"}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ background: "rgba(16,185,129,0.1)", border: `1px solid ${C.success}`, borderRadius: 6, padding: 10, marginBottom: 10, fontSize: 12 }}>
              Card ending <strong>{result.card.card_number_last4}</strong> issued with ${Number(result.card.credit_limit).toLocaleString()} limit. Vendor notification sent with the reveal URL.
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>Reveal URL (copy if needed; it's valid for 24h):</div>
            <div style={{ padding: 8, background: C.bg, border: `1px solid ${C.cardBdr}`, borderRadius: 6, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11, wordBreak: "break-all" }}>{result.reveal_url}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button onClick={onIssued} style={btnPrimary}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Clickable sortable header cell for the div-grid "table".
function SortHeader({ label, k, activeKey, dir, onSort }: {
  label: string; k: string; activeKey: string | null; dir: SortDir; onSort: (key: string) => void;
}) {
  const active = activeKey === k;
  const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : " ▲";
  return (
    <div onClick={() => onSort(k)} title={`Sort by ${label}`} style={{ cursor: "pointer", userSelect: "none", ...(active ? { color: C.text } : null) }}>
      {label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0 }}>{indicator}</span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color = status === "active" ? C.success : status === "spent" ? C.primary : C.danger;
  return <span style={{ fontSize: 10, color: "#fff", background: color, padding: "2px 8px", borderRadius: 10, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inp = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.bg, color: C.text, fontSize: 13, boxSizing: "border-box", colorScheme: "dark" } as const;
const selectSt = { padding: "6px 10px", background: C.card, border: `1px solid ${C.cardBdr}`, color: C.text, borderRadius: 6, fontSize: 13, colorScheme: "dark" } as const;
const btnPrimary = { padding: "8px 14px", borderRadius: 6, border: "none", background: C.primary, color: "#FFFFFF", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" } as const;
const btnSecondary = { padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit" } as const;
const btnMini = { padding: "3px 10px", borderRadius: 4, border: `1px solid ${C.cardBdr}`, background: C.card, color: C.text, cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" } as const;
const overlay = { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal = { background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 22, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" as const, color: C.text };
