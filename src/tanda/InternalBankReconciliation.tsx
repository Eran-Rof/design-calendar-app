// src/tanda/InternalBankReconciliation.tsx
//
// Tangerine P6-5 — Bank Reconciliation admin panel.
//
// Two tabs:
//   Accounts        — list bank_accounts + last_synced_at + current_balance
//   Transactions    — unmatched queue; per-row: candidate suggestions,
//                     Apply / Create JE / Unmatch / Ignore buttons.
//
// Operator workflow:
//   1. Plaid sync runs every 4h (P6-2) → new bank_transactions land as
//      status='unmatched'.
//   2. Operator opens this panel → Transactions tab → reviews each row.
//   3. For each: click "Match" → pick a suggested JE line from the modal
//      → status='matched'. OR click "Create JE" for standalone lines
//      (fees, interest). OR "Ignore" for duplicates/test txns.
//   4. Once a period's unmatched count hits 0, the operator can close
//      the period (P5-1 close handler + future bank_recon_complete
//      check — P6-6).
//
// Drill-through Phase 2:
//   • matched / manual_je_created rows show a JE badge → JEDetailModal (the
//     handler resolves matched_je_line_id → the entry) → source doc chain.
//   • every row gets "GL ▸" → GLDetailModal on the txn's bank GL account,
//     windowed ±7 days around the posted date — for unmatched rows that is
//     the "find the counterpart" view.

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SearchableSelect from "./components/SearchableSelect";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import JEDetailModal, { type JEDetailSeed } from "./components/JEDetailModal";
import GLDetailModal, { type GLDetailTarget } from "./components/GLDetailModal";

const TXN_TABLE_KEY = "tanda.bank_recon_transactions";
const TXN_COLUMNS: ColumnDef[] = [
  { key: "date",        label: "Date" },
  { key: "account",     label: "Account" },
  { key: "description", label: "Description" },
  { key: "amount",      label: "Amount" },
  { key: "status",      label: "Status" },
];

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

type AutoPostRule = {
  match: string;
  target_account_id: string;
  max_amount_cents: number | null;
  direction: "deposit" | "withdrawal" | "both";
  label: string | null;
};

type BankAccount = {
  id: string;
  name: string;
  account_kind: string;
  institution_name: string | null;
  mask: string | null;
  feed_source: string;
  last_synced_at: string | null;
  current_balance_cents: number | null;
  is_active: boolean;
  gl_account_id: string;
  gl_accounts: { code: string; name: string } | null;
  auto_post_fee_rules?: AutoPostRule[];
  created_at: string;
};

type BankTxn = {
  id: string;
  bank_account_id: string;
  source: string;
  external_txn_id: string | null;
  posted_date: string;
  amount_cents: number;
  description: string | null;
  merchant_name: string | null;
  pending: boolean;
  status: "unmatched" | "matched" | "manual_je_created" | "ignored" | "reversed";
  matched_je_line_id: string | null;
  match_confidence: number | null;
  notes: string | null;
  bank_accounts?: {
    name: string; mask: string | null; institution_name: string | null;
    gl_account_id?: string | null;
    gl_accounts?: { code: string; name: string } | null;
  };
  // Drill-through Phase 2 — resolved server-side from matched_je_line_id.
  matched_je?: { id: string; je_number: string | null; description: string | null; status: string | null } | null;
};

type MatchCandidate = {
  bank_transaction_id: string;
  je_line_id: string;
  je_id: string;
  je_date: string;
  je_description: string | null;
  account_code: string;
  account_name: string;
  je_amount_cents: number;
  days_apart: number;
  confidence: number;
};

const STATUS_COLOR: Record<BankTxn["status"], string> = {
  unmatched: C.warn,
  matched: C.success,
  manual_je_created: C.primary,
  ignored: C.textMuted,
  reversed: C.danger,
};

const btnPrimary: React.CSSProperties = {
  background: C.primary, color: "white", border: 0, padding: "4px 10px",
  borderRadius: 4, cursor: "pointer", fontSize: 11, marginRight: 4,
};
const btnSecondary: React.CSSProperties = {
  background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11, marginRight: 4,
};
const btnWarn: React.CSSProperties = { ...btnSecondary, color: C.warn, borderColor: "#78350f" };
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};
const th: React.CSSProperties = {
  background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600,
  textAlign: "left", padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5,
  position: "sticky", top: 0, zIndex: 2,
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 12,
};
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function fmtCents(c: number | null | undefined): string {
  if (c == null) return "—";
  const n = Number(c);
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

export default function InternalBankReconciliation() {
  const [tab, setTab] = useState<"accounts" | "transactions">("transactions");
  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Bank Reconciliation</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setTab("transactions")}
            style={{
              ...inputStyle,
              cursor: "pointer",
              background: tab === "transactions" ? C.primary : "transparent",
              color: tab === "transactions" ? "white" : C.textSub,
              border: `1px solid ${tab === "transactions" ? C.primary : C.cardBdr}`,
            }}
          >
            Transactions
          </button>
          <button
            onClick={() => setTab("accounts")}
            style={{
              ...inputStyle,
              cursor: "pointer",
              background: tab === "accounts" ? C.primary : "transparent",
              color: tab === "accounts" ? "white" : C.textSub,
              border: `1px solid ${tab === "accounts" ? C.primary : C.cardBdr}`,
            }}
          >
            Accounts
          </button>
        </div>
      </div>
      {tab === "accounts" && <AccountsTab />}
      {tab === "transactions" && <TransactionsTab />}
    </div>
  );
}

function AccountsTab() {
  const [rows, setRows] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rulesModal, setRulesModal] = useState<BankAccount | null>(null);
  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch("/api/internal/bank-accounts");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as BankAccount[]);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const exportRows = useMemo(
    () => rows.map((r) => ({
      ...r,
      institution: r.institution_name,
      gl_account: r.gl_accounts ? `${r.gl_accounts.code} ${r.gl_accounts.name}` : r.gl_account_id,
      active: r.is_active ? "active" : "inactive",
    })),
    [rows]
  );
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <ExportButton
          rows={exportRows as unknown as Array<Record<string, unknown>>}
          filename="bank-accounts"
          sheetName="Bank Accounts"
          columns={[
            { key: "name",                  header: "Name" },
            { key: "institution",           header: "Institution" },
            { key: "mask",                  header: "Mask" },
            { key: "account_kind",          header: "Kind" },
            { key: "feed_source",           header: "Source" },
            { key: "gl_account",            header: "GL Account" },
            { key: "last_synced_at",        header: "Last Sync",  format: "datetime" },
            { key: "current_balance_cents", header: "Balance",    format: "currency_cents" },
            { key: "active",                header: "Status" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px" }}>Error: {err}</div>}
      {loading ? (
        <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>
          No bank accounts yet. Link a Plaid account via the Plaid Link flow (POST <code>/api/internal/bank-feeds/link-token</code> → frontend opens Plaid Link → POST <code>/api/internal/bank-feeds/exchange</code> with the public_token).
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Name</th>
            <th style={th}>Institution</th>
            <th style={th}>Mask</th>
            <th style={th}>Kind</th>
            <th style={th}>Source</th>
            <th style={th}>GL Account</th>
            <th style={th}>Last Sync</th>
            <th style={{ ...th, textAlign: "right" }}>Balance</th>
            <th style={th}>Status</th>
            <th style={th}>Auto-post</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={td}><strong>{r.name}</strong></td>
                <td style={td}>{r.institution_name || "—"}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{r.mask ? `••${r.mask}` : "—"}</td>
                <td style={td}>{r.account_kind}</td>
                <td style={{ ...td, color: r.feed_source === "plaid" ? C.success : r.feed_source === "csv_upload" ? C.warn : C.textMuted }}>{r.feed_source}</td>
                <td style={{ ...td, fontFamily: "monospace" }}>{r.gl_accounts ? `${r.gl_accounts.code} ${r.gl_accounts.name}` : "—"}</td>
                <td style={{ ...td, fontSize: 11, color: C.textMuted }}>{r.last_synced_at ? new Date(r.last_synced_at).toLocaleString() : "never"}</td>
                <td style={tdNum}>{fmtCents(r.current_balance_cents)}</td>
                <td style={{ ...td, color: r.is_active ? C.success : C.textMuted }}>{r.is_active ? "active" : "inactive"}</td>
                <td style={td}>
                  <button style={btnSecondary} onClick={() => setRulesModal(r)}>
                    Edit rules{Array.isArray(r.auto_post_fee_rules) && r.auto_post_fee_rules.length > 0 ? ` (${r.auto_post_fee_rules.length})` : ""}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rulesModal && (
        <AutoPostRulesModal
          account={rulesModal}
          onClose={() => setRulesModal(null)}
          onSaved={() => { setRulesModal(null); void load(); }}
        />
      )}
    </div>
    </div>
  );
}

function AutoPostRulesModal({ account, onClose, onSaved }: { account: BankAccount; onClose: () => void; onSaved: () => void }) {
  const [rules, setRules] = useState<AutoPostRule[]>([]);
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string; account_type: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [accResp, glResp] = await Promise.all([
          fetch(`/api/internal/bank-accounts/${account.id}`),
          fetch("/api/internal/gl-accounts?limit=500"),
        ]);
        if (accResp.ok) {
          const data = await accResp.json();
          const r = Array.isArray(data.auto_post_fee_rules) ? data.auto_post_fee_rules : [];
          setRules(r.map(normalizeRule));
        }
        if (glResp.ok) {
          const data = await glResp.json();
          setAccounts((Array.isArray(data) ? data : []).filter((a: { is_postable?: boolean }) => a.is_postable !== false));
        }
      } finally { setLoading(false); }
    })();
  }, [account.id]);

  function normalizeRule(r: Partial<AutoPostRule>): AutoPostRule {
    return {
      match: r.match || "",
      target_account_id: r.target_account_id || "",
      max_amount_cents: r.max_amount_cents ?? null,
      direction: (r.direction as AutoPostRule["direction"]) || "both",
      label: r.label || null,
    };
  }
  function addRule() {
    setRules((rs) => [...rs, { match: "", target_account_id: "", max_amount_cents: null, direction: "both", label: null }]);
  }
  function delRule(i: number) {
    setRules((rs) => rs.filter((_, idx) => idx !== i));
  }
  function updateRule(i: number, patch: Partial<AutoPostRule>) {
    setRules((rs) => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  async function save() {
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/bank-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_post_fee_rules: rules }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || `HTTP ${r.status}`); return; }
      onSaved();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  async function runDry() {
    setRunResult("Running…");
    try {
      const r = await fetch(`/api/cron/bank-auto-post-fees?bank_account_id=${account.id}&dry_run=true`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) { setRunResult(`Error: ${data.error || `HTTP ${r.status}`}`); return; }
      const acct = (data.per_account || [])[0];
      const matched = acct ? acct.matched_in_dry_run.length : 0;
      setRunResult(`Would auto-post ${matched} transaction(s). Scanned ${acct?.txns_scanned ?? 0} unmatched rows.`);
    } catch (e: unknown) { setRunResult(`Error: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async function runNow() {
    if (!(await confirmDialog(`Run auto-post on ${account.name} now? This will POST journal entries for any matching unmatched transactions. Make sure to dry-run first.`))) return;
    setRunResult("Running…");
    try {
      const r = await fetch(`/api/cron/bank-auto-post-fees?bank_account_id=${account.id}`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) { setRunResult(`Error: ${data.error || `HTTP ${r.status}`}`); return; }
      const acct = (data.per_account || [])[0];
      setRunResult(`Auto-posted ${acct?.posted ?? 0} transaction(s). Errors: ${acct?.errors?.length ?? 0}.`);
    } catch (e: unknown) { setRunResult(`Error: ${e instanceof Error ? e.message : String(e)}`); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(95vw, 980px)", maxHeight: "90vh", overflowY: "auto", color: C.text }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Auto-post fee rules — {account.name}</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
          Rules run nightly (16:00 UTC) against this account's unmatched transactions.
          First match wins (top-to-bottom). On match, a 2-line JE is posted via{" "}
          <code>bank_create_je_for_transaction</code> and the txn flips to <strong>manual_je_created</strong>.
        </div>

        {loading ? (
          <div style={{ color: C.textMuted, padding: 12 }}>Loading…</div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                <th style={{ ...th, width: 28 }}>#</th>
                <th style={th}>Match (regex, case-insens.)</th>
                <th style={th}>Direction</th>
                <th style={{ ...th, textAlign: "right" }}>Max amt (¢)</th>
                <th style={th}>Target GL account</th>
                <th style={th}>Label</th>
                <th style={{ ...th, width: 40 }}></th>
              </tr></thead>
              <tbody>
                {rules.length === 0 && (
                  <tr><td colSpan={7} style={{ ...td, color: C.textMuted, textAlign: "center", padding: 18 }}>
                    No rules. Click "Add rule" to define one.
                  </td></tr>
                )}
                {rules.map((r, i) => (
                  <tr key={i}>
                    <td style={{ ...td, color: C.textMuted }}>{i + 1}</td>
                    <td style={td}>
                      <input type="text" value={r.match} onChange={(e) => updateRule(i, { match: e.target.value })}
                             style={{ ...inputStyle, width: "100%", fontFamily: "monospace", fontSize: 12 }}
                             placeholder="e.g. ^MONTHLY SERVICE FEE" />
                    </td>
                    <td style={td}>
                      <SearchableSelect
                        value={r.direction}
                        onChange={(v) => updateRule(i, { direction: v as AutoPostRule["direction"] })}
                        options={[
                          { value: "both", label: "both" },
                          { value: "deposit", label: "deposit" },
                          { value: "withdrawal", label: "withdrawal" },
                        ]}
                        inputStyle={{ ...inputStyle, padding: "4px 6px" }}
                      />
                    </td>
                    <td style={td}>
                      <input type="number" value={r.max_amount_cents ?? ""} onChange={(e) => updateRule(i, { max_amount_cents: e.target.value === "" ? null : Math.max(0, Math.round(Number(e.target.value))) })}
                             style={{ ...inputStyle, width: 100, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                             placeholder="none" min={1} />
                    </td>
                    <td style={td}>
                      <SearchableSelect
                        value={r.target_account_id || null}
                        onChange={(v) => updateRule(i, { target_account_id: v })}
                        options={[
                          { value: "", label: "— pick an account —" },
                          ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                        ]}
                        placeholder="— pick an account —"
                        inputStyle={{ fontSize: 11 }}
                      />
                    </td>
                    <td style={td}>
                      <input type="text" value={r.label ?? ""} onChange={(e) => updateRule(i, { label: e.target.value || null })}
                             style={{ ...inputStyle, width: "100%" }} placeholder="optional" maxLength={80} />
                    </td>
                    <td style={td}>
                      <button onClick={() => delRule(i)} style={btnWarn} title="Delete rule">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={addRule} style={btnSecondary}>+ Add rule</button>
              <button onClick={() => void runDry()} style={btnSecondary} disabled={rules.length === 0}>Dry-run on this account</button>
              <button onClick={() => void runNow()} style={btnSecondary} disabled={rules.length === 0}>Run now</button>
            </div>
            {runResult && (
              <div style={{ marginTop: 10, fontSize: 12, color: runResult.startsWith("Error") ? C.danger : C.textSub, background: "#0b1220", border: `1px solid ${C.cardBdr}`, padding: "8px 10px", borderRadius: 6 }}>
                {runResult}
              </div>
            )}
          </>
        )}

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, margin: "12px 0", fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button onClick={onClose} style={btnSecondary} disabled={saving}>Cancel</button>
          <button onClick={() => void save()} style={btnPrimary} disabled={saving || loading}>{saving ? "Saving…" : "Save rules"}</button>
        </div>
      </div>
    </div>
  );
}

function TransactionsTab() {
  const [rows, setRows] = useState<BankTxn[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filterAcct, setFilterAcct] = useState("");
  const [filterStatus, setFilterStatus] = useState<BankTxn["status"] | "all">("unmatched");
  const [matchModal, setMatchModal] = useState<BankTxn | null>(null);
  const [createJeModal, setCreateJeModal] = useState<BankTxn | null>(null);
  // Drill-through Phase 2 — jump to the matched JE / the bank account's ledger.
  const [jeSeed, setJeSeed] = useState<JEDetailSeed | null>(null);
  const [glTarget, setGlTarget] = useState<GLDetailTarget | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TXN_TABLE_KEY, TXN_COLUMNS);

  // Open the bank account's GL detail windowed around the txn date (±7 days) —
  // for unmatched rows this is the "find the counterpart JE" view.
  function openGlWindow(r: BankTxn) {
    const glId = r.bank_accounts?.gl_account_id;
    if (!glId) { notify("This bank account has no GL account linked.", "error"); return; }
    const shift = (iso: string, days: number) => {
      const d = new Date(iso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    setGlTarget({
      accountId: glId,
      code: r.bank_accounts?.gl_accounts?.code || null,
      name: r.bank_accounts?.gl_accounts?.name || r.bank_accounts?.name || null,
      from: shift(r.posted_date, -7),
      to: shift(r.posted_date, 7),
      basis: "ACCRUAL",
    });
  }

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [aResp, tResp] = await Promise.all([
        fetch("/api/internal/bank-accounts"),
        (() => {
          const params = new URLSearchParams({ status: filterStatus, limit: "500" });
          if (filterAcct) params.set("bank_account_id", filterAcct);
          return fetch(`/api/internal/bank-transactions?${params.toString()}`);
        })(),
      ]);
      if (!aResp.ok) throw new Error("bank_accounts list failed");
      if (!tResp.ok) throw new Error((await tResp.json().catch(() => ({}))).error || `HTTP ${tResp.status}`);
      setAccounts(await aResp.json() as BankAccount[]);
      setRows(await tResp.json() as BankTxn[]);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [filterAcct, filterStatus]);

  async function applyMatch(txn: BankTxn, je_line_id: string) {
    try {
      const r = await fetch(`/api/internal/bank-transactions/${txn.id}/apply-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ je_line_id }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        notify(`Match failed: ${e.error || `HTTP ${r.status}`}`, "error");
        return;
      }
      setMatchModal(null);
      await load();
    } catch (e: unknown) { notify(`Match failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }
  async function unmatch(txn: BankTxn) {
    if (!(await confirmDialog("Unmatch this transaction? The JE stays posted; only the bank ↔ JE link is severed."))) return;
    try {
      const r = await fetch(`/api/internal/bank-transactions/${txn.id}/unmatch`, { method: "POST" });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Unmatch failed: ${e.error}`, "error"); return; }
      await load();
    } catch (e: unknown) { notify(`Unmatch failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }
  async function ignore(txn: BankTxn) {
    const reason = prompt("Reason for ignoring (e.g. duplicate Plaid pull, test transaction):");
    if (!reason) return;
    try {
      const r = await fetch(`/api/internal/bank-transactions/${txn.id}/ignore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); notify(`Ignore failed: ${e.error}`, "error"); return; }
      await load();
    } catch (e: unknown) { notify(`Ignore failed: ${e instanceof Error ? e.message : String(e)}`, "error"); }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect
            value={filterAcct || null}
            onChange={(v) => setFilterAcct(v)}
            options={[
              { value: "", label: "All accounts" },
              ...accounts.map((a) => ({ value: a.id, label: `${a.name}${a.mask ? ` ••${a.mask}` : ""}` })),
            ]}
            placeholder="All accounts"
          />
        </div>
        <SearchableSelect
          value={filterStatus}
          onChange={(v) => setFilterStatus(v as BankTxn["status"] | "all")}
          options={[
            { value: "unmatched", label: `Unmatched (${counts.unmatched || 0})` },
            { value: "matched", label: `Matched (${counts.matched || 0})` },
            { value: "manual_je_created", label: `Manual JE (${counts.manual_je_created || 0})` },
            { value: "ignored", label: `Ignored (${counts.ignored || 0})` },
            { value: "reversed", label: `Reversed (${counts.reversed || 0})` },
            { value: "all", label: `All (${rows.length})` },
          ]}
          inputStyle={inputStyle}
        />
        <button onClick={() => void load()} style={btnSecondary}>Refresh</button>
        <ExportButton
          rows={rows.map((r) => ({
            ...r,
            account_name: r.bank_accounts?.name || r.bank_account_id,
            account_mask: r.bank_accounts?.mask || null,
            description_display: r.merchant_name || r.description,
          })) as unknown as Array<Record<string, unknown>>}
          filename="bank-transactions"
          sheetName="Bank Transactions"
          columns={[
            { key: "posted_date",         header: "Date",        format: "date" },
            { key: "account_name",        header: "Account" },
            { key: "account_mask",        header: "Mask" },
            { key: "description_display", header: "Description" },
            { key: "merchant_name",       header: "Merchant" },
            { key: "amount_cents",        header: "Amount",      format: "currency_cents" },
            { key: "status",              header: "Status" },
            { key: "match_confidence",    header: "Confidence %", format: "number" },
            { key: "external_txn_id",     header: "External Txn ID" },
            { key: "pending",             header: "Pending" },
            { key: "notes",               header: "Notes" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
        <TablePrefsButton
          tableKey={TXN_TABLE_KEY}
          columns={TXN_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
        <span style={{ marginLeft: "auto", fontSize: 11, color: C.textMuted }}>{rows.length} row{rows.length === 1 ? "" : "s"}</span>
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>Error: {err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, maxHeight: "calc(100vh - 240px)", overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, color: C.textMuted, textAlign: "center" }}>
            No {filterStatus === "all" ? "" : filterStatus} transactions. Try a different filter or wait for the next Plaid sync.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th} hidden={!visibleColumns.has("date")}>Date</th>
              <th style={th} hidden={!visibleColumns.has("account")}>Account</th>
              <th style={th} hidden={!visibleColumns.has("description")}>Description</th>
              <th style={{ ...th, textAlign: "right" }} hidden={!visibleColumns.has("amount")}>Amount</th>
              <th style={th} hidden={!visibleColumns.has("status")}>Status</th>
              <th style={{ ...th, width: 280 }}>Actions</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.pending ? { opacity: 0.5 } : {}}>
                  <td style={td} hidden={!visibleColumns.has("date")}>{r.posted_date}</td>
                  <td style={{ ...td, fontSize: 11, color: C.textMuted }} hidden={!visibleColumns.has("account")}>
                    {r.bank_accounts?.name || "—"}
                    {r.bank_accounts?.mask ? ` ••${r.bank_accounts.mask}` : ""}
                  </td>
                  <td style={td} hidden={!visibleColumns.has("description")}>{r.merchant_name || r.description || "—"}</td>
                  <td style={{ ...tdNum, color: r.amount_cents >= 0 ? C.success : C.danger, fontWeight: 600 }} hidden={!visibleColumns.has("amount")}>
                    {fmtCents(r.amount_cents)}
                  </td>
                  <td style={{ ...td, color: STATUS_COLOR[r.status], fontWeight: 600 }} hidden={!visibleColumns.has("status")}>
                    {r.status}{r.match_confidence != null ? ` (${r.match_confidence}%)` : ""}
                  </td>
                  <td style={td}>
                    {r.status === "unmatched" && (
                      <>
                        <button style={btnPrimary} onClick={() => setMatchModal(r)}>Match</button>
                        <button style={btnSecondary} onClick={() => setCreateJeModal(r)}>Create JE</button>
                        <button style={btnWarn} onClick={() => void ignore(r)}>Ignore</button>
                      </>
                    )}
                    {r.status === "matched" && (
                      <button style={btnSecondary} onClick={() => void unmatch(r)}>Unmatch</button>
                    )}
                    {r.matched_je && (
                      <button
                        style={{ ...btnSecondary, color: C.primary }}
                        onClick={() => setJeSeed({ id: r.matched_je!.id, je_number: r.matched_je!.je_number, description: r.matched_je!.description })}
                        title="Open the matched journal entry"
                      >
                        JE {r.matched_je.je_number || ""}
                      </button>
                    )}
                    {r.bank_accounts?.gl_account_id && (
                      <button
                        style={btnSecondary}
                        onClick={() => openGlWindow(r)}
                        title={r.status === "unmatched"
                          ? "Open the bank account's GL ledger ±7 days around this date to find the counterpart entry"
                          : "Open the bank account's GL ledger ±7 days around this date"}
                      >
                        GL ▸
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {matchModal && (
        <MatchCandidateModal
          txn={matchModal}
          onClose={() => setMatchModal(null)}
          onPick={(je_line_id) => applyMatch(matchModal, je_line_id)}
        />
      )}
      {createJeModal && (
        <CreateJeModal
          txn={createJeModal}
          onClose={() => setCreateJeModal(null)}
          onDone={() => { setCreateJeModal(null); void load(); }}
        />
      )}
      {jeSeed && (
        <JEDetailModal
          je={jeSeed}
          onClose={() => setJeSeed(null)}
          onReversed={() => { setJeSeed(null); void load(); }}
        />
      )}
      {glTarget && <GLDetailModal target={glTarget} onClose={() => setGlTarget(null)} />}
    </div>
  );
}

function MatchCandidateModal({ txn, onClose, onPick }: { txn: BankTxn; onClose: () => void; onPick: (je_line_id: string) => void }) {
  const [cands, setCands] = useState<MatchCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/internal/bank-transactions/${txn.id}/match-candidates`);
        if (r.ok) setCands(await r.json() as MatchCandidate[]);
      } finally { setLoading(false); }
    })();
  }, [txn.id]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(900px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Pick a matching JE line</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          {txn.posted_date} · {fmtCents(txn.amount_cents)} · {txn.description || txn.merchant_name || "(no description)"}
        </div>
        {loading ? (
          <div style={{ color: C.textMuted, padding: 12 }}>Loading candidates…</div>
        ) : cands.length === 0 ? (
          <div style={{ color: C.textMuted, padding: 12 }}>
            No exact-amount candidates within ±5 days. Use <strong>Create JE</strong> for a standalone transaction (bank fee / interest / transfer).
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Conf</th>
              <th style={th}>JE Date</th>
              <th style={th}>Days</th>
              <th style={th}>Account</th>
              <th style={th}>JE Description</th>
              <th style={{ ...th, textAlign: "right" }}>Amount</th>
              <th style={th}></th>
            </tr></thead>
            <tbody>
              {cands.map((c) => (
                <tr key={c.je_line_id}>
                  <td style={{ ...td, color: c.confidence >= 90 ? C.success : c.confidence >= 70 ? C.warn : C.textMuted, fontWeight: 700 }}>
                    {c.confidence}%
                  </td>
                  <td style={td}>{c.je_date}</td>
                  <td style={td}>{c.days_apart}</td>
                  <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>{c.account_code} {c.account_name}</td>
                  <td style={td}>{c.je_description || "—"}</td>
                  <td style={tdNum}>{fmtCents(c.je_amount_cents)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button style={btnPrimary} onClick={() => onPick(c.je_line_id)}>Match</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}

function CreateJeModal({ txn, onClose, onDone }: { txn: BankTxn; onClose: () => void; onDone: () => void }) {
  const [targetAccount, setTargetAccount] = useState("");
  const [accounts, setAccounts] = useState<Array<{ id: string; code: string; name: string; account_type: string }>>([]);
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/internal/gl-accounts?limit=500");
        if (r.ok) {
          const data = await r.json();
          setAccounts((Array.isArray(data) ? data : []).filter((a: { is_postable?: boolean }) => a.is_postable !== false));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  async function submit() {
    if (!targetAccount) { setErr("Pick a target GL account"); return; }
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/bank-transactions/${txn.id}/create-je`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_gl_account_id: targetAccount, memo: memo || null }),
      });
      const data = await r.json();
      if (!r.ok) { setErr(data.error || `HTTP ${r.status}`); return; }
      onDone();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  const hint = txn.amount_cents >= 0
    ? "Deposit (e.g. interest income, refund, transfer in) — DR bank / CR target account."
    : "Withdrawal (e.g. bank fee, transfer out) — CR bank / DR target account.";

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(640px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Create JE for standalone transaction</h3>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          {txn.posted_date} · {fmtCents(txn.amount_cents)} · {txn.description || txn.merchant_name || "(no description)"}
          <div style={{ marginTop: 4 }}>{hint}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Target GL Account</div>
          <SearchableSelect
            value={targetAccount || null}
            onChange={(v) => setTargetAccount(v)}
            options={[
              { value: "", label: "— pick an account —" },
              ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name} (${a.account_type})` })),
            ]}
            placeholder="— pick an account —"
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase" }}>Memo (optional)</div>
          <input type="text" value={memo} onChange={(e) => setMemo(e.target.value)} style={{ ...inputStyle, width: "100%" }} placeholder={txn.description || "Operator note"} />
        </div>
        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !targetAccount}>
            {submitting ? "Posting…" : "Post JE"}
          </button>
        </div>
      </div>
    </div>
  );
}
