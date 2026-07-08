// src/tanda/InternalCashFlow.tsx
//
// Tangerine P5-5 — Cash Flow Statement admin panel (indirect method).
// Reads /api/internal/cash-flow?basis=...&from=...&to=...
//
// Layout:
//   - Top controls: basis toggle (ACCRUAL/CASH) + from-date + to-date.
//   - Three collapsible sections — Operating / Investing / Financing.
//   - Operating section detailed (Net Income, ΔAR, ΔInv, ΔAP, subtotal).
//   - Investing + Financing show 1 placeholder row + a small "Configure
//     account tagging in P22+" note.
//   - Footer reconciliation block:
//       Beginning Cash + Net Change = Ending Cash
//     With a sanity-check yellow warning if they don't tie within $0.01.
//
// The handler emits two _cash_reference rows (Beginning Cash, Ending Cash)
// so the panel doesn't need a separate /api/internal/balance-sheet roundtrip.

import { useEffect, useState } from "react";
import { useSeqGuard } from "./hooks/useSeqGuard";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import DateRangePresets from "./components/DateRangePresets.tsx";

type Row = {
  section: string;
  line_item: string;
  amount_cents: number;
};

type Response = {
  basis: "ACCRUAL" | "CASH";
  from: string;
  to: string;
  rows: Row[];
};

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  warnBg: "#78350F",
};

const btnSecondary: React.CSSProperties = {
  background: C.card, color: C.textSub, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`,
  padding: "6px 10px", borderRadius: 4, fontSize: 13,
};

const SECTION_META: Record<string, { label: string; emoji: string }> = {
  operating: { label: "Operating Activities", emoji: "" },
  investing: { label: "Investing Activities", emoji: "" },
  financing: { label: "Financing Activities", emoji: "" },
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0);
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / 100);
  const frac = abs - whole * 100;
  return `${neg ? "-" : ""}$${whole.toLocaleString()}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function fyStartISO(): string {
  const y = new Date().getUTCFullYear();
  return `${y}-01-01`;
}

export default function InternalCashFlow() {
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH">("ACCRUAL");
  const [from, setFrom] = useState<string>(fyStartISO());
  const [to, setTo] = useState<string>(todayISO());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    operating: false, investing: false, financing: false,
  });

  // Fetch-race guard: only the latest load()'s result may be applied.
  const seqGuard = useSeqGuard();

  async function load() {
    const seq = seqGuard.begin();
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set("basis", basis);
      params.set("from", from);
      params.set("to", to);
      const r = await fetch(`/api/internal/cash-flow?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = (await r.json()) as Response;
      if (!seqGuard.isCurrent(seq)) return; // superseded by a newer load — drop stale result
      setRows(data.rows || []);
    } catch (e: unknown) {
      if (seqGuard.isCurrent(seq)) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seqGuard.isCurrent(seq)) setLoading(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Partition rows by section. _cash_reference rows are pulled out for the
  // footer reconciliation block.
  const sectionRows: Record<string, Row[]> = { operating: [], investing: [], financing: [] };
  let beginningCash = 0;
  let endingCash = 0;

  for (const r of rows) {
    if (r.section === "_cash_reference") {
      if (r.line_item === "Beginning Cash") beginningCash = r.amount_cents;
      else if (r.line_item === "Ending Cash") endingCash = r.amount_cents;
    } else if (sectionRows[r.section]) {
      sectionRows[r.section].push(r);
    }
  }

  // Net change = sum of each section's last row (the subtotal line). Defensively
  // walk by `Net cash from` prefix in case the RPC emits more details later.
  const sectionNet = (sec: string): number => {
    const list = sectionRows[sec] || [];
    const sub = list.find((r) => r.line_item.toLowerCase().startsWith("net cash from"));
    return sub ? sub.amount_cents : 0;
  };

  const netChange = sectionNet("operating") + sectionNet("investing") + sectionNet("financing");
  const computedEnding = beginningCash + netChange;
  const reconciliationGap = Math.abs(computedEnding - endingCash);
  const reconciliationOk = reconciliationGap < 1; // within 1 cent

  function toggleSection(key: string) {
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Cash Flow Statement (indirect)</h2>
        <div style={{ fontSize: 11, color: C.textMuted }}>
          basis: <strong>{basis}</strong> · {from} → {to}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "inline-flex", border: `1px solid ${C.cardBdr}`, borderRadius: 6, overflow: "hidden" }}>
          {(["ACCRUAL", "CASH"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBasis(b)}
              style={{
                background: basis === b ? C.primary : C.card,
                color: basis === b ? "white" : C.textSub,
                border: "none",
                padding: "6px 14px",
                fontSize: 12,
                cursor: "pointer",
                fontWeight: basis === b ? 700 : 400,
              }}
            >
              {b}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          From:
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          To:
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        </label>
        <DateRangePresets variant="dropdown"
          from={from}
          to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }}
        />
        <button onClick={() => void load()} style={{ ...btnSecondary, background: C.primary, color: "white", borderColor: C.primary }}>
          Run
        </button>
        <ExportButton
          rows={(() => {
            const out: Array<Record<string, unknown>> = [];
            for (const sec of ["operating", "investing", "financing"] as const) {
              for (const r of sectionRows[sec]) {
                const isSubtotal = r.line_item.toLowerCase().startsWith("net cash from");
                out.push({
                  section: SECTION_META[sec].label,
                  kind: isSubtotal ? "subtotal" : "row",
                  line_item: r.line_item,
                  amount_cents: r.amount_cents,
                });
              }
            }
            out.push({ section: "Reconciliation", kind: "row", line_item: "Beginning Cash", amount_cents: beginningCash });
            out.push({ section: "Reconciliation", kind: "subtotal", line_item: "Net Change in Cash", amount_cents: netChange });
            out.push({ section: "Reconciliation", kind: "total", line_item: "Ending Cash", amount_cents: endingCash });
            return out;
          })()}
          filename={`cash-flow-${basis}-${from}-to-${to}`}
          sheetName="Cash Flow"
          columns={[
            { key: "section",      header: "Section" },
            { key: "kind",         header: "Kind" },
            { key: "line_item",    header: "Line Item" },
            { key: "amount_cents", header: "Amount", format: "currency_cents" },
          ] as ExportColumn<Record<string, unknown>>[]}
        />
      </div>

      {err && (
        <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12 }}>
          Error: {err}
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 16 }}>
        {loading ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>Loading…</div>
        ) : (
          <>
            {(["operating", "investing", "financing"] as const).map((sec) => {
              const meta = SECTION_META[sec];
              const list = sectionRows[sec];
              const isCollapsed = collapsed[sec];
              return (
                <div key={sec} style={{ marginBottom: 18 }}>
                  <button
                    onClick={() => toggleSection(sec)}
                    style={{
                      width: "100%",
                      background: "#0b1220",
                      color: C.text,
                      border: `1px solid ${C.cardBdr}`,
                      borderRadius: 6,
                      padding: "8px 12px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    <span>
                      <span style={{ marginRight: 8 }}>{isCollapsed ? "▶" : "▼"}</span>
                      {meta.label}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: C.textSub }}>
                      {fmtCents(sectionNet(sec))}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
                      <tbody>
                        {list.length === 0 ? (
                          <tr>
                            <td colSpan={2} style={{ padding: "8px 12px", color: C.textMuted, fontSize: 12 }}>
                              No data.
                            </td>
                          </tr>
                        ) : list.map((r, i) => {
                          const isSubtotal = r.line_item.toLowerCase().startsWith("net cash from");
                          return (
                            <tr key={`${sec}-${i}`} style={{ borderTop: isSubtotal ? `1px solid ${C.cardBdr}` : undefined }}>
                              <td style={{
                                padding: "6px 12px",
                                color: isSubtotal ? C.text : C.textSub,
                                fontSize: 13,
                                fontWeight: isSubtotal ? 700 : 400,
                                paddingLeft: 28,
                              }}>
                                {r.line_item}
                              </td>
                              <td style={{
                                padding: "6px 12px",
                                color: isSubtotal ? C.text : C.textSub,
                                fontSize: 13,
                                fontWeight: isSubtotal ? 700 : 400,
                                textAlign: "right",
                                fontVariantNumeric: "tabular-nums",
                              }}>
                                {fmtCents(r.amount_cents)}
                              </td>
                            </tr>
                          );
                        })}
                        {(sec === "investing" || sec === "financing") && (
                          <tr>
                            <td colSpan={2} style={{
                              padding: "6px 12px 6px 28px",
                              color: C.textMuted,
                              fontSize: 11,
                              fontStyle: "italic",
                            }}>
                              Configure account tagging in P22+.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}

            {/* Footer reconciliation block */}
            <div style={{
              marginTop: 24,
              borderTop: `2px solid ${C.cardBdr}`,
              paddingTop: 12,
            }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "6px 12px", color: C.textSub, fontSize: 13 }}>Beginning Cash</td>
                    <td style={{ padding: "6px 12px", color: C.textSub, fontSize: 13, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtCents(beginningCash)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 12px", color: C.textSub, fontSize: 13 }}>+ Net Change in Cash</td>
                    <td style={{ padding: "6px 12px", color: C.textSub, fontSize: 13, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtCents(netChange)}
                    </td>
                  </tr>
                  <tr style={{ borderTop: `1px solid ${C.cardBdr}`, background: "#0b1220" }}>
                    <td style={{ padding: "8px 12px", color: C.text, fontSize: 14, fontWeight: 700 }}>= Ending Cash</td>
                    <td style={{ padding: "8px 12px", color: C.text, fontSize: 14, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmtCents(endingCash)}
                    </td>
                  </tr>
                  {!reconciliationOk && (
                    <tr style={{ background: C.warnBg }}>
                      <td style={{ padding: "8px 12px", color: "white", fontSize: 12, fontWeight: 600 }}>
                        Reconciliation gap — investigate (Beginning + Net Change ≠ Ending)
                      </td>
                      <td style={{ padding: "8px 12px", color: "white", fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        gap: {fmtCents(computedEnding - endingCash)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div style={{ marginTop: 6, padding: "0 12px", color: C.textMuted, fontSize: 11 }}>
                Cash accounts identified by heuristic: account_type=&apos;asset&apos; AND code starts with &apos;1&apos; AND name ILIKE &apos;%cash%&apos; OR &apos;%bank%&apos;.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
