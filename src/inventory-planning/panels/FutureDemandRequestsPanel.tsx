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
import { S, PAL, formatQty, formatPeriodCode } from "../components/styles";
import ConfirmModal from "../components/ConfirmModal";
import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import type { ToastMessage } from "../components/Toast";

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
  onToast: (t: ToastMessage) => void;
  currentUser?: string | null;
}

export default function FutureDemandRequestsPanel({
  customers, categories, items, requests, onChange, onToast, currentUser,
}: FutureDemandRequestsPanelProps) {
  const [filterStatus, setFilterStatus] = useState<IpRequestStatus | "all">("open");
  const [filterCustomer, setFilterCustomer] = useState<string>("all");
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IpFutureDemandRequest | null>(null);

  const visible = useMemo(() => {
    return requests.filter((r) => {
      if (filterStatus !== "all" && r.request_status !== filterStatus) return false;
      if (filterCustomer !== "all" && r.customer_id !== filterCustomer) return false;
      return true;
    });
  }, [requests, filterStatus, filterCustomer]);

  const customerById = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Style → first sku_id resolver. The table stores sku_id (the master
  // FK) but the planner picks at the STYLE level — variants are
  // represented by their first SKU. Same convention the wholesale grid
  // uses for its TBD style picker.
  const skuByStyle = useMemo(() => {
    const out = new Map<string, string>();
    for (const i of items) {
      const v = i.style_code ?? i.sku_code;
      if (!v) continue;
      if (!out.has(v)) out.set(v, i.id);
    }
    return out;
  }, [items]);

  async function archive(id: string) {
    setBusyId(id);
    try {
      await wholesaleRepo.updateRequest(id, { request_status: "archived" });
      await onChange();
      onToast({ text: "Request archived", kind: "success" });
    } catch (e) {
      onToast({ text: "Archive failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusyId(target.id);
    try {
      await wholesaleRepo.deleteRequest(target.id);
      await onChange();
      onToast({ text: "Request deleted", kind: "success" });
    } catch (e) {
      onToast({ text: "Delete failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={S.cardTitle}>Future demand requests</h3>
        <button style={S.btnPrimary} onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ New request"}
        </button>
      </div>

      {showForm && (
        <RequestForm
          customers={customers}
          items={items}
          categories={categories}
          skuByStyle={skuByStyle}
          currentUser={currentUser}
          onCancel={() => setShowForm(false)}
          onToast={onToast}
          onSaved={async () => {
            await onChange();
            setShowForm(false);
            onToast({ text: "Request created", kind: "success" });
          }}
        />
      )}

      <div style={S.toolbar}>
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterStatus === "all" ? [] : [filterStatus]}
          onChange={(next) => setFilterStatus(((next[0] as IpRequestStatus) ?? "all") as IpRequestStatus | "all")}
          allLabel="All statuses"
          placeholder="Search statuses…"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <MultiSelectDropdown
          compact
          singleSelect
          selected={filterCustomer === "all" ? [] : [filterCustomer]}
          onChange={(next) => setFilterCustomer(next[0] ?? "all")}
          allLabel="All customers"
          placeholder="Search customers…"
          options={customers.map((c) => ({ value: c.id, label: c.name }))}
        />
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
                    {item?.style_code ?? item?.sku_code ?? r.sku_id.slice(0, 8)}
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
                    <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => setDeleteTarget(r)} disabled={busyId === r.id}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={9} style={{ ...S.td, color: PAL.textMuted, textAlign: "center", padding: 32 }}>
                {requests.length === 0
                  ? "No future demand requests yet. Click \"New request\" to add the first one."
                  : "No requests match your filters."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <ConfirmModal
          icon="🗑"
          title="Delete request?"
          message="This removes the request entirely. Archive it instead if you want to keep the record."
          confirmText="Delete"
          confirmColor={PAL.red}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function RequestForm({
  customers, items, skuByStyle, currentUser, onCancel, onSaved, onToast,
}: {
  customers: IpCustomer[];
  categories: IpCategory[];
  items: IpItem[];
  skuByStyle: Map<string, string>;
  currentUser?: string | null;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const [customerId, setCustomerId] = useState<string>(customers[0]?.id ?? "");
  const [styleCode, setStyleCode] = useState<string>("");
  const [periodCode, setPeriodCode] = useState<string>(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const [qty, setQty] = useState("");
  const [confidence, setConfidence] = useState<IpConfidenceLevel>("possible");
  const [type, setType] = useState<IpRequestType>("buyer_request");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Distinct style options for the picker. Same construction the
  // wholesale grid uses (style_code with sku_code fallback for legacy
  // master rows that have no style yet).
  const styleOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      const v = i.style_code ?? i.sku_code;
      if (v) set.add(v);
    }
    return Array.from(set).sort().map((s) => ({ value: s, label: s }));
  }, [items]);

  async function save() {
    const qn = Number(qty);
    if (!customerId) { onToast({ text: "Pick a customer", kind: "error" }); return; }
    if (!styleCode)  { onToast({ text: "Pick a style", kind: "error" }); return; }
    const skuId = skuByStyle.get(styleCode);
    if (!skuId)      { onToast({ text: `No items found for style ${styleCode}`, kind: "error" }); return; }
    if (!/^\d{4}-\d{2}$/.test(periodCode)) { onToast({ text: "Pick a target month", kind: "error" }); return; }
    if (!Number.isFinite(qn) || qn <= 0)   { onToast({ text: "Qty must be a positive number", kind: "error" }); return; }

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
      onToast({ text: "Couldn't create request — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      background: PAL.panel,
      border: `1px solid ${PAL.accent}`,
      borderRadius: 10,
      padding: "12px 14px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap" as const,
      fontSize: 12,
      marginBottom: 12,
    }}>
      <span style={{ fontWeight: 600, color: PAL.accent }}>+ New request</span>
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Customer:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={customerId ? [customerId] : []}
        onChange={(next) => setCustomerId(next[0] ?? "")}
        allLabel="— pick —"
        placeholder="Search customers…"
        options={customers.map((c) => ({ value: c.id, label: c.name }))}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Style:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={styleCode ? [styleCode] : []}
        onChange={(next) => setStyleCode(next[0] ?? "")}
        allLabel="— pick —"
        placeholder="Search styles…"
        options={styleOptions}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Type:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={[type]}
        onChange={(next) => setType((next[0] as IpRequestType) ?? "buyer_request")}
        allLabel="Type"
        placeholder="Search types…"
        options={REQUEST_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
      />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Confidence:</span>
      <MultiSelectDropdown
        compact
        singleSelect
        selected={[confidence]}
        onChange={(next) => setConfidence((next[0] as IpConfidenceLevel) ?? "possible")}
        allLabel="Confidence"
        placeholder="Search confidence…"
        options={CONFIDENCE_LEVELS.map((c) => ({ value: c, label: c }))}
      />
      <input
        type="month"
        style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }}
        value={periodCode}
        onChange={(e) => setPeriodCode(e.target.value)}
        title="Target month"
      />
      <input
        style={{ ...S.input, width: 90, fontSize: 12, padding: "4px 8px", textAlign: "right", fontFamily: "monospace" }}
        value={qty}
        inputMode="numeric"
        placeholder="Qty"
        onChange={(e) => setQty(e.target.value)}
      />
      <input
        style={{ ...S.input, minWidth: 180, fontSize: 12, padding: "4px 8px" }}
        value={note}
        placeholder="Note (optional)"
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        disabled={saving || !customerId || !styleCode}
        onClick={save}
        style={{
          ...S.btnPrimary,
          padding: "5px 14px",
          fontSize: 12,
          opacity: saving || !customerId || !styleCode ? 0.5 : 1,
          cursor: saving || !customerId || !styleCode ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Saving…" : "Create request"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{ ...S.btnSecondary, padding: "5px 12px", fontSize: 12 }}
      >
        Cancel
      </button>
    </div>
  );
}

// Re-exported so other panels can reuse the constants without duplicating them.
export const ALL_REQUEST_TYPES = REQUEST_TYPES;
export const ALL_CONFIDENCE_LEVELS = CONFIDENCE_LEVELS;
