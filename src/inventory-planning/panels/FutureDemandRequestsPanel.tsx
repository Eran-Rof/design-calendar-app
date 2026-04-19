// CRUD panel for future buyer/planner demand requests. The compute layer
// reads rows from here through the repo at forecast-run time.
//
// Lives inside the workbench page — the caller passes master lists so we
// don't re-query.

import { useMemo, useState } from "react";
import type { IpCategory, IpCustomer, IpItem } from "../types/entities";
import type {
  IpConfidenceLevel,
  IpFutureDemandRequest,
  IpRequestStatus,
  IpRequestType,
} from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { monthOf } from "../compute/periods";
import { S, PAL, formatQty, formatDate, formatPeriodCode } from "../components/styles";

const REQUEST_TYPES: IpRequestType[] = [
  "buyer_request", "expected_reorder", "program_fill_in",
  "seasonal_estimate", "planner_estimate", "customer_expansion",
];
const CONFIDENCE_LEVELS: IpConfidenceLevel[] = ["committed", "probable", "possible", "estimate"];
const STATUSES: IpRequestStatus[] = ["open", "applied", "archived"];

export interface FutureDemandRequestsPanelProps {
  customers: IpCustomer[];
  categories: IpCategory[];
  items: IpItem[];
  requests: IpFutureDemandRequest[];
  onChange: () => Promise<void> | void;
  currentUser?: string | null;
}

export default function FutureDemandRequestsPanel({
  customers, categories, items, requests, onChange, currentUser,
}: FutureDemandRequestsPanelProps) {
  const [filterStatus, setFilterStatus] = useState<IpRequestStatus | "all">("open");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = useMemo(() => {
    return requests.filter((r) => {
      if (filterStatus !== "all" && r.request_status !== filterStatus) return false;
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      return true;
    });
  }, [requests, filterStatus, filterCustomer]);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  async function archive(id: string) {
    setBusyId(id);
    try {
      await wholesaleRepo.updateRequest(id, { request_status: "archived" });
      await onChange();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this request? This cannot be undone.")) return;
    setBusyId(id);
    try {
      await wholesaleRepo.deleteRequest(id);
      await onChange();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={S.cardTitle}>Future demand requests</h3>
        <button style={S.btnPrimary} onClick={() => setShowForm(true)}>+ New request</button>
      </div>

      <div style={S.toolbar}>
        <select style={S.select} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as IpRequestStatus | "all")}>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={S.select} value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}>
          <option value="all">All customers</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          {visible.length} of {requests.length}
        </span>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Period</th>
              <th style={S.th}>Customer</th>
              <th style={S.th}>SKU</th>
              <th style={{ ...S.th, textAlign: "right" }}>Qty</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Confidence</th>
              <th style={S.th}>Status</th>
              <th style={S.th}>Note</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const customer = customerById.get(r.customer_id);
              const item = itemById.get(r.sku_id);
              return (
                <tr key={r.id}>
                  <td style={S.td}>{formatPeriodCode(monthOf(r.target_period_start).period_code)}</td>
                  <td style={S.td}>{customer?.name ?? r.customer_id.slice(0, 8)}</td>
                  <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                    {item?.sku_code ?? r.sku_id.slice(0, 8)}
                  </td>
                  <td style={S.tdNum}>{formatQty(r.requested_qty)}</td>
                  <td style={S.td}>{r.request_type}</td>
                  <td style={S.td}>{r.confidence_level}</td>
                  <td style={S.td}>{r.request_status}</td>
                  <td style={{ ...S.td, color: PAL.textMuted }}>{r.note ?? ""}</td>
                  <td style={S.td}>
                    {r.request_status !== "archived" && (
                      <button style={S.btnGhost} onClick={() => archive(r.id)} disabled={busyId === r.id}>
                        Archive
                      </button>
                    )}
                    <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => remove(r.id)} disabled={busyId === r.id}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={9} style={{ ...S.td, color: PAL.textMuted, textAlign: "center" }}>No requests match the filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <RequestForm
          customers={customers}
          categories={categories}
          items={items}
          currentUser={currentUser}
          onClose={() => setShowForm(false)}
          onSaved={async () => { setShowForm(false); await onChange(); }}
        />
      )}
    </div>
  );
}

function RequestForm({
  customers, categories, items, currentUser, onClose, onSaved,
}: {
  customers: IpCustomer[];
  categories: IpCategory[];
  items: IpItem[];
  currentUser?: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [customerId, setCustomerId] = useState<string>(customers[0]?.id ?? "");
  const [skuId, setSkuId] = useState<string>("");
  const [skuSearch, setSkuSearch] = useState("");
  const [periodCode, setPeriodCode] = useState<string>(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [qty, setQty] = useState("");
  const [confidence, setConfidence] = useState<IpConfidenceLevel>("possible");
  const [type, setType] = useState<IpRequestType>("buyer_request");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    const q = skuSearch.trim().toUpperCase();
    if (!q) return items.slice(0, 50);
    return items.filter((i) =>
      i.sku_code.includes(q) || (i.description ?? "").toUpperCase().includes(q),
    ).slice(0, 50);
  }, [items, skuSearch]);

  async function save() {
    setError(null);
    const qn = Number(qty);
    if (!customerId) { setError("Pick a customer"); return; }
    if (!skuId)      { setError("Pick a SKU"); return; }
    if (!/^\d{4}-\d{2}$/.test(periodCode)) { setError("Period must be YYYY-MM"); return; }
    if (!Number.isFinite(qn) || qn <= 0)   { setError("Qty must be a positive number"); return; }

    const period = monthOf(`${periodCode}-01`);
    const item = items.find((i) => i.id === skuId);
    setSaving(true);
    try {
      await wholesaleRepo.createRequest({
        customer_id: customerId,
        category_id: item?.category_id ?? null,
        sku_id: skuId,
        target_period_start: period.period_start,
        target_period_end: period.period_end,
        requested_qty: Math.round(qn),
        confidence_level: confidence,
        request_type: type,
        request_status: "open",
        note: note.trim() || null,
        created_by: currentUser ?? null,
      });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New future demand request</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 12 }}>
            <div>
              <label style={S.label}>Customer</label>
              <select style={{ ...S.select, width: "100%" }} value={customerId}
                      onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">— pick —</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>SKU search</label>
              <input style={{ ...S.input, width: "100%" }} value={skuSearch}
                     placeholder="Search by SKU or description"
                     onChange={(e) => setSkuSearch(e.target.value)} />
              <select style={{ ...S.select, width: "100%", marginTop: 6 }} value={skuId}
                      onChange={(e) => setSkuId(e.target.value)} size={8}>
                {filteredItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.sku_code}{i.description ? ` — ${i.description}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={S.label}>Target month (YYYY-MM)</label>
                <input style={{ ...S.input, width: "100%" }} value={periodCode}
                       onChange={(e) => setPeriodCode(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Quantity</label>
                <input style={{ ...S.input, width: "100%" }} value={qty}
                       inputMode="numeric"
                       onChange={(e) => setQty(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Type</label>
                <select style={{ ...S.select, width: "100%" }} value={type}
                        onChange={(e) => setType(e.target.value as IpRequestType)}>
                  {REQUEST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Confidence</label>
                <select style={{ ...S.select, width: "100%" }} value={confidence}
                        onChange={(e) => setConfidence(e.target.value as IpConfidenceLevel)}>
                  {CONFIDENCE_LEVELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note}
                     onChange={(e) => setNote(e.target.value)} />
            </div>
            {error && <div style={{ color: PAL.red, fontSize: 12 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Create request"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Re-exported so other panels can reuse the constants without duplicating them.
export const ALL_REQUEST_TYPES = REQUEST_TYPES;
export const ALL_CONFIDENCE_LEVELS = CONFIDENCE_LEVELS;
