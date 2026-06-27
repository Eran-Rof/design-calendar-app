import { useEffect, useMemo, useState } from "react";
import { B } from "./theme";
import { apiB2B } from "./apiB2B";
import { formatMoney } from "./useCart";
import type { AccountView, AccountInvoice } from "./types";
import SearchableSelect from "../tanda/components/SearchableSelect";

// P18-E — Account: open AR balance + invoices (status-filterable). All data is
// scoped server-side to the logged-in buyer's customer.
export default function B2BAccount() {
  const [view, setView] = useState<AccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        setView(await apiB2B<AccountView>("/api/b2b/account"));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load account");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const statuses = useMemo(() => {
    const s = new Set<string>();
    for (const inv of view?.invoices || []) s.add(inv.gl_status);
    return [...s].sort();
  }, [view]);

  const rows: AccountInvoice[] = (view?.invoices || []).filter(
    (inv) => !statusFilter || inv.gl_status === statusFilter,
  );

  if (loading) return <div style={{ color: B.textMuted, fontSize: 14, padding: "24px 0" }}>Loading account…</div>;
  if (err) return <div style={errBox}>{err}</div>;
  if (!view) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <section style={panel}>
        <div style={{ fontSize: 13, color: B.textMuted }}>Open balance</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: view.open_balance_cents > 0 ? B.text : "#065F46", marginTop: 4 }}>
          {formatMoney(view.open_balance_cents, view.currency)}
        </div>
        {view.customer.name && (
          <div style={{ fontSize: 13, color: B.textSub, marginTop: 6 }}>{view.customer.name}</div>
        )}
      </section>

      <section style={panel}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <h2 style={h2}>Invoices</h2>
          <SearchableSelect
            theme="light"
            value={statusFilter || null}
            onChange={(v) => setStatusFilter(v)}
            options={[
              { value: "", label: "All statuses" },
              ...statuses.map((s) => ({ value: s, label: s })),
            ]}
            inputStyle={input}
          />
        </div>

        {rows.length === 0 ? (
          <p style={{ color: B.textMuted, fontSize: 14, marginTop: 12 }}>No invoices to show.</p>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Invoice</th>
                <th style={th}>Date</th>
                <th style={th}>Due</th>
                <th style={th}>Status</th>
                <th style={thR}>Total</th>
                <th style={thR}>Paid</th>
                <th style={thR}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id}>
                  <td style={td}>{inv.invoice_number}</td>
                  <td style={td}>{(inv.invoice_date || "").slice(0, 10)}</td>
                  <td style={td}>{(inv.due_date || "").slice(0, 10) || "—"}</td>
                  <td style={td}>
                    <span style={badge}>{inv.gl_status}</span>
                  </td>
                  <td style={tdR}>{formatMoney(inv.total_amount_cents, view.currency)}</td>
                  <td style={tdR}>{formatMoney(inv.paid_amount_cents, view.currency)}</td>
                  <td style={{ ...tdR, fontWeight: 600, color: inv.balance_cents > 0 ? B.text : B.textMuted }}>
                    {formatMoney(inv.balance_cents, view.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const panel: React.CSSProperties = {
  background: B.surface, border: `1px solid ${B.border}`, borderRadius: 12,
  padding: 22, boxShadow: `0 1px 3px ${B.shadow}`,
};
const h2: React.CSSProperties = { margin: 0, fontSize: 17, color: B.text };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 14 };
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${B.border}`, color: B.textMuted, fontSize: 12, fontWeight: 600 };
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "10px", borderBottom: `1px solid ${B.surfaceAlt}`, color: B.text };
const tdR: React.CSSProperties = { ...td, textAlign: "right" };
const input: React.CSSProperties = {
  padding: "9px 11px", borderRadius: 8, border: `1px solid ${B.border}`,
  fontSize: 14, fontFamily: "inherit", background: B.surface, color: B.text, boxSizing: "border-box",
};
const badge: React.CSSProperties = {
  display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
  background: B.surfaceAlt, color: B.textSub, border: `1px solid ${B.border}`, textTransform: "capitalize",
};
const errBox: React.CSSProperties = {
  color: B.danger, fontSize: 13, padding: "10px 12px",
  background: B.dangerBg, border: `1px solid ${B.dangerBdr}`, borderRadius: 8,
};
