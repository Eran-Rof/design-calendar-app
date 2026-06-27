// src/tanda/InternalCOA.tsx
//
// Tangerine P1 Chunk 8a — Chart of Accounts admin panel.
// List + search + type filter + create + edit + hard-delete (rejected if any JE
// line references the account → caller should use status='inactive' instead).
// code, account_type, normal_balance are locked post-creation by the handler.

import { useEffect, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import { subtypeOptionsFor } from "./glAccountSubtypes";
import DynamicSearchInput from "./components/DynamicSearchInput";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
// Cross-cutter T11-3 — audit-trail drop-in for the GL account detail modal.
import RowHistory from "./components/RowHistory";
// Universal row-click + scroll-highlight primitive (operator ask #4).
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import { TablePrefsButton, useTablePrefs, type ColumnDef } from "./components/TablePrefs";

const COA_TABLE_KEY = "tangerine:coa:columns";
const COA_COLUMNS: ColumnDef[] = [
  { key: "code",            label: "Code" },
  { key: "name",            label: "Name" },
  { key: "account_type",    label: "Type" },
  { key: "account_subtype", label: "Subtype" },
  { key: "normal_balance",  label: "Normal" },
  { key: "balance",         label: "Balance" },
  { key: "status",          label: "Status" },
  { key: "is_postable",     label: "Postable" },
  { key: "is_control",      label: "Control" },
];

type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  account_subtype: string | null;
  parent_account_id: string | null;
  normal_balance: "DEBIT" | "CREDIT";
  is_postable: boolean;
  is_control: boolean;
  status: "active" | "inactive";
  description: string | null;
  created_at: string;
  updated_at: string;
  // Real-money balance from vw_gl_account_balances (ACCRUAL-basis, sign-
  // flipped so positive = on the account's normal side). Optional because
  // older callers / failed view-fetch may omit it; default to 0 on render.
  balance_signed_cents?: number | string | null;
};

// USD formatting with thousands separators + 2 decimals. Operates on cents
// to avoid float drift; negative values get a leading minus.
export function formatBalanceCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

// Default drill-down window — 90 days, same as the GL Detail panel's default.
function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function isoMinusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function buildGLDetailHref(accountId: string, fromISO?: string, toISO?: string): string {
  const params = new URLSearchParams();
  params.set("view", "gl_detail");
  params.set("account_id", accountId);
  params.set("from", fromISO || isoMinusDays(90));
  params.set("to",   toISO   || todayISO());
  return `/tangerine?${params.toString()}`;
}

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

const TYPE_VALUES = ["asset", "liability", "equity", "revenue", "expense", "contra_asset", "contra_revenue"];
const TYPE_TO_NORMAL: Record<string, "DEBIT" | "CREDIT"> = {
  asset: "DEBIT", expense: "DEBIT", contra_revenue: "DEBIT",
  liability: "CREDIT", equity: "CREDIT", revenue: "CREDIT", contra_asset: "CREDIT",
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
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%",
  // border-box so width:100% + padding stays inside the grid cell (else the
  // input bleeds into the adjacent column — CODE over NAME, SUBTYPE over PARENT).
  boxSizing: "border-box", colorScheme: "dark",
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export default function InternalCOA() {
  const [rows, setRows] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Operator ask #8 — search-as-you-type. The synchronous `value` binds to
  // the input so typing feels instant; `debouncedValue` is what drives the
  // fetch. 200ms matches the T6 GlobalSearchPalette cadence.
  const { value: q, debouncedValue: qDebounced, setValue: setQ } = useDebouncedSearch("", 200);
  const [typeFilter, setTypeFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  // Universal row-click primitive (operator ask #4) — click anywhere on a
  // row (except interactive children: Edit/Delete buttons, the Balance
  // link to GL Detail) to open the edit modal.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { visibleColumns, toggleColumn, resetToDefault } = useTablePrefs(
    COA_TABLE_KEY,
    COA_COLUMNS,
  );
  const isVisible = (k: string): boolean => visibleColumns.has(k);
  const { getRowProps } = useRowClickEdit<Account>({
    onRowClick: (a) => setEditing(a),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (a) => `Edit account ${a.code} ${a.name}`,
  });

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced.trim()) params.set("q", qDebounced.trim());
      if (typeFilter) params.set("account_type", typeFilter);
      if (includeInactive) params.set("include_inactive", "true");
      const r = await fetch(`/api/internal/gl-accounts?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Account[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [qDebounced, typeFilter, includeInactive]);

  async function del(a: Account) {
    if (!(await confirmDialog(`Delete account ${a.code} (${a.name})?\nWill fail if any journal entry references it — use status=inactive instead in that case.`))) return;
    try {
      const r = await fetch(`/api/internal/gl-accounts/${a.id}`, { method: "DELETE" });
      if (!r.ok) {
        const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
        if (r.status === 409) notify(`${msg}`, "error");
        else throw new Error(msg);
        return;
      }
      await load();
    } catch (e: unknown) {
      notify(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Chart of Accounts</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add account</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <DynamicSearchInput
          value={q}
          onChange={setQ}
          placeholder="Search code or name…"
          ariaLabel="Search chart of accounts"
          wrapperStyle={{ maxWidth: 280 }}
        />
        <div style={{ width: 200 }}>
          <SearchableSelect
            value={typeFilter || null}
            onChange={(v) => setTypeFilter(v)}
            options={[{ value: "", label: "All types" }, ...TYPE_VALUES.map((t) => ({ value: t, label: t }))]}
            placeholder="All types"
            inputStyle={{ ...inputStyle, width: 200 }}
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="chart-of-accounts"
          sheetName="Chart of Accounts"
          columns={[
            { key: "code",                  header: "Code" },
            { key: "name",                  header: "Name" },
            { key: "account_type",          header: "Type" },
            { key: "account_subtype",       header: "Subtype" },
            { key: "normal_balance",        header: "Normal" },
            { key: "balance_signed_cents",  header: "Balance",      format: "currency_cents" },
            { key: "status",                header: "Status" },
            { key: "is_postable",           header: "Postable" },
            { key: "is_control",            header: "Control" },
            { key: "description",           header: "Description" },
            { key: "created_at",            header: "Created",      format: "datetime" },
            { key: "updated_at",            header: "Updated",      format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={COA_TABLE_KEY}
          columns={COA_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No accounts. The COA is seeded once the accountant supplies the canonical list.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th} hidden={!isVisible("code")}>Code</th>
                <th style={th} hidden={!isVisible("name")}>Name</th>
                <th style={th} hidden={!isVisible("account_type")}>Type</th>
                <th style={th} hidden={!isVisible("account_subtype")}>Subtype</th>
                {/* Operator ask #15: was "Balance" (showing DEBIT/CREDIT label),
                    renamed to "Normal" so it doesn't collide with the new
                    money-balance column to its right. */}
                <th style={th} hidden={!isVisible("normal_balance")}>Normal</th>
                <th style={{ ...th, textAlign: "right" }} hidden={!isVisible("balance")}>Balance</th>
                <th style={th} hidden={!isVisible("status")}>Status</th>
                <th style={{ ...th, textAlign: "center" }} hidden={!isVisible("is_postable")}>Postable</th>
                <th style={{ ...th, textAlign: "center" }} hidden={!isVisible("is_control")}>Control</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const balCents = Number(a.balance_signed_cents ?? 0);
                const balText = formatBalanceCents(balCents);
                const isZero = !Number.isFinite(balCents) || balCents === 0;
                const isNeg  = Number.isFinite(balCents) && balCents < 0;
                const balColor = isZero ? C.textMuted : isNeg ? C.danger : C.text;
                return (
                  <ScrollHighlightRow
                    key={a.id}
                    rowId={a.id}
                    highlightedRowId={highlightedId}
                    {...getRowProps(a)}
                    style={a.status === "inactive" ? { opacity: 0.5 } : undefined}
                  >
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }} hidden={!isVisible("code")}>{a.code}</td>
                    <td style={td} hidden={!isVisible("name")}>{a.name}</td>
                    <td style={td} hidden={!isVisible("account_type")}>{a.account_type}</td>
                    <td style={td} hidden={!isVisible("account_subtype")}>{a.account_subtype || "—"}</td>
                    <td style={td} hidden={!isVisible("normal_balance")}>{a.normal_balance}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} hidden={!isVisible("balance")}>
                      <a
                        href={buildGLDetailHref(a.id)}
                        title={`Open GL Detail for ${a.code} — ${a.name} (last 90 days)`}
                        style={{
                          color: balColor,
                          textDecoration: "none",
                          borderBottom: isZero ? "none" : `1px dotted ${C.primary}`,
                          cursor: "pointer",
                          fontWeight: isZero ? 400 : 600,
                        }}
                        onClick={(e) => {
                          // Plain left-click → SPA navigation; let modifier
                          // keys + middle-click fall through to default <a>
                          // behaviour so the operator can open in a new tab.
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                          e.preventDefault();
                          window.location.href = buildGLDetailHref(a.id);
                        }}
                      >
                        {balText}
                      </a>
                    </td>
                    <td style={td} hidden={!isVisible("status")}>{a.status}</td>
                    <td style={{ ...td, textAlign: "center" }} hidden={!isVisible("is_postable")}>{a.is_postable ? "✓" : "✗"}</td>
                    <td style={{ ...td, textAlign: "center" }} hidden={!isVisible("is_control")}>{a.is_control ? "✓" : "✗"}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <button onClick={(e) => { e.stopPropagation(); setEditing(a); }} style={btnSecondary}>Edit</button>
                      <button onClick={(e) => { e.stopPropagation(); void del(a); }} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                    </td>
                  </ScrollHighlightRow>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {addOpen && <AccountFormModal mode="add" allAccounts={rows} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load(); }} />}
      {editing && <AccountFormModal mode="edit" allAccounts={rows} account={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

interface ModalProps {
  mode: "add" | "edit";
  allAccounts: Account[];
  account?: Account;
  onClose: () => void;
  onSaved: () => void;
}

function AccountFormModal({ mode, allAccounts, account, onClose, onSaved }: ModalProps) {
  const [form, setForm] = useState({
    code:               account?.code              ?? "",
    name:               account?.name              ?? "",
    account_type:       account?.account_type      ?? "asset",
    account_subtype:    account?.account_subtype   ?? "",
    parent_account_id:  account?.parent_account_id ?? "",
    normal_balance:     account?.normal_balance    ?? "DEBIT" as "DEBIT" | "CREDIT",
    is_postable:        account?.is_postable       ?? true,
    is_control:         account?.is_control        ?? false,
    status:             account?.status            ?? "active",
    description:        account?.description       ?? "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // M50 — brand allocation drafted during CREATE (no id yet); PUT after create.
  const [draftAlloc, setDraftAlloc] = useState<AllocationRow[]>([]);

  function onTypeChange(t: string) {
    setForm((f) => ({ ...f, account_type: t, normal_balance: TYPE_TO_NORMAL[t] || f.normal_balance }));
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    // If brands were drafted on a NEW account, they must total 100% (mirrors the
    // editor's own gate) — else block create with a clear message.
    if (mode === "add" && draftAlloc.length > 0) {
      const t = draftAlloc.reduce((s, a) => s + (Number(a.pct) || 0), 0);
      if (Math.abs(t - 100) > 0.01) {
        setErr("Brand allocation must total 100% (or deselect all brands).");
        setSubmitting(false);
        return;
      }
    }
    try {
      let url: string;
      let method: string;
      let body: Record<string, unknown>;
      if (mode === "add") {
        url = "/api/internal/gl-accounts";
        method = "POST";
        body = {
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          account_type: form.account_type,
          normal_balance: form.normal_balance,
          account_subtype: form.account_subtype || null,
          parent_account_id: form.parent_account_id || null,
          is_postable: form.is_postable,
          is_control: form.is_control,
          status: form.status,
          description: form.description || null,
        };
      } else {
        url = `/api/internal/gl-accounts/${account!.id}`;
        method = "PATCH";
        // code / account_type / normal_balance are locked — don't send.
        body = {
          name: form.name.trim(),
          account_subtype: form.account_subtype || null,
          parent_account_id: form.parent_account_id || null,
          is_postable: form.is_postable,
          is_control: form.is_control,
          status: form.status,
          description: form.description || null,
        };
      }
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      // On create, persist any drafted brand allocation against the new id.
      if (mode === "add" && draftAlloc.length > 0) {
        const created = await r.json().catch(() => null);
        const newId = created?.id;
        if (newId) {
          const ar = await fetch(`/api/internal/gl-accounts/${newId}/brand-allocation`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocations: draftAlloc }),
          });
          if (!ar.ok) throw new Error(`Account created, but saving the brand allocation failed: ${(await ar.json().catch(() => ({}))).error || `HTTP ${ar.status}`}`);
        }
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Parent options exclude self (no self-loops).
  const parentOptions = allAccounts.filter((a) => mode === "add" || a.id !== account!.id);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>
          {mode === "add" ? "Add account" : `Edit ${account!.code}`}
        </h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Code">
            {mode === "add" ? (
              <input type="text" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={inputStyle} placeholder="e.g. 1100" autoFocus />
            ) : (
              <input type="text" value={form.code} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Name">
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="e.g. Accounts Receivable" />
          </Field>
          <Field label="Account type">
            {mode === "add" ? (
              <SearchableSelect
                value={form.account_type || null}
                onChange={(v) => onTypeChange(v)}
                options={TYPE_VALUES.map((t) => ({ value: t, label: t }))}
                inputStyle={inputStyle as React.CSSProperties}
              />
            ) : (
              <input type="text" value={form.account_type} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Normal balance">
            {mode === "add" ? (
              <SearchableSelect
                value={form.normal_balance || null}
                onChange={(v) => setForm({ ...form, normal_balance: v as "DEBIT" | "CREDIT" })}
                options={[{ value: "DEBIT", label: "DEBIT" }, { value: "CREDIT", label: "CREDIT" }]}
                inputStyle={inputStyle as React.CSSProperties}
              />
            ) : (
              <input type="text" value={form.normal_balance} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Subtype">
            <SearchableSelect
              value={form.account_subtype || null}
              onChange={(v) => setForm({ ...form, account_subtype: v })}
              options={(() => {
                const opts = [{ value: "", label: "(select)" }, ...subtypeOptionsFor(form.account_type)];
                if (form.account_subtype && !opts.some((o) => o.value === form.account_subtype)) {
                  opts.push({ value: form.account_subtype, label: `${form.account_subtype} (custom)` });
                }
                return opts;
              })()}
              placeholder="(select)"
            />
          </Field>
          <Field label="Parent account">
            <SearchableSelect
              value={form.parent_account_id || null}
              onChange={(v) => setForm({ ...form, parent_account_id: v })}
              options={[
                { value: "", label: "(select)" },
                ...parentOptions.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
              ]}
              placeholder="(select)"
            />
          </Field>
          <Field label="Status">
            <SearchableSelect
              value={form.status || null}
              onChange={(v) => setForm({ ...form, status: v as "active" | "inactive" })}
              options={[{ value: "active", label: "active" }, { value: "inactive", label: "inactive" }]}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </Field>
          <Field label="Flags">
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: C.textSub }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={form.is_postable} onChange={(e) => setForm({ ...form, is_postable: e.target.checked })} />
                Postable (false = roll-up parent)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={form.is_control} onChange={(e) => setForm({ ...form, is_control: e.target.checked })} />
                Control account (requires subledger on JE lines)
              </label>
            </div>
          </Field>
        </div>

        <div style={{ marginTop: 12 }}>
          <Field label="Description">
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, minHeight: 60, resize: "vertical" }} />
          </Field>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginTop: 12, fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting}>
            {submitting ? "Saving…" : mode === "add" ? "Create" : "Save"}
          </button>
        </div>

        {/* M50 — brand allocation (P&L accounts only). Editable on create (drafted,
            saved with the account) and on edit (saved via its own button). */}
        {["revenue", "expense", "contra_revenue"].includes(form.account_type) && (
          mode === "edit" && account
            ? <BrandAllocationEditor accountId={account.id} />
            : <BrandAllocationEditor accountId={null} onDraftChange={setDraftAlloc} />
        )}

        {/* Cross-cutter T11-3 — audit trail timeline */}
        {mode === "edit" && account && (
          <RowHistory source_table="gl_accounts" source_id={account.id} />
        )}
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

// M50 chunk B-UI — per-account brand allocation editor (P&L accounts).
// Pick the brand(s) this account serves; >1 opens a % split (must total 100,
// even-split helper, one default). Save → PUT …/brand-allocation, which (server
// side) replaces the rule + generates/retires `{code}-{BRAND}` child accounts.
type AllocationRow = { brand_id: string; pct: number; is_default: boolean };
function BrandAllocationEditor(
  { accountId, onDraftChange }:
  { accountId: string | null; onDraftChange?: (allocations: AllocationRow[]) => void },
) {
  const [brands, setBrands] = useState<{ id: string; code: string; name: string }[]>([]);
  const [sel, setSel] = useState<Record<string, number>>({}); // brand_id → pct (selected only)
  const [def, setDef] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true); setErr(null); setMsg(null);
      try {
        // Always load the brand list; only fetch an existing rule when editing
        // a saved account (a brand-new account has no allocation yet).
        const br = await fetch("/api/internal/brands").then((r) => r.json());
        if (cancel) return;
        setBrands(Array.isArray(br.brands) ? br.brands : []);
        if (accountId) {
          const al = await fetch(`/api/internal/gl-accounts/${accountId}/brand-allocation`).then((r) => r.json());
          if (cancel) return;
          const cur: Record<string, number> = {}; let d: string | null = null;
          for (const a of (al.allocations || [])) { cur[a.brand_id] = Number(a.pct); if (a.is_default) d = a.brand_id; }
          setSel(cur); setDef(d);
        }
      } catch (e) { if (!cancel) setErr((e as Error).message); }
      finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [accountId]);

  // Draft mode (create): hand the current selection up so the parent can PUT it
  // after the account is created and its id is known.
  useEffect(() => {
    if (accountId || !onDraftChange) return;
    onDraftChange(Object.entries(sel).map(([brand_id, pct]) => ({ brand_id, pct: Number(pct), is_default: brand_id === def })));
  }, [sel, def, accountId, onDraftChange]);

  const ids = Object.keys(sel);
  const total = ids.reduce((s, id) => s + (Number(sel[id]) || 0), 0);
  const totalOk = Math.abs(total - 100) <= 0.01;

  function toggle(id: string) {
    setSel((prev) => {
      const n = { ...prev };
      if (id in n) { delete n[id]; if (def === id) setDef(null); }
      else n[id] = 0;
      return n;
    });
    setMsg(null);
  }
  function splitEven() {
    const k = Object.keys(sel); if (!k.length) return;
    const each = Math.floor((100 / k.length) * 100) / 100;
    const n: Record<string, number> = {};
    k.forEach((id, i) => { n[id] = i === k.length - 1 ? Math.round((100 - each * (k.length - 1)) * 100) / 100 : each; });
    setSel(n);
  }
  async function save() {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const allocations = Object.entries(sel).map(([brand_id, pct]) => ({ brand_id, pct: Number(pct), is_default: brand_id === def }));
      const r = await fetch(`/api/internal/gl-accounts/${accountId}/brand-allocation`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ allocations }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setMsg(allocations.length > 1
        ? `Saved — ${allocations.length} brand sub-accounts generated/updated.`
        : "Saved — single-brand account (no split).");
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  }

  if (loading) return <div style={{ color: C.textMuted, fontSize: 12, marginTop: 14 }}>Loading brand allocation…</div>;

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${C.cardBdr}`, paddingTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>Brand Allocation</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
        Pick the brand(s) this account serves. More than one opens a % split (must total 100%); a posting auto-splits into the brand sub-accounts.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {brands.map((b) => {
          const on = b.id in sel;
          return (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, color: on ? C.text : C.textSub }}>
                <input type="checkbox" checked={on} onChange={() => toggle(b.id)} />
                <span style={{ fontFamily: "monospace", color: C.textMuted }}>{b.code}</span> {b.name}
              </label>
              {on && (
                <>
                  <input
                    type="number" min={0} max={100} step="0.01" value={sel[b.id]}
                    onChange={(e) => setSel((p) => ({ ...p, [b.id]: Number(e.target.value) }))}
                    // Left-aligned: a right-aligned number input's digits get
                    // shoved left when the native spinner arrows appear on focus.
                    style={{ ...inputStyle, width: 80, textAlign: "left" } as React.CSSProperties}
                  />
                  <span style={{ color: C.textMuted }}>%</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.textSub }} title="Default brand for this account">
                    <input type="radio" name="brand-default" checked={def === b.id} onChange={() => setDef(b.id)} /> default
                  </label>
                </>
              )}
            </div>
          );
        })}
      </div>
      {ids.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
          <button onClick={splitEven} style={btnSecondary} type="button">Split evenly</button>
          <span style={{ fontSize: 13, fontWeight: 600, color: totalOk ? C.success : C.danger }}>
            Total: {total.toFixed(2)}% {totalOk ? "✓" : "— must equal 100%"}
          </span>
          {accountId ? (
            <button onClick={() => void save()} disabled={saving || !totalOk} style={{ ...btnPrimary, marginLeft: "auto", opacity: saving || !totalOk ? 0.5 : 1 }} type="button">
              {saving ? "Saving…" : "Save allocation"}
            </button>
          ) : (
            <span style={{ marginLeft: "auto", fontSize: 11, color: C.textMuted }}>Saved with the account on Create</span>
          )}
        </div>
      )}
      {ids.length === 0 && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>No brands selected — this account is not brand-split.</div>}
      {msg && <div style={{ background: "#064e3b", color: "#d1fae5", padding: "6px 10px", borderRadius: 6, marginTop: 8, fontSize: 12 }}>{msg}</div>}
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "6px 10px", borderRadius: 6, marginTop: 8, fontSize: 12 }}>{err}</div>}
    </div>
  );
}
