// VendorQuotePanel — right-side panel showing every quote on the selected
// CostingLine. Add quote (vendor autocomplete + cost + lead time + MOQ +
// dates + status), edit row, delete row, "Select winner" → calls
// /api/internal/costing/lines/:line_id/select-quote. The selected row is
// highlighted; the grid's Vendor column reflects the selection.

import React, { useEffect, useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { appConfirm } from "../../utils/theme";
import VendorPickerCell from "./VendorPickerCell";
import type { CostingLineVendor } from "../types";
import type { VendorHit } from "../services/costingApi";

const STATUSES = ["pending", "received", "selected", "rejected", "expired"] as const;

const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function VendorQuotePanel() {
  const selectedLineId = useCostingStore((s) => s.selectedLineId);
  const lines = useCostingStore((s) => s.lines);
  const vendorQuotes = useCostingStore((s) => s.vendorQuotes);
  const setSelectedLine = useCostingStore((s) => s.setSelectedLine);
  const loadQuotes = useCostingStore((s) => s.loadVendorQuotes);
  const addQuote = useCostingStore((s) => s.addQuote);
  const updateQuote = useCostingStore((s) => s.updateQuote);
  const deleteQuote = useCostingStore((s) => s.deleteQuote);
  const selectQuote = useCostingStore((s) => s.selectQuote);

  const line = lines.find((l) => l.id === selectedLineId) || null;
  const quotes = selectedLineId ? (vendorQuotes[selectedLineId] || []) : [];

  // Draft state for "add quote" form.
  const [draftVendor, setDraftVendor] = useState<VendorHit | null>(null);
  const [draftCost, setDraftCost] = useState("");
  const [draftLead, setDraftLead] = useState("");
  const [draftMoq, setDraftMoq] = useState("");
  const [draftQuotedDate, setDraftQuotedDate] = useState("");
  const [draftValidUntil, setDraftValidUntil] = useState("");
  const [draftStatus, setDraftStatus] = useState("pending");
  const [draftNotes, setDraftNotes] = useState("");

  useEffect(() => {
    if (selectedLineId && !vendorQuotes[selectedLineId]) {
      loadQuotes(selectedLineId);
    }
  }, [selectedLineId, vendorQuotes, loadQuotes]);

  if (!selectedLineId || !line) return null;

  const setNotice = useCostingStore.getState().setNotice;
  const onAdd = async () => {
    if (!draftVendor) { setNotice("Pick a vendor first."); return; }
    const cost = Number(draftCost);
    if (!isFinite(cost) || cost < 0) { setNotice("Enter a valid quoted cost."); return; }
    await addQuote(selectedLineId, {
      vendor_id: draftVendor.id,
      quoted_cost: cost,
      lead_time_days: draftLead ? Number(draftLead) : null,
      moq: draftMoq ? Number(draftMoq) : null,
      quoted_date: draftQuotedDate || null,
      valid_until: draftValidUntil || null,
      status: draftStatus,
      notes: draftNotes || null,
    });
    setDraftVendor(null);
    setDraftCost("");
    setDraftLead("");
    setDraftMoq("");
    setDraftQuotedDate("");
    setDraftValidUntil("");
    setDraftStatus("pending");
    setDraftNotes("");
  };

  return (
    <div style={{
      position: "fixed", right: 0, top: 52, bottom: 0,
      width: 420, background: "#1E293B", borderLeft: "1px solid #334155",
      boxShadow: "-4px 0 12px rgba(0,0,0,0.4)",
      display: "flex", flexDirection: "column", zIndex: 30,
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px", borderBottom: "1px solid #334155",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em" }}>Vendor Quotes</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#E2E8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {line.style_code || "(no style)"} · {line.style_name || line.description || ""}
          </div>
        </div>
        <button
          onClick={() => setSelectedLine(null)}
          style={{
            background: "transparent", color: "#94A3B8",
            border: "1px solid #334155", borderRadius: 4,
            padding: "4px 10px", cursor: "pointer", fontSize: 12,
          }}
        >Close</button>
      </div>

      {/* Quote list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px" }}>
        {quotes.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: "#64748B", textAlign: "center" }}>
            No quotes yet — add one below.
          </div>
        )}
        {quotes.map((q) => (
          <QuoteRow
            key={q.id}
            quote={q}
            lineId={selectedLineId}
            onUpdate={updateQuote}
            onDelete={deleteQuote}
            onSelect={selectQuote}
          />
        ))}
      </div>

      {/* Add-quote form */}
      <div style={{
        borderTop: "1px solid #334155", padding: 12,
        background: "#0F172A",
      }}>
        <div style={{ fontSize: 10, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
          New quote
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <div style={{ gridColumn: "1 / span 2" }}>
            <VendorPickerCell
              value={draftVendor?.legal_name || draftVendor?.code || null}
              onPick={setDraftVendor}
              placeholder="Pick vendor…"
            />
          </div>
          <input
            value={draftCost}
            onChange={(e) => setDraftCost(e.target.value)}
            placeholder="Quoted cost"
            style={fInp}
          />
          <input
            value={draftLead}
            onChange={(e) => setDraftLead(e.target.value)}
            placeholder="Lead time (days)"
            style={fInp}
          />
          <input
            value={draftMoq}
            onChange={(e) => setDraftMoq(e.target.value)}
            placeholder="MOQ"
            style={fInp}
          />
          <select
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value)}
            style={fInp}
          >
            {STATUSES.filter((s) => s !== "selected").map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <label style={{ display: "block", fontSize: 10, color: "#94A3B8" }}>
            Quoted date
            <input
              type="date"
              value={draftQuotedDate}
              onChange={(e) => setDraftQuotedDate(e.target.value)}
              style={{ ...fInp, marginTop: 2 }}
            />
          </label>
          <label style={{ display: "block", fontSize: 10, color: "#94A3B8" }}>
            Valid until
            <input
              type="date"
              value={draftValidUntil}
              onChange={(e) => setDraftValidUntil(e.target.value)}
              style={{ ...fInp, marginTop: 2 }}
            />
          </label>
          <input
            value={draftNotes}
            onChange={(e) => setDraftNotes(e.target.value)}
            placeholder="Notes"
            style={{ ...fInp, gridColumn: "1 / span 2" }}
          />
        </div>
        <button
          onClick={onAdd}
          style={{
            marginTop: 8, width: "100%",
            background: "#10B981", color: "#fff", border: "none",
            padding: "7px 14px", borderRadius: 4, cursor: "pointer",
            fontSize: 12, fontWeight: 600,
          }}
        >+ Add quote</button>
      </div>
    </div>
  );
}

function QuoteRow({ quote, lineId, onUpdate, onDelete, onSelect }: {
  quote: CostingLineVendor;
  lineId: string;
  onUpdate: (lineId: string, quoteId: string, patch: Partial<CostingLineVendor>) => Promise<void>;
  onDelete: (lineId: string, quoteId: string) => Promise<void>;
  onSelect: (lineId: string, quoteId: string) => Promise<void>;
}) {
  const isWinner = quote.status === "selected";
  const [edit, setEdit] = useState(false);
  const [cost, setCost] = useState(String(quote.quoted_cost ?? ""));
  const [lead, setLead] = useState(String(quote.lead_time_days ?? ""));
  const [moq, setMoq] = useState(String(quote.moq ?? ""));
  const [status, setStatus] = useState(quote.status);
  const [notes, setNotes] = useState(quote.notes ?? "");

  const onSave = async () => {
    await onUpdate(lineId, quote.id, {
      quoted_cost: Number(cost),
      lead_time_days: lead ? Number(lead) : null,
      moq: moq ? Number(moq) : null,
      status,
      notes: notes || null,
    });
    setEdit(false);
  };

  return (
    <div style={{
      border: `1px solid ${isWinner ? "#10B981" : "#334155"}`,
      borderRadius: 6, padding: 10, marginBottom: 8,
      background: isWinner ? "#064E3B33" : "#0F172A",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0" }}>
            {quote.vendor?.legal_name || quote.vendor?.code || quote.vendor_id}
          </div>
          <div style={{ fontSize: 11, color: "#94A3B8" }}>
            {quote.vendor?.code || ""}
            {quote.quoted_date ? ` · quoted ${quote.quoted_date}` : ""}
            {quote.valid_until ? ` · valid until ${quote.valid_until}` : ""}
          </div>
        </div>
        <div style={{
          padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
          background: isWinner ? "#10B981" : "#334155",
          color: isWinner ? "#fff" : "#CBD5E1",
          textTransform: "uppercase", letterSpacing: ".05em",
        }}>{quote.status}</div>
      </div>

      {!edit ? (
        <>
          <div style={{ marginTop: 6, fontSize: 12, color: "#E2E8F0", display: "flex", gap: 12 }}>
            <span><b style={{ color: "#A7F3D0" }}>{fmtMoney.format(Number(quote.quoted_cost))}</b> {quote.currency}</span>
            {quote.lead_time_days != null && <span style={{ color: "#94A3B8" }}>Lead: {quote.lead_time_days}d</span>}
            {quote.moq != null && <span style={{ color: "#94A3B8" }}>MOQ: {quote.moq}</span>}
          </div>
          {quote.notes && (
            <div style={{ marginTop: 4, fontSize: 11, color: "#94A3B8", fontStyle: "italic" }}>{quote.notes}</div>
          )}
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            {!isWinner && (
              <button
                onClick={() => onSelect(lineId, quote.id)}
                style={btnStyle("#10B981")}
              >Select winner</button>
            )}
            <button
              onClick={() => setEdit(true)}
              style={btnStyle("#3B82F6")}
            >Edit</button>
            <button
              onClick={() => appConfirm("Delete this quote?", "Delete", () => onDelete(lineId, quote.id))}
              style={btnStyle("#EF4444")}
            >Delete</button>
          </div>
        </>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost" style={fInp} />
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={fInp}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input value={lead} onChange={(e) => setLead(e.target.value)} placeholder="Lead days" style={fInp} />
            <input value={moq} onChange={(e) => setMoq(e.target.value)} placeholder="MOQ" style={fInp} />
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" style={{ ...fInp, gridColumn: "1 / span 2" }} />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
            <button onClick={onSave} style={btnStyle("#10B981")}>Save</button>
            <button onClick={() => setEdit(false)} style={btnStyle("#64748B")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const fInp: React.CSSProperties = {
  background: "#1E293B", color: "#E2E8F0",
  border: "1px solid #334155", borderRadius: 4,
  padding: "5px 8px", fontSize: 12, outline: "none",
};

function btnStyle(color: string): React.CSSProperties {
  return {
    background: "transparent", color, border: `1px solid ${color}`,
    padding: "3px 10px", borderRadius: 3, cursor: "pointer", fontSize: 11,
  };
}
