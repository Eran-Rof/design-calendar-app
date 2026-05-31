// src/tanda/InternalSalesReps.tsx
//
// Tangerine P7-6 — Sales Reps master admin panel (arch §4.4).
// List + filters + create modal + detail modal (header edit + tier table editor
// + customer assignments sub-section).
//
// Hits /api/internal/sales-reps, /api/internal/sales-reps/:id,
// /api/internal/sales-reps/:id/tiers, /api/internal/sales-reps/:id/assignments.

import { useEffect, useMemo, useState } from "react";
import { getCachedAuthUserId } from "../utils/tangerineAuthUser";
import ExportButton from "./exports/ExportButton";
import { confirmDialog } from "../shared/ui/warn";

type SalesRep = {
  id: string;
  entity_id: string;
  employee_id: string | null;
  display_name: string;
  email: string | null;
  default_commission_pct: number;
  payout_terms_days: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
};

type Tier = {
  id: string;
  sales_rep_id: string;
  threshold_cents: number;
  rate_pct: number;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
};

type Assignment = {
  id: string;
  customer_id: string;
  sales_rep_id: string;
  share_pct: number;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  customers?: { id: string; code: string | null; name: string } | null;
};

type SalesRepDetail = SalesRep & {
  tiers: Tier[];
  assignments: Assignment[];
};

type CustomerLite = { id: string; code: string | null; name: string };
type EmployeeLite = { id: string; code: string; first_name: string; last_name: string; display_name: string | null; is_active: boolean };

const C = {
  bg: "#0F172A",
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textSub: "#CBD5E1",
  primary: "#3B82F6",
  primaryDim: "#1d4ed8",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "8px 14px",
  borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600,
};
const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const btnDanger: React.CSSProperties = {
  background: "#7f1d1d", color: "#fecaca", border: 0,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
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
  color: C.text, fontSize: 13, verticalAlign: "top",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: C.textMuted, marginBottom: 4,
  textTransform: "uppercase", letterSpacing: 0.5,
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  } catch { return iso; }
}

function fmtCurrencyFromCents(cents: number): string {
  const dollars = (cents || 0) / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function InternalSalesReps() {
  const [rows, setRows] = useState<SalesRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [includeInactive, setIncludeInactive] = useState(false);
  const [q, setQ] = useState("");

  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (includeInactive) params.set("include_inactive", "1");
      if (q.trim())        params.set("q", q.trim());
      params.set("limit", "500");
      const r = await fetch(`/api/internal/sales-reps?${params.toString()}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomers() {
    try {
      const r = await fetch("/api/internal/customer-master?limit=500");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data)
        ? data
        : (data?.rows && Array.isArray(data.rows) ? data.rows : []);
      setCustomers(
        list.map((c: { id: string; code?: string | null; customer_code?: string | null; name: string }) => ({
          id: c.id,
          code: c.code ?? c.customer_code ?? null,
          name: c.name,
        })),
      );
    } catch { /* non-fatal */ }
  }

  async function loadEmployees() {
    try {
      const r = await fetch("/api/internal/employees?limit=500");
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data?.rows && Array.isArray(data.rows) ? data.rows : []);
      setEmployees(list as EmployeeLite[]);
    } catch { /* non-fatal */ }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { loadCustomers(); loadEmployees(); }, []);

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive, q]);

  const filterBarStyle: React.CSSProperties = {
    display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap",
    marginBottom: 14,
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.text }}>
          🧑‍💼 Sales Reps
        </h2>
        <span style={{ color: C.textMuted, fontSize: 12 }}>
          Commission-paid reps + tiers + customer assignments (M44)
        </span>
        <div style={{ flex: 1 }} />
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="sales-reps"
          sheetName="Sales Reps"
          columns={[
            { key: "display_name",           header: "Name" },
            { key: "email",                  header: "Email" },
            { key: "default_commission_pct", header: "Default Rate %", format: "number", digits: 2 },
            { key: "payout_terms_days",      header: "Terms (days)",   format: "number" },
            { key: "is_active",              header: "Active" },
            { key: "created_at",             header: "Created", format: "datetime" },
          ]}
        />
        <button type="button" style={btnPrimary} onClick={() => setAddOpen(true)}>
          + New rep
        </button>
      </div>

      <div style={filterBarStyle}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={labelStyle}>Search name / email</label>
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. smith"
            style={inputStyle}
          />
        </div>
        <label style={{ color: C.textSub, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive
        </label>
      </div>

      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>
          {err}
        </div>
      )}

      <div style={{
        background: C.card, border: `1px solid ${C.cardBdr}`,
        borderRadius: 8, overflow: "hidden",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={{ ...th, textAlign: "right" }}>Default rate</th>
              <th style={{ ...th, textAlign: "right" }}>Payout terms</th>
              <th style={th}>Status</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={td} colSpan={6}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td style={td} colSpan={6}>No sales reps match.</td></tr>
            )}
            {!loading && rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setDetailId(r.id)}
                style={{ cursor: "pointer" }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "#0b1220"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = "transparent"; }}
              >
                <td style={td}>{r.display_name}</td>
                <td style={{ ...td, color: C.textSub }}>{r.email || "—"}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                  {Number(r.default_commission_pct).toFixed(2)}%
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                  {r.payout_terms_days}d
                </td>
                <td style={td}>
                  {r.is_active
                    ? <span style={{ color: C.success, fontSize: 11, fontWeight: 600 }}>ACTIVE</span>
                    : <span style={{ color: C.textMuted, fontSize: 11, fontWeight: 600 }}>INACTIVE</span>}
                </td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }}>{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detailId && (
        <RepDetailModal
          id={detailId}
          customers={customers}
          employees={employees}
          onClose={() => { setDetailId(null); load(); }}
        />
      )}
      {addOpen && (
        <CreateRepModal
          employees={employees}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create modal
// ─────────────────────────────────────────────────────────────────────────────
function CreateRepModal({ employees, onClose, onCreated }: {
  employees: EmployeeLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [defaultPct, setDefaultPct] = useState("0");
  const [payoutDays, setPayoutDays] = useState("30");
  const [employeeId, setEmployeeId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!displayName.trim()) {
      setErr("Display name is required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const author = getCachedAuthUserId();
      const r = await fetch("/api/internal/sales-reps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          display_name: displayName.trim(),
          email: email.trim() || null,
          default_commission_pct: Number(defaultPct) || 0,
          payout_terms_days: Number(payoutDays) || 0,
          employee_id: employeeId || null,
          created_by_user_id: author || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title="New sales rep">
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      <Field label="Display name *">
        <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
      </Field>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} placeholder="rep@example.com" />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Default commission %">
          <input type="number" step="0.01" min="0" max="100" value={defaultPct}
            onChange={(e) => setDefaultPct(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Payout terms (days)">
          <input type="number" step="1" min="0" value={payoutDays}
            onChange={(e) => setPayoutDays(e.target.value)} style={inputStyle} />
        </Field>
      </div>
      <Field label="Employee link (optional)">
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}>
          <option value="">(none)</option>
          {employees.filter((e) => e.is_active).map((e) => (
            <option key={e.id} value={e.id}>
              {e.code} — {e.display_name || `${e.first_name} ${e.last_name}`}
            </option>
          ))}
        </select>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" onClick={onClose} style={btnSecondary}>Cancel</button>
        <button type="button" onClick={create} disabled={saving} style={btnPrimary}>
          {saving ? "Creating…" : "Create rep"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail modal — header edit + tier editor + assignments sub-section
// ─────────────────────────────────────────────────────────────────────────────
function RepDetailModal({ id, customers, employees, onClose }: {
  id: string;
  customers: CustomerLite[];
  employees: EmployeeLite[];
  onClose: () => void;
}) {
  const [data, setData] = useState<SalesRepDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [defaultPct, setDefaultPct] = useState("0");
  const [payoutDays, setPayoutDays] = useState("30");
  const [employeeId, setEmployeeId] = useState("");
  const [isActive, setIsActive] = useState(true);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${id}`);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const d: SalesRepDetail = await r.json();
      setData(d);
      setDisplayName(d.display_name);
      setEmail(d.email || "");
      setDefaultPct(String(d.default_commission_pct));
      setPayoutDays(String(d.payout_terms_days));
      setEmployeeId(d.employee_id || "");
      setIsActive(d.is_active);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function save() {
    if (!data) return;
    setSaving(true);
    setErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (displayName !== data.display_name) patch.display_name = displayName;
      if ((email || null) !== (data.email || null)) patch.email = email || null;
      if (Number(defaultPct) !== Number(data.default_commission_pct)) patch.default_commission_pct = Number(defaultPct);
      if (Number(payoutDays) !== data.payout_terms_days) patch.payout_terms_days = Number(payoutDays);
      if ((employeeId || null) !== (data.employee_id || null)) patch.employee_id = employeeId || null;
      if (isActive !== data.is_active) patch.is_active = isActive;

      if (Object.keys(patch).length === 0) { setSaving(false); return; }

      const r = await fetch(`/api/internal/sales-reps/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function softDelete() {
    if (!data || !data.is_active) return;
    if (!(await confirmDialog(`Soft-delete (deactivate) sales rep "${data.display_name}"?`))) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} title={data ? data.display_name : "Loading…"} maxWidth={920}>
      {loading && <div style={{ color: C.textMuted }}>Loading…</div>}
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "8px 12px",
          borderRadius: 6, marginBottom: 12, fontSize: 13,
        }}>{err}</div>
      )}
      {data && (
        <>
          <h3 style={sectionHdr}>Header</h3>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 2fr 1fr 1fr", gap: 12 }}>
            <Field label="Display name *">
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Default %">
              <input type="number" step="0.01" min="0" max="100" value={defaultPct}
                onChange={(e) => setDefaultPct(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Terms (days)">
              <input type="number" step="1" min="0" value={payoutDays}
                onChange={(e) => setPayoutDays(e.target.value)} style={inputStyle} />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Employee link">
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}>
                <option value="">(none)</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.code} — {e.display_name || `${e.first_name} ${e.last_name}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <label style={{ display: "flex", alignItems: "center", gap: 6, color: C.textSub, fontSize: 12, paddingTop: 8 }}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                Active
              </label>
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button type="button" onClick={save} disabled={saving} style={btnPrimary}>
              {saving ? "Saving…" : "Save header"}
            </button>
            {data.is_active && (
              <button type="button" onClick={softDelete} disabled={saving} style={btnDanger}>
                Soft-delete
              </button>
            )}
            <button type="button" onClick={onClose} style={btnSecondary}>Close</button>
          </div>

          <hr style={{ border: 0, borderTop: `1px solid ${C.cardBdr}`, margin: "20px 0 14px" }} />

          <TierEditor repId={id} tiers={data.tiers} reload={load} />

          <hr style={{ border: 0, borderTop: `1px solid ${C.cardBdr}`, margin: "20px 0 14px" }} />

          <AssignmentEditor
            repId={id}
            assignments={data.assignments}
            customers={customers}
            reload={load}
          />
        </>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier editor
// ─────────────────────────────────────────────────────────────────────────────
function TierEditor({ repId, tiers, reload }: {
  repId: string;
  tiers: Tier[];
  reload: () => Promise<void>;
}) {
  const [thrCents, setThrCents] = useState("0");
  const [ratePct, setRatePct] = useState("0");
  const [effFrom, setEffFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effTo, setEffTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function addTier() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${repId}/tiers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threshold_cents: Number(thrCents) || 0,
          rate_pct: Number(ratePct) || 0,
          effective_from: effFrom || null,
          effective_to: effTo || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setThrCents("0");
      setRatePct("0");
      setEffTo("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeTier(tierId: string) {
    if (!(await confirmDialog("Remove this tier?"))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${repId}/tiers?tier_id=${tierId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 style={sectionHdr}>Commission tiers ({tiers.length})</h3>
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "6px 10px",
          borderRadius: 6, marginBottom: 8, fontSize: 12,
        }}>{err}</div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={th}>Threshold</th>
            <th style={th}>Rate</th>
            <th style={th}>Effective from</th>
            <th style={th}>Effective to</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {tiers.length === 0 && (
            <tr><td style={td} colSpan={5}>No tiers — falls back to default commission %.</td></tr>
          )}
          {tiers.map((t) => (
            <tr key={t.id}>
              <td style={{ ...td, fontFamily: "monospace" }}>{fmtCurrencyFromCents(t.threshold_cents)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{Number(t.rate_pct).toFixed(2)}%</td>
              <td style={td}>{t.effective_from}</td>
              <td style={td}>{t.effective_to || "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>
                <button type="button" onClick={() => removeTier(t.id)} disabled={busy} style={btnDanger}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
        <Field label="Threshold (cents)">
          <input type="number" step="1" min="0" value={thrCents}
            onChange={(e) => setThrCents(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Rate %">
          <input type="number" step="0.01" min="0" max="100" value={ratePct}
            onChange={(e) => setRatePct(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Effective from">
          <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Effective to">
          <input type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} style={inputStyle} />
        </Field>
        <button type="button" onClick={addTier} disabled={busy} style={btnPrimary}>
          {busy ? "…" : "+ Add tier"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer assignment editor
// ─────────────────────────────────────────────────────────────────────────────
function AssignmentEditor({ repId, assignments, customers, reload }: {
  repId: string;
  assignments: Assignment[];
  customers: CustomerLite[];
  reload: () => Promise<void>;
}) {
  const [customerId, setCustomerId] = useState("");
  const [sharePct, setSharePct] = useState("100");
  const [effFrom, setEffFrom] = useState(new Date().toISOString().slice(0, 10));
  const [effTo, setEffTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const customerById = useMemo(() => {
    const m = new Map<string, CustomerLite>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  async function addAssignment() {
    if (!customerId) {
      setErr("Pick a customer first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${repId}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customer_id: customerId,
          share_pct: Number(sharePct) || 100,
          effective_from: effFrom || null,
          effective_to: effTo || null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setCustomerId("");
      setSharePct("100");
      setEffTo("");
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeAssignment(assignmentId: string) {
    if (!(await confirmDialog("Remove this assignment?"))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/internal/sales-reps/${repId}/assignments?assignment_id=${assignmentId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3 style={sectionHdr}>Customer assignments ({assignments.length})</h3>
      {err && (
        <div style={{
          background: "#7f1d1d", color: "#fecaca", padding: "6px 10px",
          borderRadius: 6, marginBottom: 8, fontSize: 12,
        }}>{err}</div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={th}>Customer</th>
            <th style={th}>Share %</th>
            <th style={th}>Effective from</th>
            <th style={th}>Effective to</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {assignments.length === 0 && (
            <tr><td style={td} colSpan={5}>No assignments — accruals will only fire when a rep is set directly on the invoice/customer.</td></tr>
          )}
          {assignments.map((a) => {
            const c = a.customers ?? customerById.get(a.customer_id) ?? null;
            return (
              <tr key={a.id}>
                <td style={td}>{c ? `${c.code ? c.code + " — " : ""}${c.name}` : a.customer_id}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{Number(a.share_pct).toFixed(2)}%</td>
                <td style={td}>{a.effective_from}</td>
                <td style={td}>{a.effective_to || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button type="button" onClick={() => removeAssignment(a.id)} disabled={busy} style={btnDanger}>
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
        <Field label="Customer *">
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inputStyle}>
            <option value="">(pick a customer)</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {(c.code ? `${c.code} — ` : "") + c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Share %">
          <input type="number" step="0.01" min="0.01" max="100" value={sharePct}
            onChange={(e) => setSharePct(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Effective from">
          <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Effective to">
          <input type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} style={inputStyle} />
        </Field>
        <button type="button" onClick={addAssignment} disabled={busy} style={btnPrimary}>
          {busy ? "…" : "+ Add"}
        </button>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared shell
// ─────────────────────────────────────────────────────────────────────────────
const sectionHdr: React.CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  color: C.textMuted,
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: 600,
};

function Modal({ title, children, onClose, maxWidth }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  maxWidth?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, border: `1px solid ${C.cardBdr}`,
          borderRadius: 10, width: "100%", maxWidth: maxWidth || 760, maxHeight: "92vh",
          overflow: "auto", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: C.text }}>{title}</h2>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ ...btnSecondary, padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}
