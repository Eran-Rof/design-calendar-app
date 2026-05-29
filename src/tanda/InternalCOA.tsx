// src/tanda/InternalCOA.tsx
//
// Tangerine P1 Chunk 8a — Chart of Accounts admin panel.
// List + search + type filter + create + edit + hard-delete (rejected if any JE
// line references the account → caller should use status='inactive' instead).
// code, account_type, normal_balance are locked post-creation by the handler.

import { useEffect, useState } from "react";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
// Cross-cutter T11-3 — audit-trail drop-in for the GL account detail modal.
import RowHistory from "./components/RowHistory";

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
};

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

export default function InternalCOA() {
  const [rows, setRows] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
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

  useEffect(() => { void load(); }, [typeFilter, includeInactive]);

  async function del(a: Account) {
    if (!confirm(`Delete account ${a.code} (${a.name})?\nWill fail if any journal entry references it — use status=inactive instead in that case.`)) return;
    try {
      const r = await fetch(`/api/internal/gl-accounts/${a.id}`, { method: "DELETE" });
      if (!r.ok) {
        const msg = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
        if (r.status === 409) alert(`${msg}`);
        else throw new Error(msg);
        return;
      }
      await load();
    } catch (e: unknown) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Chart of Accounts</h2>
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>+ Add account</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          placeholder="Search code or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          style={{ ...inputStyle, maxWidth: 280 }}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ ...inputStyle, width: 200 }}>
          <option value="">All types</option>
          {TYPE_VALUES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={() => void load()} style={btnSecondary}>Search</button>
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
            { key: "code",            header: "Code" },
            { key: "name",            header: "Name" },
            { key: "account_type",    header: "Type" },
            { key: "account_subtype", header: "Subtype" },
            { key: "normal_balance",  header: "Normal Balance" },
            { key: "status",          header: "Status" },
            { key: "is_postable",     header: "Postable" },
            { key: "is_control",      header: "Control" },
            { key: "description",     header: "Description" },
            { key: "created_at",      header: "Created", format: "datetime" },
            { key: "updated_at",      header: "Updated", format: "datetime" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            No accounts. The COA is seeded once the accountant supplies the canonical list.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Code</th>
                <th style={th}>Name</th>
                <th style={th}>Type</th>
                <th style={th}>Subtype</th>
                <th style={th}>Balance</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: "center" }}>Postable</th>
                <th style={{ ...th, textAlign: "center" }}>Control</th>
                <th style={{ ...th, width: 140 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} style={a.status === "inactive" ? { opacity: 0.5 } : {}}>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 600 }}>{a.code}</td>
                  <td style={td}>{a.name}</td>
                  <td style={td}>{a.account_type}</td>
                  <td style={td}>{a.account_subtype || "—"}</td>
                  <td style={td}>{a.normal_balance}</td>
                  <td style={td}>{a.status}</td>
                  <td style={{ ...td, textAlign: "center" }}>{a.is_postable ? "✓" : "✗"}</td>
                  <td style={{ ...td, textAlign: "center" }}>{a.is_control ? "✓" : "✗"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => setEditing(a)} style={btnSecondary}>Edit</button>
                    <button onClick={() => void del(a)} style={{ ...btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </tr>
              ))}
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

  function onTypeChange(t: string) {
    setForm((f) => ({ ...f, account_type: t, normal_balance: TYPE_TO_NORMAL[t] || f.normal_balance }));
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
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
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 520, maxWidth: 640, color: C.text }}
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
              <select value={form.account_type} onChange={(e) => onTypeChange(e.target.value)} style={inputStyle as React.CSSProperties}>
                {TYPE_VALUES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <input type="text" value={form.account_type} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Normal balance">
            {mode === "add" ? (
              <select value={form.normal_balance} onChange={(e) => setForm({ ...form, normal_balance: e.target.value as "DEBIT" | "CREDIT" })} style={inputStyle as React.CSSProperties}>
                <option value="DEBIT">DEBIT</option>
                <option value="CREDIT">CREDIT</option>
              </select>
            ) : (
              <input type="text" value={form.normal_balance} disabled style={{ ...inputStyle, opacity: 0.5 }} />
            )}
          </Field>
          <Field label="Subtype">
            <input type="text" value={form.account_subtype} onChange={(e) => setForm({ ...form, account_subtype: e.target.value })} style={inputStyle} placeholder="e.g. current_asset, ar, cogs" />
          </Field>
          <Field label="Parent account">
            <SearchableSelect
              value={form.parent_account_id || null}
              onChange={(v) => setForm({ ...form, parent_account_id: v })}
              options={[
                { value: "", label: "(none)" },
                ...parentOptions.map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` })),
              ]}
              placeholder="(none)"
            />
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })} style={inputStyle as React.CSSProperties}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
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
