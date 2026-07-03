// src/tanda/InternalCustomsEntries.tsx
//
// P13-C3 — Trade Compliance vertical. CBP customs entries (Form 7501) against
// received goods. List + create/edit modal with a per-HTS-line sub-table.
//
// Data-only / draft. The landed-cost revaluation onto FIFO inventory layers
// (the revaluation JE) posts in a LATER chunk; this panel never posts.
//
// Mirrors InternalReceiving.tsx conventions (C palette, th/td/input/button
// styles, SearchableSelect, notify/confirmDialog, Field helper, ExportButton).

import { useEffect, useMemo, useState } from "react";
import { notify, confirmDialog } from "../shared/ui/warn";
import ExportButton from "./exports/ExportButton";
import type { ExportColumn } from "./exports/useTableExport";

const C = {
  bg: "#0F172A", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};
const th: React.CSSProperties = { background: "#0b1220", color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left", padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5, position: "sticky", top: 0, zIndex: 2 };
const td: React.CSSProperties = { padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, color: C.text, fontSize: 13 };
const inputStyle: React.CSSProperties = { background: "#0b1220", color: C.text, border: `1px solid ${C.cardBdr}`, padding: "6px 10px", borderRadius: 4, fontSize: 13, width: "100%", boxSizing: "border-box", colorScheme: "dark" };
const numInputStyle: React.CSSProperties = { ...inputStyle, width: "10ch", textAlign: "right" };
const btnPrimary: React.CSSProperties = { background: C.primary, color: "white", border: 0, padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 };
const btnSecondary: React.CSSProperties = { background: "transparent", color: C.textSub, border: `1px solid ${C.cardBdr}`, padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontSize: 13 };
const btnDanger: React.CSSProperties = { ...btnSecondary, color: C.danger, borderColor: "#7f1d1d", padding: "2px 8px" };

type Entry = {
  id: string; entry_number: string; entry_date: string;
  port_of_entry: string | null; importer_of_record: string | null;
  broker_name: string | null; broker_id: string | null;
  total_entered_value_cents: number | string; total_duty_cents: number | string;
  total_mpf_cents: number | string; total_hmf_cents: number | string;
  total_section_301_cents: number | string; total_other_fees_cents: number | string;
  form_7501_document_id: string | null; revaluation_je_id: string | null;
  line_count?: number;
};
type EntryLine = {
  id?: string; receipt_line_item_id: string | null; hts_code: string;
  country_of_origin: string; trade_program: string | null;
  entered_value_cents: number | string; duty_rate_pct: number | string | null;
  duty_cents: number | string; section_301_rate_pct: number | string | null;
  section_301_cents: number | string; mpf_cents: number | string; hmf_cents: number | string;
};

// An editable line in the modal — dollar values for money fields.
type ELine = {
  key: number; hts_code: string; country_of_origin: string; trade_program: string;
  entered_value_dollars: string; duty_rate_pct: string; duty_dollars: string;
  section_301_rate_pct: string; section_301_dollars: string; mpf_dollars: string; hmf_dollars: string;
};

function fmtCents(c: number | string | null | undefined): string {
  const n = Number(c ?? 0); const neg = n < 0; const abs = Math.abs(n);
  return `${neg ? "-" : ""}$${Math.trunc(abs / 100).toLocaleString()}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}
function dollarsToCents(s: string): number { return Math.round((Number(s) || 0) * 100); }
function centsToDollars(c: number | string | null | undefined): string {
  return c == null || c === "" ? "" : (Number(c) / 100).toFixed(2);
}

const EXPORT_COLUMNS: ExportColumn<Record<string, unknown>>[] = [
  { key: "entry_number", header: "Entry #" },
  { key: "entry_date", header: "Entry date", format: "date" },
  { key: "port_of_entry", header: "Port" },
  { key: "broker_name", header: "Broker" },
  { key: "line_count", header: "Lines", format: "number" },
  { key: "total_entered_value_cents", header: "Entered value", format: "currency_cents" },
  { key: "total_duty_cents", header: "Duty", format: "currency_cents" },
  { key: "total_section_301_cents", header: "§301", format: "currency_cents" },
  { key: "total_mpf_cents", header: "MPF", format: "currency_cents" },
  { key: "total_hmf_cents", header: "HMF", format: "currency_cents" },
];

export default function InternalCustomsEntries() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/customs-entries?limit=500`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setRows(await r.json() as Entry[]);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.entry_number} ${r.port_of_entry || ""} ${r.broker_name || ""} ${r.importer_of_record || ""}`.toLowerCase().includes(q));
  }, [rows, search]);

  const exportRows = useMemo(() => filtered.map((r) => ({
    entry_number: r.entry_number,
    entry_date: r.entry_date,
    port_of_entry: r.port_of_entry || "",
    broker_name: r.broker_name || "",
    line_count: r.line_count ?? 0,
    total_entered_value_cents: r.total_entered_value_cents,
    total_duty_cents: r.total_duty_cents,
    total_section_301_cents: r.total_section_301_cents,
    total_mpf_cents: r.total_mpf_cents,
    total_hmf_cents: r.total_hmf_cents,
  })), [filtered]);

  return (
    <div style={{ color: C.text }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Customs Entries</h2>
        <button style={btnPrimary} onClick={() => { setEditing(null); setModalOpen(true); }}>+ New entry</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search entry # / port / broker…" style={{ ...inputStyle, width: 280 }} />
        <button style={btnSecondary} onClick={() => void load()}>Refresh</button>
        <ExportButton rows={exportRows} columns={EXPORT_COLUMNS} filename="customs-entries" sheetName="Customs Entries" />
      </div>

      {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

      <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 240px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>Entry #</th><th style={th}>Date</th><th style={th}>Port</th>
            <th style={{ ...th, textAlign: "right" }}>Entered value</th><th style={{ ...th, textAlign: "right" }}>Duty</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td style={td} colSpan={5}>Loading…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={5}>No customs entries.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => { setEditing(r); setModalOpen(true); }}>
                <td style={{ ...td, fontFamily: "SFMono-Regular, Menlo, monospace" }}>{r.entry_number}</td>
                <td style={td}>{r.entry_date}</td>
                <td style={td}>{r.port_of_entry || <span style={{ color: C.textMuted }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.total_entered_value_cents)}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(r.total_duty_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <EntryModal
          entry={editing}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSaved={() => { setModalOpen(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function EntryModal({ entry, onClose, onSaved }: { entry: Entry | null; onClose: () => void; onSaved: () => void }) {
  const isNew = entry === null;

  const [savedId, setSavedId] = useState<string | null>(entry?.id || null);
  const [entryNumber, setEntryNumber] = useState(entry?.entry_number || "");
  const [entryDate, setEntryDate] = useState(entry?.entry_date || new Date().toISOString().slice(0, 10));
  const [portOfEntry, setPortOfEntry] = useState(entry?.port_of_entry || "");
  const [importerOfRecord, setImporterOfRecord] = useState(entry?.importer_of_record || "");
  const [brokerName, setBrokerName] = useState(entry?.broker_name || "");
  const [otherFeesDollars, setOtherFeesDollars] = useState(centsToDollars(entry?.total_other_fees_cents));
  const [lines, setLines] = useState<ELine[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load existing entry's lines when editing.
  useEffect(() => {
    if (isNew || !entry) return;
    fetch(`/api/internal/procurement/customs-entries/${entry.id}`).then((r) => r.ok ? r.json() : null).then((full) => {
      if (!full || !Array.isArray(full.lines)) return;
      setLines(full.lines.map((l: EntryLine, i: number) => ({
        key: i + 1,
        hts_code: l.hts_code || "",
        country_of_origin: l.country_of_origin || "",
        trade_program: l.trade_program || "",
        entered_value_dollars: centsToDollars(l.entered_value_cents),
        duty_rate_pct: l.duty_rate_pct == null ? "" : String(l.duty_rate_pct),
        duty_dollars: centsToDollars(l.duty_cents),
        section_301_rate_pct: l.section_301_rate_pct == null ? "" : String(l.section_301_rate_pct),
        section_301_dollars: centsToDollars(l.section_301_cents),
        mpf_dollars: centsToDollars(l.mpf_cents),
        hmf_dollars: centsToDollars(l.hmf_cents),
      })));
    }).catch(() => {});
  }, [isNew, entry]);

  function addLine() {
    setLines((p) => [...p, {
      key: (p[p.length - 1]?.key ?? 0) + 1, hts_code: "", country_of_origin: "", trade_program: "",
      entered_value_dollars: "", duty_rate_pct: "", duty_dollars: "", section_301_rate_pct: "",
      section_301_dollars: "", mpf_dollars: "", hmf_dollars: "",
    }]);
  }
  function updateLine(idx: number, patch: Partial<ELine>) { setLines((p) => p.map((l, i) => i === idx ? { ...l, ...patch } : l)); }
  function removeLine(idx: number) { setLines((p) => p.filter((_, i) => i !== idx)); }

  const totalEntered = useMemo(() => lines.reduce((s, l) => s + dollarsToCents(l.entered_value_dollars), 0), [lines]);
  const totalDuty = useMemo(() => lines.reduce((s, l) => s + dollarsToCents(l.duty_dollars), 0), [lines]);
  const total301 = useMemo(() => lines.reduce((s, l) => s + dollarsToCents(l.section_301_dollars), 0), [lines]);
  const totalMpf = useMemo(() => lines.reduce((s, l) => s + dollarsToCents(l.mpf_dollars), 0), [lines]);
  const totalHmf = useMemo(() => lines.reduce((s, l) => s + dollarsToCents(l.hmf_dollars), 0), [lines]);

  function apiLines() {
    return lines
      .filter((l) => l.hts_code.trim() && l.country_of_origin.trim())
      .map((l) => ({
        hts_code: l.hts_code.trim(),
        country_of_origin: l.country_of_origin.trim().toUpperCase(),
        trade_program: l.trade_program.trim() || null,
        entered_value_cents: dollarsToCents(l.entered_value_dollars),
        duty_rate_pct: l.duty_rate_pct === "" ? null : Number(l.duty_rate_pct),
        duty_cents: dollarsToCents(l.duty_dollars),
        section_301_rate_pct: l.section_301_rate_pct === "" ? null : Number(l.section_301_rate_pct),
        section_301_cents: dollarsToCents(l.section_301_dollars),
        mpf_cents: dollarsToCents(l.mpf_dollars),
        hmf_cents: dollarsToCents(l.hmf_dollars),
      }));
  }

  async function save(): Promise<string | null> {
    setErr(null);
    if (!entryNumber.trim()) { setErr("Entry number is required."); return null; }
    if (apiLines().length === 0) { setErr("Add at least one line with an HTS code + country of origin."); return null; }
    setSubmitting(true);
    try {
      const body = {
        entry_number: entryNumber.trim(),
        entry_date: entryDate,
        port_of_entry: portOfEntry.trim() || null,
        importer_of_record: importerOfRecord.trim() || null,
        broker_name: brokerName.trim() || null,
        total_other_fees_cents: dollarsToCents(otherFeesDollars),
        lines: apiLines(),
      };
      let id = savedId;
      if (!id) {
        const r = await fetch("/api/internal/procurement/customs-entries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        id = j?.id || null;
        setSavedId(id);
      } else {
        const r = await fetch(`/api/internal/procurement/customs-entries/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      }
      return id;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
    finally { setSubmitting(false); }
  }

  async function saveDraft() {
    const id = await save();
    if (id) { notify("Customs entry saved.", "success"); onSaved(); }
  }

  async function del() {
    if (!savedId) return;
    if (!(await confirmDialog(`Delete customs entry ${entryNumber}? This also removes its lines.`))) return;
    setSubmitting(true); setErr(null);
    try {
      const r = await fetch(`/api/internal/procurement/customs-entries/${savedId}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      notify("Customs entry deleted.", "success");
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 10, padding: 20, width: "min(1260px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", color: C.text }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{isNew ? "New customs entry" : `Customs entry — ${entry?.entry_number}`}</h3>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Entry number"><input type="text" value={entryNumber} onChange={(e) => setEntryNumber(e.target.value)} style={inputStyle} placeholder="e.g. 300-1234567-8" /></Field>
          <Field label="Entry date"><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Port of entry"><input type="text" value={portOfEntry} onChange={(e) => setPortOfEntry(e.target.value)} style={inputStyle} placeholder="e.g. 2704 Los Angeles" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
          <Field label="Importer of record"><input type="text" value={importerOfRecord} onChange={(e) => setImporterOfRecord(e.target.value)} style={inputStyle} placeholder="optional" /></Field>
          <Field label="Broker name"><input type="text" value={brokerName} onChange={(e) => setBrokerName(e.target.value)} style={inputStyle} placeholder="optional" /></Field>
          <Field label="Other fees $ (header)"><input type="text" inputMode="decimal" value={otherFeesDollars} onChange={(e) => setOtherFeesDollars(e.target.value)} style={inputStyle} placeholder="0.00" /></Field>
        </div>

        {/* HTS lines */}
        <div style={{ marginTop: 16, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Lines (per HTS code)</div>
          <button onClick={addLine} style={btnSecondary}>+ Add line</button>
        </div>
        <div style={{ background: "#0b1220", border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "auto", marginBottom: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
            <thead><tr>
              <th style={th}>HTS code</th><th style={th}>COO</th><th style={th}>Program</th>
              <th style={{ ...th, textAlign: "right" }}>Entered $</th><th style={{ ...th, textAlign: "right" }}>Duty %</th><th style={{ ...th, textAlign: "right" }}>Duty $</th>
              <th style={{ ...th, textAlign: "right" }}>§301 $</th><th style={{ ...th, textAlign: "right" }}>MPF $</th><th style={{ ...th, textAlign: "right" }}>HMF $</th><th style={th}></th>
            </tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={10}>No lines. Add one line per HTS classification on the entry.</td></tr>}
              {lines.map((l, idx) => (
                <tr key={l.key}>
                  <td style={td}><input type="text" value={l.hts_code} onChange={(e) => updateLine(idx, { hts_code: e.target.value })} placeholder="0000.00.0000" style={{ ...inputStyle, width: "14ch" }} /></td>
                  <td style={td}><input type="text" maxLength={2} value={l.country_of_origin} onChange={(e) => updateLine(idx, { country_of_origin: e.target.value.toUpperCase() })} placeholder="CN" style={{ ...inputStyle, width: "5ch", textTransform: "uppercase" }} /></td>
                  <td style={td}><input type="text" value={l.trade_program} onChange={(e) => updateLine(idx, { trade_program: e.target.value })} placeholder="optional" style={{ ...inputStyle, width: "10ch" }} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.entered_value_dollars} onChange={(e) => updateLine(idx, { entered_value_dollars: e.target.value })} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.duty_rate_pct} onChange={(e) => updateLine(idx, { duty_rate_pct: e.target.value })} placeholder="%" style={{ ...numInputStyle, width: "7ch" }} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.duty_dollars} onChange={(e) => updateLine(idx, { duty_dollars: e.target.value })} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.section_301_dollars} onChange={(e) => updateLine(idx, { section_301_dollars: e.target.value })} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.mpf_dollars} onChange={(e) => updateLine(idx, { mpf_dollars: e.target.value })} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}><input type="text" inputMode="decimal" value={l.hmf_dollars} onChange={(e) => updateLine(idx, { hmf_dollars: e.target.value })} placeholder="0.00" style={numInputStyle} /></td>
                  <td style={td}><button type="button" onClick={() => removeLine(idx)} style={btnDanger}>✕</button></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td style={{ ...td, textAlign: "right" }} colSpan={3}><span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Total</span></td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(totalEntered)}</td>
              <td style={td}></td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(totalDuty)}</td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(total301)}</td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(totalMpf)}</td>
              <td style={{ ...td, fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtCents(totalHmf)}</td>
              <td style={td}></td>
            </tr></tfoot>
          </table>
        </div>

        {err && <div style={{ background: "#7f1d1d", color: "white", padding: "8px 12px", borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{err}</div>}

        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12 }}>
          Header value/duty/§301/MPF/HMF totals are summed from the lines. Landed-cost revaluation onto FIFO inventory layers posts in a later chunk — this entry is record-only.
        </div>

        {/* Sticky action footer — pinned to the bottom of the scrolling modal so
            Save / Close stay reachable as the entry-line grid grows. */}
        <div style={{ position: "sticky", bottom: -20, zIndex: 3, background: C.card, borderTop: `1px solid ${C.cardBdr}`, margin: "0 -20px -20px", padding: "12px 20px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <div>{savedId && <button onClick={() => void del()} style={btnDanger} disabled={submitting}>Delete entry</button>}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnSecondary} disabled={submitting}>Close</button>
            <button onClick={() => void saveDraft()} style={btnPrimary} disabled={submitting}>{submitting ? "Saving…" : "Save"}</button>
          </div>
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
