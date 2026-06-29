// RowAttachmentsCell — per-row document attachments for a costing line.
//
// Renders a compact Docs button (with an attachment-count badge) inside the grid
// cell. Clicking opens a centered modal PORTALED to document.body — the grid
// cells use overflow:hidden so an in-cell absolute popover would be clipped,
// hence the portal (same pattern as StylePickerCell / VendorGridCell here).
//
// The modal wraps the shared <DocumentAttachmentList> keyed to
// (context_table="costing_lines", context_id=line.id). Every costing line is
// persisted on creation (store.addLine round-trips through the API and only
// keeps the returned row), so a line always has a real id — there is no
// staged/unsaved state to handle here.

import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import DocumentAttachmentList from "../../shared/documents/DocumentAttachmentList";

// Costing document kinds. The documents schema keeps `kind` free-form (open
// vocabulary, no DB enum — see 20260527040000_p2_chunk5_documents_schema.sql),
// so these are a sensible costing-flavoured default the operator can extend by
// typing; the dropdown just seeds common choices.
const COSTING_DOC_KINDS = [
  "spec_sheet",
  "tech_pack",
  "reference_image",
  "lab_dip",
  "other",
];

export default function RowAttachmentsCell({ lineId, styleCode }: { lineId: string; styleCode?: string | null }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);

  // Lazy count badge — fetch the (active) document count for this line once on
  // mount and again after the modal closes (an upload/archive may have changed
  // it). Failures are silent: the badge just stays hidden.
  async function loadCount() {
    try {
      const params = new URLSearchParams({ context_table: "costing_lines", context_id: lineId });
      const r = await fetch(`/api/internal/documents?${params.toString()}`);
      if (!r.ok) return;
      const rows = await r.json();
      setCount(Array.isArray(rows) ? rows.length : null);
    } catch {
      /* badge stays hidden on error */
    }
  }
  useEffect(() => { void loadCount(); }, [lineId]);

  const hasDocs = (count ?? 0) > 0;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={hasDocs ? `${count} document${count === 1 ? "" : "s"} attached` : "Attach documents"}
        style={{
          background: hasDocs ? "#1D4ED8" : "transparent",
          color: hasDocs ? "#fff" : "#94A3B8",
          border: `1px solid ${hasDocs ? "#3B82F6" : "#334155"}`,
          borderRadius: 3, padding: "3px 7px", fontSize: 11, fontWeight: 600,
          cursor: "pointer", lineHeight: 1.3, display: "inline-flex",
          alignItems: "center", gap: 3, height: 22,
        }}
      >
        Docs{hasDocs ? <span style={{ fontSize: 10 }}>{count}</span> : null}
      </button>

      {open && ReactDOM.createPortal(
        <div
          onClick={() => { setOpen(false); void loadCount(); }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0F172A", border: "1px solid #334155", borderRadius: 8,
              padding: 18, width: "min(560px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#E2E8F0" }}>
                Documents{styleCode ? ` · ${styleCode}` : ""}
              </div>
              <button
                type="button"
                onClick={() => { setOpen(false); void loadCount(); }}
                style={{
                  background: "transparent", color: "#94A3B8", border: "1px solid #334155",
                  borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer",
                }}
              >Close</button>
            </div>
            <DocumentAttachmentList
              contextTable="costing_lines"
              contextId={lineId}
              kinds={COSTING_DOC_KINDS}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
