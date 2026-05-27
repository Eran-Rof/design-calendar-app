// src/tanda/InternalJournalEntry.tsx
//
// Tangerine P1 Chunk 8c — Journal Entry list + manual post + reverse.
// Wraps the GET/POST /api/internal/journal-entries endpoints and the
// /reverse action. Multi-line entry with live balance check, basis
// selector (ACCRUAL | CASH | BOTH), and inline subledger entry per line.

import { useEffect, useMemo, useState } from "react";

type JELine = {
  id?: string;
  line_number: number;
  account_id: string;
  debit: string;
  credit: string;
  memo: string;
  subledger_type: string;
  subledger_id: string;
};

type JE = {
  id: string;
  basis: "ACCRUAL" | "CASH";
  journal_type: string;
  posting_date: string;
  source_module: string;
  source_table: string | null;
  source_id: string | null;
  description: string;
  status: "draft" | "posted" | "reversed";
  posted_at: string | null;
  sibling_je_id: string | null;
  reverses_je_id: string | null;
  reversed_by_je_id: string | null;
  created_at: string;
};

type Account = {
  id: string;
  code: string;
  name: string;
  account_type: string;
  is_postable: boolean;
  is_control: boolean;
  status: string;
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

export default function InternalJournalEntry() {
  const [rows, setRows] = useState<JE[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basisFilter, setBasisFilter] = useState("");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [postOpen, setPostOpen] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (basisFilter) params.set("basis", basisFilter);
      if (includeDrafts) params.set("include_drafts", "true");
      const r = await fetch(`/api/internal/journal-entries?${params.toString()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as JE[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [basisFilter, includeDrafts]);

  async function reverse(je: JE) {
    if (je.status !== "posted") {
      alert(`Cannot reverse JE in status '${je.status}'.`);
      return;
    }
    const reason = prompt(`Reverse JE "${je.description}"? Optionally enter a different posting_date (YYYY-MM-DD), or leave blank for today:`, "");
    if (reason === null) return;
    try {
      const body: Record<string, unknown> = {};
      if (reason.trim() && /^\d{4}-\d{2}-\d{2}$/.test(reason.trim())) {
        body.posting_date = reason.trim();
      }
      const r = await fetch(`/api/internal/journal-entries/${je.id}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      await load();
    } catch (e: unknown) {
      alert(`Reverse failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Journal Entries</h2>
        <button onClick={() => setPostOpen(true)} style={btnPrimary}>+ Post manual JE</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <select value={basisFilter} onChange={(e) => setBasisFilter(e.target.value)} style={{ ...inputStyle, width: 200 }}>
          <option value="">All bases</option>
          <option value="ACCRUAL">ACCRUAL</option>
          <option value="CASH">CASH</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
          Include drafts
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
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>No journal entries yet.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Posting Date</th>
                <th style={th}>Type</th>
                <th style={th}>Basis</th>
                <th style={th}>Description</th>
                <th style={th}>Source</th>
                <th style={th}>Status</th>
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((je) => (
                <tr key={je.id} style={je.status !== "posted" ? { opacity: 0.55 } : {}}>
                  <td style={td}>{je.posting_date}</td>
                  <td style={td}>{je.journal_type}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{je.basis}</td>
                  <td style={td}>{je.description}</td>
                  <td style={{ ...td, fontSize: 12, color: C.textMuted }}>{je.source_table || "—"}{je.source_id ? ` / ${je.source_id.slice(0, 8)}…` : ""}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(je.status), fontWeight: 600 }}>● {je.status}</span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {je.status === "posted" && (
                      <button onClick={() => void reverse(je)} style={btnDanger}>Reverse</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {postOpen && (
        <ManualJEModal onClose={() => setPostOpen(false)} onPosted={() => { setPostOpen(false); void load(); }} />
      )}
    </div>
  );
}

function statusColor(s: JE["status"]) {
  return s === "posted" ? C.success : s === "draft" ? C.textMuted : C.danger;
}

function ManualJEModal({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH" | "BOTH">("ACCRUAL");
  const [postingDate, setPostingDate] = useState(new Date().toISOString().slice(0, 10));
  const [journalType, setJournalType] = useState<"manual" | "adjustment">("manual");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<JELine[]>([
    { line_number: 1, account_id: "", debit: "", credit: "", memo: "", subledger_type: "", subledger_id: "" },
    { line_number: 2, account_id: "", debit: "", credit: "", memo: "", subledger_type: "", subledger_id: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=500")
      .then((r) => r.json())
      .then((a: Account[]) => setAccounts(a.filter((x) => x.status === "active" && x.is_postable)))
      .catch(() => {});
  }, []);

  const totals = useMemo(() => {
    let d = 0, c = 0;
    for (const l of lines) {
      const dn = parseFloat(l.debit  || "0"); if (Number.isFinite(dn)) d += dn;
      const cn = parseFloat(l.credit || "0"); if (Number.isFinite(cn)) c += cn;
    }
    return { d, c, diff: Math.round((d - c) * 100) / 100 };
  }, [lines]);

  function updateLine(idx: number, patch: Partial<JELine>) {
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }
  function addLine() {
    setLines((prev) => [...prev, { line_number: prev.length + 1, account_id: "", debit: "", credit: "", memo: "", subledger_type: "", subledger_id: "" }]);
  }
  function removeLine(idx: number) {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_number: i + 1 })));
  }

  async function submit() {
    setSubmitting(true);
    setErr(null);
    try {
      const body = {
        basis,
        posting_date: postingDate,
        description: description.trim(),
        journal_type: journalType,
        lines: lines.map((l) => ({
          line_number: l.line_number,
          account_id: l.account_id,
          debit: l.debit || "0",
          credit: l.credit || "0",
          memo: l.memo || null,
          subledger_type: l.subledger_type || null,
          subledger_id: l.subledger_id || null,
        })),
      };
      const r = await fetch("/api/internal/journal-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
        throw new Error(e);
      }
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const balanceOK = totals.diff === 0 && totals.d > 0;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, minWidth: 820, maxWidth: 1000, maxHeight: "90vh", overflowY: "auto", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>Post manual journal entry</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", gap: 12, marginBottom: 16 }}>
          <Field label="Basis">
            <select value={basis} onChange={(e) => setBasis(e.target.value as "ACCRUAL" | "CASH" | "BOTH")} style={inputStyle as React.CSSProperties}>
              <option value="ACCRUAL">ACCRUAL</option>
              <option value="CASH">CASH</option>
              <option value="BOTH">BOTH (sibling pair)</option>
            </select>
          </Field>
          <Field label="Journal type">
            <select value={journalType} onChange={(e) => setJournalType(e.target.value as "manual" | "adjustment")} style={inputStyle as React.CSSProperties}>
              <option value="manual">manual</option>
              <option value="adjustment">adjustment</option>
            </select>
          </Field>
          <Field label="Posting date">
            <input type="date" value={postingDate} onChange={(e) => setPostingDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Description">
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} placeholder="e.g. Adjusting entry for accrued rent" />
          </Field>
        </div>

        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 50 }}>#</th>
                <th style={th}>Account</th>
                <th style={{ ...th, width: 120 }}>Debit</th>
                <th style={{ ...th, width: 120 }}>Credit</th>
                <th style={th}>Memo</th>
                <th style={{ ...th, width: 100 }}>Sub type</th>
                <th style={{ ...th, width: 180 }}>Sub id</th>
                <th style={{ ...th, width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={idx}>
                  <td style={td}>{l.line_number}</td>
                  <td style={td}>
                    <select value={l.account_id} onChange={(e) => updateLine(idx, { account_id: e.target.value })} style={inputStyle as React.CSSProperties}>
                      <option value="">(pick…)</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}{a.is_control ? " [control]" : ""}</option>
                      ))}
                    </select>
                  </td>
                  <td style={td}>
                    <input type="text" value={l.debit} onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} placeholder="0.00" style={inputStyle} />
                  </td>
                  <td style={td}>
                    <input type="text" value={l.credit} onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} placeholder="0.00" style={inputStyle} />
                  </td>
                  <td style={td}>
                    <input type="text" value={l.memo} onChange={(e) => updateLine(idx, { memo: e.target.value })} style={inputStyle} />
                  </td>
                  <td style={td}>
                    <select value={l.subledger_type} onChange={(e) => updateLine(idx, { subledger_type: e.target.value })} style={inputStyle as React.CSSProperties}>
                      <option value="">(none)</option>
                      <option value="vendor">vendor</option>
                      <option value="customer">customer</option>
                      <option value="item">item</option>
                    </select>
                  </td>
                  <td style={td}>
                    <input type="text" value={l.subledger_id} onChange={(e) => updateLine(idx, { subledger_id: e.target.value })} placeholder="uuid" style={{ ...inputStyle, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }} />
                  </td>
                  <td style={td}>
                    {lines.length > 2 && <button onClick={() => removeLine(idx)} style={btnDanger}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#0b1220" }}>
                <td style={td} colSpan={2}>
                  <button onClick={addLine} style={btnSecondary}>+ Add line</button>
                </td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.d.toFixed(2)}</td>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.c.toFixed(2)}</td>
                <td style={td} colSpan={4}>
                  {totals.diff === 0 ? (
                    <span style={{ color: C.success, fontWeight: 600 }}>● Balanced</span>
                  ) : (
                    <span style={{ color: C.danger, fontWeight: 600 }}>● Out of balance by {totals.diff.toFixed(2)}</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button onClick={() => void submit()} style={btnPrimary} disabled={submitting || !balanceOK || !description.trim()}>
            {submitting ? "Posting…" : "Post"}
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
