// src/tanda/InternalJournalEntry.tsx
//
// Tangerine P1 Chunk 8c — Journal Entry list + manual post + reverse.
// Wraps the GET/POST /api/internal/journal-entries endpoints and the
// /reverse action. Multi-line entry with live balance check, basis
// selector (ACCRUAL | CASH | BOTH), and inline subledger entry per line.

import React, { useEffect, useMemo, useState } from "react";
import { fmtDateDisplay } from "../utils/tandaTypes";
import { uploadStagedDocs } from "../shared/documents/uploadDocument";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";
import SourceBadge, { SOURCE_OPTIONS } from "./components/SourceBadge";
// Shared JE detail modal (extracted so GL-detail drill-down can reuse it).
import JEDetailModal from "./components/JEDetailModal";
// Universal row-click + scroll-highlight primitive (operator ask #4).
import { useRowClickEdit } from "./hooks/useRowClickEdit";
import ScrollHighlightRow from "./components/ScrollHighlightRow";
import SearchableSelect, { type SearchableSelectOption } from "./components/SearchableSelect";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "./components/TablePrefs";
import { useSort } from "./hooks/useSort";
import SortableTh from "./components/SortableTh";
import { useDebouncedSearch } from "./hooks/useDebouncedSearch";
import { readDrillParam, consumeDrillParams } from "./scorecardDrill";

const TABLE_KEY = "tanda.journal_entry";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "je_number",    label: "JE #" },
  { key: "posting_date", label: "Posting Date" },
  { key: "type",         label: "Type" },
  { key: "basis",        label: "Basis" },
  { key: "description",  label: "Description" },
  { key: "source",       label: "Source" },
  { key: "status",       label: "Status" },
];

type JELine = {
  id?: string;
  line_number: number;
  account_id: string;
  debit: string;
  credit: string;
  memo: string;
  memo_line_2: string;
  // Per-field "user has typed in this box" flags. Used so the auto-copy
  // mirror between memo line 1 and line 2 only fires until BOTH lines have
  // received user input; from that point on either field is independently
  // editable.
  memo_touched: boolean;
  memo_line_2_touched: boolean;
  subledger_type: string;
  subledger_id: string;
};

// (JE line / approval / full-JE shapes now live in the shared
// components/JEDetailModal.tsx, which self-fetches the full entry by id.)

type JE = {
  id: string;
  je_number: string | null;
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
  posted_by_name?: string | null;
  created_by_name?: string | null;
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
  // border-box so width:100% + padding doesn't overflow the grid cell and
  // bleed into the neighbouring field (was the posting-date ↔ description overlap).
  boxSizing: "border-box",
  colorScheme: "dark",
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

export default function InternalJournalEntry() {
  const [rows, setRows] = useState<JE[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [basisFilter, setBasisFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  // Month-End Close → "Review" on the *No draft / unposted JEs* check drills in
  // with ?include_drafts=true so the panel opens showing the very entries that
  // need posting or deleting. One-shot: consumed on mount (below) so leaving and
  // returning doesn't silently re-force drafts on.
  const [includeDrafts, setIncludeDrafts] = useState(() => readDrillParam("include_drafts") === "true");
  // Scorecard drill-through: ?q=<vendor/customer code> seeds a client-side text
  // filter over description + source ref. JE has no party column, so the
  // scorecard passes the party code/name and we match it against the JE text.
  const { value: search, debouncedValue: searchDebounced, setValue: setSearch } =
    useDebouncedSearch(readDrillParam("q"), 200);
  const [postOpen, setPostOpen] = useState(false);
  const [detail, setDetail] = useState<JE | null>(null);
  // Drill-through deep-link: ?je=<id> auto-opens the entry's detail modal
  // (JEDetailModal self-fetches by id, so a minimal seed suffices). One-shot:
  // consumed so leaving and returning doesn't re-open the modal.
  useEffect(() => {
    const jeParam = readDrillParam("je");
    if (jeParam) {
      setDetail({ id: jeParam } as JE);
    }
    // include_drafts is read into initial state above; strip it here (with `je`)
    // so a later visit doesn't re-apply the one-shot drill.
    consumeDrillParams(["je", "include_drafts"]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);
  // Universal row-click primitive (operator ask #4) — replaces the
  // hand-rolled onClick/setDetail on each <tr>. The hook handles
  // modifier-key fall-through, keyboard activation, and tracks the
  // last-clicked row id for the scroll-highlight fade.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const { getRowProps } = useRowClickEdit<JE>({
    onRowClick: (je) => setDetail(je),
    onBeforeRowClick: (id) => setHighlightedId(id),
    ariaLabel: (je) => `Open journal entry ${je.description || "—"}`,
  });

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

  // Client-side free-text filter (drill-through `?q=` seed). Matches the party
  // code/name against the JE description and source reference.
  const filteredRows = useMemo(() => {
    const needle = searchDebounced.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((je) =>
      `${je.je_number || ""} ${je.description || ""} ${je.source_table || ""} ${je.source_id || ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [rows, searchDebounced]);

  // #5 Sortable columns — sort the (already search-filtered) rows.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(filteredRows, {
    persistKey: "tangerine:journalentries:sort",
    accessors: {
      je_number: (je) => je.je_number || "",
      posting_date: (je) => je.posting_date,
      type: (je) => je.journal_type,
      basis: (je) => je.basis,
      description: (je) => je.description || "",
      source: (je) => je.source || "",
      status: (je) => je.status,
    },
  });

  async function reverse(je: JE) {
    if (je.status !== "posted") {
      notify(`Cannot reverse JE in status '${je.status}'.`, "error");
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
      notify(`Reverse failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Journal Entries</h2>
        <button onClick={() => setPostOpen(true)} style={btnPrimary}>+ Post manual JE</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <div style={{ width: 200 }}>
          <SearchableSelect
            value={basisFilter || null}
            onChange={(v) => setBasisFilter(v)}
            options={[
              { value: "", label: "All bases" },
              { value: "ACCRUAL", label: "ACCRUAL" },
              { value: "CASH", label: "CASH" },
            ]}
            placeholder="All bases"
            inputStyle={inputStyle}
          />
        </div>
        <div style={{ width: 180 }} title="Filter by row source — manual entries vs mirrored from Xoro / future integrations">
          <SearchableSelect
            value={sourceFilter || null}
            onChange={(v) => setSourceFilter(v)}
            options={[
              { value: "", label: "All sources" },
              ...SOURCE_OPTIONS.map((s) => ({ value: s, label: s })),
            ]}
            placeholder="All sources"
            inputStyle={inputStyle}
          />
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Search JE # / description / source…"
          style={{ ...inputStyle, width: 220 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSub }}>
          <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
          Include drafts
        </label>
        <ExportButton
          rows={rows as unknown as Array<Record<string, unknown>>}
          filename="journal-entries"
          sheetName="Journal Entries"
          columns={[
            { key: "je_number",         header: "JE #" },
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
        <TablePrefsButton
          tableKey={TABLE_KEY}
          columns={ALL_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
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
        ) : filteredRows.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: C.textMuted }}>
            {searchDebounced.trim() ? "No journal entries match the filter." : "No journal entries yet."}
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <SortableTh label="JE #" sortKey="je_number" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("je_number")} />
                <SortableTh label="Posting Date" sortKey="posting_date" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("posting_date")} />
                <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("type")} />
                <SortableTh label="Basis" sortKey="basis" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("basis")} />
                <SortableTh label="Description" sortKey="description" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("description")} />
                <SortableTh label="Source" sortKey="source" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("source")} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={th} hidden={!visibleColumns.has("status")} />
                <th style={{ ...th, width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((je) => (
                <ScrollHighlightRow
                  key={je.id}
                  rowId={je.id}
                  highlightedRowId={highlightedId}
                  {...getRowProps(je)}
                  style={{
                    ...(je.status !== "posted" ? { opacity: 0.55 } : {}),
                    cursor: "pointer",
                  }}
                  title="Click to view details"
                >
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap", fontWeight: 600 }} hidden={!visibleColumns.has("je_number")}>{je.je_number || "—"}</td>
                  <td style={td} hidden={!visibleColumns.has("posting_date")}>{fmtDateDisplay(je.posting_date)}</td>
                  <td style={td} hidden={!visibleColumns.has("type")}>{je.journal_type}</td>
                  <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }} hidden={!visibleColumns.has("basis")}>{je.basis}</td>
                  <td style={td} hidden={!visibleColumns.has("description")}>
                    {je.description}
                    <SourceBadge source={je.source} />
                  </td>
                  <td style={{ ...td, fontSize: 12, color: C.textMuted }} hidden={!visibleColumns.has("source")}>{je.source_table || "—"}</td>
                  <td style={td} hidden={!visibleColumns.has("status")}>
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
                </ScrollHighlightRow>
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
          onReverseClick={() => { if (detail) void reverse(detail); }}
        />
      )}
    </div>
  );
}

function statusColor(s: JE["status"]) {
  return s === "posted" ? C.success : s === "draft" ? C.textMuted : C.danger;
}

// Compact numeric style — fixed-width debit/credit inputs sized for
// $999,999,999.99 and aligned in monospace so columns line up visually.
const moneyInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontVariantNumeric: "tabular-nums",
  fontFamily: "SFMono-Regular, Menlo, monospace",
  textAlign: "right",
};

function emptyLine(line_number: number): JELine {
  return {
    line_number,
    account_id: "",
    debit: "",
    credit: "",
    memo: "",
    memo_line_2: "",
    memo_touched: false,
    memo_line_2_touched: false,
    subledger_type: "",
    subledger_id: "",
  };
}

function ManualJEModal({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [basis, setBasis] = useState<"ACCRUAL" | "CASH" | "BOTH">("ACCRUAL");
  const [postingDate, setPostingDate] = useState(new Date().toISOString().slice(0, 10));
  const [journalType, setJournalType] = useState<"manual" | "adjustment">("manual");
  const [description, setDescription] = useState("");
  // T11 D3 — a reason is REQUIRED to post; the server rejects without it.
  // It auto-mirrors the Description until the operator edits it directly, so a
  // single field covers the common case (and the Post button — disabled until
  // Description is filled — never trips the "reason required" guard).
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [lines, setLines] = useState<JELine[]>([emptyLine(1), emptyLine(2)]);
  // Documents staged during entry — uploaded after the JE posts (a brand-new
  // entry has no id yet, so DocumentAttachmentList can't attach in place).
  const [stagedDocs, setStagedDocs] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Ask #17 — track whether anything in this modal has been edited so we
  // can prompt before discarding work. A single boolean covers the modal
  // — once any field has been touched, every close path (overlay click,
  // Cancel, Escape, browser back) goes through the confirm guard.
  const [dirty, setDirty] = useState(false);
  // Subledger pickers — vendors / customers for the Sub id dropdown (dependent
  // on Sub type). Fetched once; "item" stays free-text (rare in a manual JE).
  const [subVendors, setSubVendors] = useState<SearchableSelectOption[]>([]);
  const [subCustomers, setSubCustomers] = useState<SearchableSelectOption[]>([]);

  useEffect(() => {
    fetch("/api/internal/gl-accounts?limit=500")
      .then((r) => r.json())
      .then((a: Account[]) => setAccounts(a.filter((x) => x.status === "active" && x.is_postable)))
      .catch(() => {});
    fetch("/api/internal/vendor-master?limit=1000")
      .then((r) => r.json())
      .then((v: Array<{ id: string; name: string; code?: string | null }>) =>
        setSubVendors((Array.isArray(v) ? v : []).map((x) => ({ value: x.id, label: x.code ? `${x.code} — ${x.name}` : x.name, searchHaystack: `${x.code || ""} ${x.name} ${x.id}` }))))
      .catch(() => {});
    fetch("/api/internal/customer-master?limit=1000")
      .then((r) => r.json())
      .then((c: Array<{ id: string; name: string; code?: string | null; customer_code?: string | null }>) =>
        setSubCustomers((Array.isArray(c) ? c : []).map((x) => ({ value: x.id, label: (x.code || x.customer_code) ? `${x.code || x.customer_code} — ${x.name}` : x.name, searchHaystack: `${x.code || x.customer_code || ""} ${x.name} ${x.id}` }))))
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
    setDirty(true);
    setLines((prev) => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }

  // One memo per line, auto-copied to every account on the JE: editing a memo
  // fills all lines the user hasn't individually overridden; once a line's memo
  // is edited directly it's "touched" and no longer auto-overwritten.
  function onMemoChange(idx: number, value: string) {
    setDirty(true);
    setLines((prev) =>
      prev.map((l, i) => {
        if (i === idx) return { ...l, memo: value, memo_touched: true };
        if (!l.memo_touched) return { ...l, memo: value }; // auto-copy to untouched lines
        return l;
      }),
    );
  }

  function addLine() {
    setDirty(true);
    setLines((prev) => [...prev, emptyLine(prev.length + 1)]);
  }
  function removeLine(idx: number) {
    if (lines.length <= 2) return;
    setDirty(true);
    setLines((prev) => prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_number: i + 1 })));
  }

  // Single source-of-truth close path. Honours the unsaved-changes guard
  // unless the caller passes force=true (used after a successful post).
  async function requestClose(force = false) {
    if (!force && dirty) {
      const ok = await confirmDialog("You have unsaved changes. Discard?", { title: "Discard changes?", icon: "", confirmText: "Discard", confirmColor: "#EF4444" });
      if (!ok) return;
    }
    onClose();
  }

  // Ask #17 — Escape key closes the modal but routes through the same
  // dirty-check confirm prompt.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // requestClose closes over `dirty`; re-bind when dirty flips so the
    // handler sees the latest value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // Browser-level warning if the user reloads/navigates away with unsaved
  // edits. Standards-compliant beforeunload prompt — no library needed.
  useEffect(() => {
    function beforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  async function submit() {
    // Ask #17 — out-of-balance confirm. The server-side validator still
    // rejects the post; we surface the explicit failure instead of a
    // silently-disabled button so the user sees the exact reason.
    if (totals.diff !== 0 || totals.d === 0) {
      const diffStr = totals.diff.toFixed(2);
      const proceed = await confirmDialog(
        `Journal entry is out of balance by $${diffStr}. Posting will fail server-side validation. Continue anyway?`,
        { title: "Out of balance", icon: "", confirmText: "Continue anyway", confirmColor: "#F59E0B" },
      );
      if (!proceed) return;
    }
    if (!reason.trim()) { setErr("A reason is required to post (T11 D3) — fill in the Reason field."); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const body = {
        basis,
        posting_date: postingDate,
        description: description.trim(),
        journal_type: journalType,
        reason: reason.trim(),
        lines: lines.map((l) => ({
          line_number: l.line_number,
          account_id: l.account_id,
          debit: l.debit || "0",
          credit: l.credit || "0",
          memo: l.memo || null,
          memo_line_2: null, // single memo per line now (see onMemoChange)
          subledger_type: l.subledger_type || null,
          subledger_id: l.subledger_id || null,
        })),
      };
      const r = await fetch("/api/internal/journal-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = (await r.json().catch(() => ({}))) as {
        error?: string;
        requires_approval?: boolean;
        approval_request_id?: string;
        posted?: Array<{ basis: string; je_id: string }>;
      };
      if (!r.ok) {
        throw new Error(resBody.error || `HTTP ${r.status}`);
      }
      // Maker/checker (segregation of duties): a JE at/above the approval
      // threshold is routed to an approval_request instead of posting. It posts
      // only once a DIFFERENT authorized user approves it (Approvals inbox).
      if (resBody.requires_approval) {
        setDirty(false);
        notify(
          "Journal entry submitted for approval (at or above the $5,000 threshold). It will post once a different authorized user approves it in the Approvals inbox.",
          "info",
        );
        onPosted();
        return;
      }
      // Upload any documents staged during entry to the freshly-posted JE.
      // For a BOTH-basis post we attach to the ACCRUAL entry (the primary book).
      if (stagedDocs.length > 0) {
        const posted = (resBody.posted || []) as Array<{ basis: string; je_id: string }>;
        const target = posted.find((p) => p.basis === "ACCRUAL")?.je_id || posted[0]?.je_id;
        if (target) {
          try {
            await uploadStagedDocs("journal_entries", target, stagedDocs);
          } catch (upErr) {
            // JE is already posted — surface the doc failure but don't lose the post.
            notify(`Journal entry posted, but a document upload failed: ${upErr instanceof Error ? upErr.message : String(upErr)}`, "error");
          }
        }
      }
      // Successful post — bypass the dirty guard on close.
      setDirty(false);
      onPosted();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={() => requestClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1180px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>Post manual journal entry</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 2fr", gap: 16, marginBottom: 12 }}>
          <Field label="Basis">
            <SearchableSelect
              value={basis}
              onChange={(v) => { setDirty(true); setBasis(v as "ACCRUAL" | "CASH" | "BOTH"); }}
              options={[
                { value: "ACCRUAL", label: "ACCRUAL" },
                { value: "CASH", label: "CASH" },
                { value: "BOTH", label: "BOTH (sibling pair)" },
              ]}
              inputStyle={inputStyle as React.CSSProperties}
            />
          </Field>
          <Field label="Journal type">
            <SearchableSelect
              value={journalType}
              onChange={(v) => { setDirty(true); setJournalType(v as "manual" | "adjustment"); }}
              options={[
                { value: "manual", label: "MANUAL" },
                { value: "adjustment", label: "ADJUSTMENT" },
              ]}
              inputStyle={{ ...(inputStyle as React.CSSProperties), textTransform: "uppercase" }}
            />
          </Field>
          <Field label="Posting date">
            <input type="date" value={postingDate} onChange={(e) => { setDirty(true); setPostingDate(e.target.value); }} style={inputStyle} />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={description}
              onChange={(e) => {
                setDirty(true);
                setDescription(e.target.value);
                // Auto-mirror into Reason until the operator edits Reason directly.
                if (!reasonTouched) setReason(e.target.value);
              }}
              style={inputStyle}
              placeholder="e.g. Adjusting entry for accrued rent"
            />
          </Field>
        </div>

        {/* T11 D3 — reason is required to post; surfaced as its own field so the
            "reason required" error never blocks a user with nowhere to enter it. */}
        <div style={{ marginBottom: 16 }}>
          <Field label="Reason (required to post)">
            <input
              type="text" value={reason}
              onChange={(e) => { setDirty(true); setReasonTouched(true); setReason(e.target.value); }}
              style={inputStyle}
              placeholder="Defaults to the description; edit to override"
            />
          </Field>
        </div>

        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 40 }} />
              <col style={{ width: 340 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 140 }} />
              <col />
              <col style={{ width: 96 }} />
              <col style={{ width: 160 }} />
              <col style={{ width: 44 }} />
            </colgroup>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Account</th>
                <th style={{ ...th, textAlign: "right" }}>Debit</th>
                <th style={{ ...th, textAlign: "right" }}>Credit</th>
                <th style={th}>Memo</th>
                <th style={th} title="Optional subledger link for control accounts (e.g. customer for AR, vendor for AP). Leave blank for ordinary GL lines.">Sub type</th>
                <th style={th} title="The specific subledger record id that pairs with Sub type. Leave blank when Sub type is blank.">Sub id</th>
                <th style={th}></th>
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
                    <input
                      type="text"
                      value={l.debit}
                      onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? "" : l.credit })}
                      placeholder="0.00"
                      style={moneyInputStyle}
                    />
                  </td>
                  <td style={td}>
                    <input
                      type="text"
                      value={l.credit}
                      onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? "" : l.debit })}
                      placeholder="0.00"
                      style={moneyInputStyle}
                    />
                  </td>
                  <td style={td}>
                    {/* One memo per line; copies to every line until a line is
                        edited directly (then that line keeps its own). */}
                    <input
                      type="text"
                      value={l.memo}
                      placeholder={idx === 0 ? "Memo (copies to all lines)" : "Memo (override)"}
                      onChange={(e) => onMemoChange(idx, e.target.value)}
                      style={inputStyle}
                    />
                  </td>
                  <td style={td}>
                    <SearchableSelect
                      value={l.subledger_type || null}
                      onChange={(v) => updateLine(idx, { subledger_type: v, subledger_id: "" })}
                      options={[
                        { value: "", label: "(select)" },
                        { value: "vendor", label: "vendor" },
                        { value: "customer", label: "customer" },
                        { value: "item", label: "item" },
                      ]}
                      placeholder="(select)"
                      inputStyle={inputStyle as React.CSSProperties}
                    />
                  </td>
                  <td style={td}>
                    {l.subledger_type === "vendor" || l.subledger_type === "customer" ? (
                      <SearchableSelect
                        value={l.subledger_id || null}
                        onChange={(id) => updateLine(idx, { subledger_id: id })}
                        options={l.subledger_type === "vendor" ? subVendors : subCustomers}
                        placeholder={`Select ${l.subledger_type}…`}
                      />
                    ) : l.subledger_type === "item" ? (
                      <input
                        type="text"
                        value={l.subledger_id}
                        onChange={(e) => updateLine(idx, { subledger_id: e.target.value })}
                        placeholder="item id"
                        style={{ ...inputStyle, fontFamily: "SFMono-Regular, Menlo, monospace", fontSize: 11 }}
                      />
                    ) : (
                      <input type="text" value="" disabled placeholder="—" style={{ ...inputStyle, opacity: 0.5 }} />
                    )}
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
                <td style={{ ...td, fontVariantNumeric: "tabular-nums", fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.d.toFixed(2)}</td>
                <td style={{ ...td, fontVariantNumeric: "tabular-nums", fontFamily: "SFMono-Regular, Menlo, monospace", fontWeight: 700, textAlign: "right" }}>{totals.c.toFixed(2)}</td>
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

        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12, lineHeight: 1.5 }}>
          <strong>Memo</strong> auto-copies to every line; edit a line's memo to override just that line.
          {" "}<strong>Sub type / Sub id</strong> optionally link a line to a subledger record (e.g. a
          customer for an AR control account, a vendor for AP) — leave both blank for ordinary GL lines.
          They don't affect the debit/credit amounts.
        </div>

        {/* Stage supporting documents during entry — uploaded after the JE
            posts (a new entry has no id to attach to yet). */}
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: stagedDocs.length ? 8 : 0 }}>
            <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Supporting documents {stagedDocs.length > 0 && <span>({stagedDocs.length})</span>}
            </span>
            <label style={{ ...btnSecondary, cursor: "pointer", display: "inline-block" }}>
              + Add files
              <input
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const picked = Array.from(e.target.files || []);
                  if (picked.length) { setDirty(true); setStagedDocs((prev) => [...prev, ...picked]); }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {stagedDocs.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textSub, paddingTop: 4 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              <button
                onClick={() => setStagedDocs((prev) => prev.filter((_, j) => j !== i))}
                style={{ background: "transparent", color: C.danger, border: "none", cursor: "pointer", fontSize: 12 }}
              >
                Remove
              </button>
            </div>
          ))}
          {stagedDocs.length === 0 && (
            <span style={{ fontSize: 11, color: C.textMuted }}> — attach receipts, approvals, or backup; uploaded when you post.</span>
          )}
        </div>

        {err && (
          <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {err}
          </div>
        )}

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Post / Cancel stay reachable as the entry-line grid grows. */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          <button onClick={() => requestClose()} style={btnSecondary} disabled={submitting}>Cancel</button>
          <button
            onClick={() => void submit()}
            style={btnPrimary}
            disabled={submitting || !description.trim()}
            title={totals.diff !== 0 ? "Out of balance — server will reject. Click to confirm." : undefined}
          >
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

