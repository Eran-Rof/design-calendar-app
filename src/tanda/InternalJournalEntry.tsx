// src/tanda/InternalJournalEntry.tsx
//
// Tangerine P1 Chunk 8c — Journal Entry list + manual post + reverse.
// Wraps the GET/POST /api/internal/journal-entries endpoints and the
// /reverse action. Multi-line entry with live balance check, basis
// selector (ACCRUAL | CASH | BOTH), and inline subledger entry per line.

import React, { useEffect, useMemo, useState } from "react";
import DocumentAttachmentList from "../shared/documents/DocumentAttachmentList";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge, { SOURCE_OPTIONS } from "./components/SourceBadge";
// Cross-cutter T11-3 — audit-trail drop-in for the JE detail modal.
import RowHistory from "./components/RowHistory";

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

// Row shape returned by GET /api/internal/journal-entries/:id (lines table).
// Numeric columns arrive as strings from PostgREST for `numeric` types.
type JELineRow = {
  id: string;
  journal_entry_id: string;
  line_number: number;
  account_id: string;
  debit: string;
  credit: string;
  memo: string | null;
  subledger_type: string | null;
  subledger_id: string | null;
};

type JEWithLines = JE & { lines: JELineRow[] };

type ApprovalStep = {
  id: string;
  step_order: number;
  mode: "any" | "all";
  role_required: string;
  fulfilled_at: string | null;
  fulfilled_by_user_id: string | null;
  notes: string | null;
};

type ApprovalRequest = {
  id: string;
  entity_id: string;
  kind: string;
  context_table: string;
  context_id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  final_decided_at: string | null;
  created_at: string;
  steps: ApprovalStep[];
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
  source?: string | null;
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
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [detail, setDetail] = useState<JE | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (basisFilter) params.set("basis", basisFilter);
      if (sourceFilter) params.set("source", sourceFilter);
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

  useEffect(() => { void load(); }, [basisFilter, sourceFilter, includeDrafts]);

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
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          style={{ ...inputStyle, width: 180 }}
          title="Filter by row source — manual entries vs mirrored from Xoro / future integrations"
        >
          <option value="">All sources</option>
          {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
          Include drafts
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="journal-entries"
          sheetName="Journal Entries"
          columns={[
            { key: "posting_date",      header: "Posting Date", format: "date" },
            { key: "journal_type",      header: "Type" },
            { key: "basis",             header: "Basis" },
            { key: "description",       header: "Description" },
            { key: "source",            header: "Source" },
            { key: "source_module",     header: "Source Module" },
            { key: "source_table",      header: "Source Table" },
            { key: "source_id",         header: "Source ID" },
            { key: "status",            header: "Status" },
            { key: "posted_at",         header: "Posted At",       format: "datetime" },
            { key: "sibling_je_id",     header: "Sibling JE" },
            { key: "reverses_je_id",    header: "Reverses JE" },
            { key: "reversed_by_je_id", header: "Reversed By JE" },
            { key: "created_at",        header: "Created",         format: "datetime" },
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
                <tr
                  key={je.id}
                  onClick={() => setDetail(je)}
                  style={{
                    ...(je.status !== "posted" ? { opacity: 0.55 } : {}),
                    cursor: "pointer",
                  }}
                  title="Click to view details"
                >
                  <td style={td}>{je.posting_date}</td>
                  <td style={td}>{je.journal_type}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{je.basis}</td>
                  <td style={td}>
                    {je.description}
                    <SourceBadge source={je.source} />
                  </td>
                  <td style={{ ...td, fontSize: 12, color: C.textMuted }}>{je.source_table || "—"}{je.source_id ? ` / ${je.source_id.slice(0, 8)}…` : ""}</td>
                  <td style={td}>
                    <span style={{ color: statusColor(je.status), fontWeight: 600 }}>● {je.status}</span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {je.status === "posted" && !je.reversed_by_je_id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void reverse(je); }}
                        style={btnDanger}
                      >
                        Reverse
                      </button>
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

      {detail && (
        <JEDetailModal
          je={detail}
          onClose={() => setDetail(null)}
          onReversed={() => { setDetail(null); void load(); }}
          onReverseClick={(j) => void reverse(j)}
        />
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
            <select value={journalType} onChange={(e) => setJournalType(e.target.value as "manual" | "adjustment")} style={{ ...(inputStyle as React.CSSProperties), textTransform: "uppercase" }}>
              <option value="manual">MANUAL</option>
              <option value="adjustment">ADJUSTMENT</option>
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
                    <AccountSearchInput
                      accounts={accounts}
                      value={l.account_id}
                      onChange={(id) => updateLine(idx, { account_id: id })}
                    />
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

// Type-ahead account picker. Filters in-memory across `code` + `name`
// substring (case-insensitive). Persists the selected `account_id` on
// exact label match — otherwise leaves it blank until the operator picks
// from the dropdown. Closes on outside click + on selection.
function AccountSearchInput({
  accounts, value, onChange,
}: {
  accounts: Array<{ id: string; code: string; name: string; is_control: boolean }>;
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // When `value` is set externally, mirror its label into the query box.
  React.useEffect(() => {
    if (!value) { setQuery(""); return; }
    const a = accounts.find((x) => x.id === value);
    if (a) setQuery(`${a.code} — ${a.name}${a.is_control ? " [control]" : ""}`);
  }, [value, accounts]);

  // Close on outside click
  React.useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = accounts
    .filter((a) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
    })
    .slice(0, 50);

  return (
    <div ref={wrapRef} style={{ position: "relative", minWidth: 0 }}>
      <input
        type="text"
        value={query}
        placeholder="pick or type…"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          // Clear current selection if the typed text no longer matches the
          // previously-selected row's label exactly.
          if (value) {
            const a = accounts.find((x) => x.id === value);
            if (a) {
              const label = `${a.code} — ${a.name}${a.is_control ? " [control]" : ""}`;
              if (e.target.value !== label) onChange("");
            }
          }
        }}
        style={inputStyle}
      />
      {open && filtered.length > 0 && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
            background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 4,
            maxHeight: 240, overflowY: "auto", marginTop: 2,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
          }}
        >
          {filtered.map((a) => (
            <div
              key={a.id}
              onMouseDown={(e) => { e.preventDefault(); onChange(a.id); setOpen(false); }}
              style={{
                padding: "6px 10px", cursor: "pointer", fontSize: 13,
                color: a.is_control ? C.warn : C.text,
                borderBottom: `1px solid ${C.cardBdr}`,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#1e293b"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{a.code}</span>
              {" — "}{a.name}
              {a.is_control && <span style={{ color: C.warn, fontSize: 10, marginLeft: 6 }}>[control]</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// JE detail view modal — opens on row click. Read-only header + line table.
// Embeds DocumentAttachmentList for supporting docs (the only writable area).
// Reverse button delegates back to the parent so the existing reverse flow
// (prompt for posting_date + POST /reverse + reload) is reused unchanged.
function JEDetailModal({
  je, onClose, onReversed: _onReversed, onReverseClick,
}: {
  je: JE;
  onClose: () => void;
  onReversed: () => void;
  onReverseClick: (je: JE) => void;
}) {
  const [data, setData] = useState<JEWithLines | null>(null);
  const [accounts, setAccounts] = useState<Record<string, Account>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await fetch(`/api/internal/journal-entries/${je.id}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        const full = await r.json() as JEWithLines;
        if (cancelled) return;
        setData(full);

        // Look up account codes/names for the lines.
        // Single fetch with a generous limit — COA is small.
        try {
          const ar = await fetch("/api/internal/gl-accounts?limit=1000");
          if (ar.ok) {
            const list = await ar.json() as Account[];
            if (!cancelled) {
              const idx: Record<string, Account> = {};
              for (const a of list) idx[a.id] = a;
              setAccounts(idx);
            }
          }
        } catch { /* non-fatal — lines will fall back to raw account_id */ }

        // Best-effort approval history lookup. If the approval-requests
        // endpoint errors, swallow it and render a "no approval history" line.
        try {
          const params = new URLSearchParams();
          params.set("context_table", "journal_entries");
          params.set("context_id", je.id);
          const pr = await fetch(`/api/internal/approval-requests?${params.toString()}`);
          if (pr.ok) {
            const list = await pr.json() as ApprovalRequest[];
            if (!cancelled) setApprovals(Array.isArray(list) ? list : []);
          }
        } catch { /* non-fatal */ }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [je.id]);

  const totals = useMemo(() => {
    let d = 0, c = 0;
    for (const l of data?.lines || []) {
      const dn = parseFloat(l.debit || "0"); if (Number.isFinite(dn)) d += dn;
      const cn = parseFloat(l.credit || "0"); if (Number.isFinite(cn)) c += cn;
    }
    return { d, c };
  }, [data]);

  const canReverse = data?.status === "posted" && !data?.reversed_by_je_id;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 100, paddingTop: 40, paddingBottom: 40, overflowY: "auto" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: 720, maxWidth: "95vw", color: C.text }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            Journal entry detail
            <span style={{ marginLeft: 10, fontSize: 12, color: C.textMuted, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
              {je.id.slice(0, 8)}…
            </span>
          </h3>
          <span style={{ color: statusColor(data?.status || je.status), fontWeight: 600, fontSize: 13 }}>
            ● {data?.status || je.status}
          </span>
        </div>

        {loading && <div style={{ color: C.textMuted, fontSize: 13, padding: "12px 0" }}>Loading…</div>}

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        {data && (
          <>
            {/* Header section */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, fontSize: 13 }}>
              <DetailRow label="Posting date" value={data.posting_date} />
              <DetailRow label="Journal type" value={data.journal_type} />
              <DetailRow label="Basis" value={<span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{data.basis}</span>} />
              <DetailRow label="Source module" value={data.source_module || "—"} />
              <DetailRow
                label="Source ref"
                value={data.source_table
                  ? <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{data.source_table}{data.source_id ? ` / ${data.source_id.slice(0, 8)}…` : ""}</span>
                  : "—"}
              />
              <DetailRow
                label="Posted at"
                value={data.posted_at ? new Date(data.posted_at).toLocaleString() : "—"}
              />
              <DetailRow
                label="Sibling JE"
                value={data.sibling_je_id
                  ? <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{data.sibling_je_id.slice(0, 8)}…</span>
                  : "—"}
              />
              <DetailRow
                label="Reverses / reversed by"
                value={data.reverses_je_id
                  ? <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>reverses {data.reverses_je_id.slice(0, 8)}…</span>
                  : data.reversed_by_je_id
                    ? <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 12 }}>reversed by {data.reversed_by_je_id.slice(0, 8)}…</span>
                    : "—"}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Description</div>
              <div style={{ fontSize: 13 }}>{data.description || "—"}</div>
            </div>

            {/* Lines section */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines</div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 40 }}>#</th>
                    <th style={th}>Account</th>
                    <th style={{ ...th, width: 110, textAlign: "right" }}>Debit</th>
                    <th style={{ ...th, width: 110, textAlign: "right" }}>Credit</th>
                    <th style={th}>Memo</th>
                    <th style={{ ...th, width: 140 }}>Subledger</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.lines || []).map((l) => {
                    const acct = accounts[l.account_id];
                    return (
                      <tr key={l.id}>
                        <td style={td}>{l.line_number}</td>
                        <td style={{ ...td, fontSize: 12 }}>
                          {acct
                            ? <><span style={{ fontFamily: "SFMono-Regular, Menlo, monospace" }}>{acct.code}</span> — {acct.name}</>
                            : <span style={{ fontFamily: "SFMono-Regular, Menlo, monospace", color: C.textMuted }}>{l.account_id.slice(0, 8)}…</span>}
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                          {parseFloat(l.debit || "0") > 0 ? parseFloat(l.debit).toFixed(2) : ""}
                        </td>
                        <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", textAlign: "right" }}>
                          {parseFloat(l.credit || "0") > 0 ? parseFloat(l.credit).toFixed(2) : ""}
                        </td>
                        <td style={{ ...td, fontSize: 12, color: C.textSub }}>{l.memo || ""}</td>
                        <td style={{ ...td, fontSize: 11, color: C.textMuted }}>
                          {l.subledger_type
                            ? <>{l.subledger_type}{l.subledger_id ? ` / ${l.subledger_id.slice(0, 8)}…` : ""}</>
                            : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#0b1220" }}>
                    <td style={td} colSpan={2}>
                      <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Totals</span>
                    </td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.d.toFixed(2)}</td>
                    <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.c.toFixed(2)}</td>
                    <td style={td} colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Approval history (optional, best-effort) */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Approval history</div>
            <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 12 }}>
              {approvals.length === 0 ? (
                <div style={{ color: C.textMuted }}>No approval history.</div>
              ) : (
                approvals.map((a) => (
                  <div key={a.id} style={{ paddingBottom: 6, marginBottom: 6, borderBottom: `1px solid ${C.cardBdr}` }}>
                    <div>
                      <span style={{ color: statusColor(a.status === "approved" ? "posted" : a.status === "rejected" ? "reversed" : "draft"), fontWeight: 600 }}>● {a.status}</span>
                      <span style={{ color: C.textMuted, marginLeft: 8 }}>
                        {a.kind} · created {new Date(a.created_at).toLocaleDateString()}
                        {a.final_decided_at ? ` · decided ${new Date(a.final_decided_at).toLocaleDateString()}` : ""}
                      </span>
                    </div>
                    {(a.steps || []).length > 0 && (
                      <div style={{ marginTop: 4, color: C.textSub, fontSize: 11 }}>
                        {a.steps.map((s) => (
                          <div key={s.id}>
                            step {s.step_order} ({s.mode} / {s.role_required}) — {s.fulfilled_at ? `fulfilled ${new Date(s.fulfilled_at).toLocaleDateString()}` : "pending"}
                            {s.notes ? ` — ${s.notes}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Documents — only writable area in this modal */}
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Supporting documents</div>
            <div style={{ marginBottom: 16 }}>
              <DocumentAttachmentList
                contextTable="journal_entries"
                contextId={je.id}
                kinds={["supporting_doc", "approval_correspondence", "receipt", "other"]}
              />
            </div>

            {/* Cross-cutter T11-3 — audit trail timeline */}
            <RowHistory source_table="journal_entries" source_id={je.id} />
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {canReverse && data && (
            <button onClick={() => onReverseClick(data)} style={btnDanger}>Reverse</button>
          )}
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
