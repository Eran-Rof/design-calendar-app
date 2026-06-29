// Costing Module — RFQ list view.
//
// Lists every RFQ generated from the costing module + any other RFQs in
// the entity. Search bar runs over title / vendor / customer / project /
// line-item descriptions (style codes are embedded in line description
// text, so style search hits the same field).
//
// Click a row → /costing?view=rfq-edit&id=<rfq_id>

import React, { useEffect, useState } from "react";
import { listRfqs, deleteRfq, publishRfq, awardRfq, stripExcelPrefix, getRfq } from "../services/costingApi";
import { fmtDateDisplay, navigate } from "../helpers";
import { appConfirm } from "../../utils/theme";
import { useCostingStore } from "../store/costingStore";
import { useSort } from "../../tanda/hooks/useSort";
import SortableTh from "../../tanda/components/SortableTh";
import SearchableSelect from "../../tanda/components/SearchableSelect";
import type { RfqListRow, RfqStatus, RfqDetail, RfqLineItem, RfqQuoteSummary } from "../types";

const STATUS_COLOR: Record<RfqStatus, { bg: string; fg: string }> = {
  draft:     { bg: "#F3F4F6", fg: "#6B7280" },
  published: { bg: "#DBEAFE", fg: "#1E40AF" },
  closed:    { bg: "#E5E7EB", fg: "#374151" },
  awarded:   { bg: "#DCFCE7", fg: "#166534" },
};

const STATUS_OPTIONS: RfqStatus[] = ["draft", "published", "closed", "awarded"];

const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
// Per-unit target cost is a unit price → 2 decimals (e.g. 6.75), unlike the
// whole-dollar totals (Est Budget).
const fmtUnit  = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty   = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export default function RfqListView() {
  const [rows, setRows] = useState<RfqListRow[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<RfqStatus | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // RFQ ids with an in-flight Send-to-Vendor publish (disable the button + show "Sending…").
  const [sending, setSending] = useState<Set<string>>(new Set());
  // RFQ ids with an in-flight Award (disable + show "Awarding…").
  const [awarding, setAwarding] = useState<Set<string>>(new Set());
  // Inline expand: which RFQ row is expanded + lazy-loaded detail cache.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailById, setDetailById] = useState<Record<string, RfqDetail>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  const toggleExpand = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detailById[id]) {
      setDetailLoadingId(id);
      try {
        const d = await getRfq(id);
        setDetailById((m) => ({ ...m, [id]: d }));
      } catch { /* error shown inline */ }
      finally { setDetailLoadingId((cur) => (cur === id ? null : cur)); }
    }
  };

  // Debounced search — wait 200ms after the last keystroke before firing.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const data = await listRfqs({ q: q.trim(), status: status || undefined });
        if (!ctrl.signal.aborted) { setRows(data); setError(null); }
      } catch (e) {
        if (!ctrl.signal.aborted) setError((e as Error).message);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => { window.clearTimeout(t); ctrl.abort(); };
  }, [q, status]);

  // Prune selection to ids still present after a re-filter so a stale id
  // can't slip into a bulk delete.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));

  // Additive per-column sort over the already-fetched rows (the server
  // returns a default order; a header click reorders client-side). Sortable
  // columns map to direct scalar fields or a trivially-correct accessor; the
  // checkbox, Status badge, and Actions columns stay inert.
  const { sorted: sortedRows, sortKey, sortDir, onHeaderClick } = useSort(rows, {
    persistKey: "costing:rfqs:sort",
    accessors: {
      vendor_name: (r) => r.vendor_name ?? "",
      customer_name: (r) => stripExcelPrefix(r.customer_name) ?? "",
      project_name: (r) => r.project_name ?? "",
      due: (r) => (r.due_date || r.delivery_required_by) ?? "",
    },
  });

  // Row click: open the source costing project in a new tab when available
  // (so the operator can edit lines + regenerate the RFQ from the project).
  // Falls back to the RFQ edit view for rows without a linked project.
  const onOpenProject = (r: RfqListRow) => {
    if (r.source_costing_project_id) {
      window.open(`/costing?project=${r.source_costing_project_id}`, "_blank", "noopener");
    } else {
      navigate("rfq-edit", r.id);
    }
  };
  const onOpenRfq = (id: string) => navigate("rfq-edit", id);
  const setNotice = useCostingStore((s) => s.setNotice);
  const onDelete = (r: RfqListRow) => {
    const label = r.title || r.vendor_name || r.id;
    appConfirm(
      `Delete RFQ "${label}"? This permanently removes the header + all line items + invitations + quotes. Cannot be undone.`,
      "Delete",
      async () => {
        try {
          await deleteRfq(r.id);
          setRows((prev) => prev.filter((x) => x.id !== r.id));
          setNotice(`Deleted RFQ "${label}".`, "info");
        } catch (e) {
          setNotice(`Could not delete RFQ: ${(e as Error).message}`, "error");
        }
      },
    );
  };

  const onBulkDelete = () => {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    appConfirm(
      `Delete ${ids.length} RFQ${ids.length === 1 ? "" : "s"}? This permanently removes each header + all line items + invitations + quotes. Cannot be undone.`,
      `Delete ${ids.length}`,
      async () => {
        const failed: string[] = [];
        await Promise.all(
          ids.map(async (id) => {
            try { await deleteRfq(id); } catch { failed.push(id); }
          }),
        );
        const deleted = new Set(ids.filter((id) => !failed.includes(id)));
        setRows((prev) => prev.filter((x) => !deleted.has(x.id)));
        setSelected(new Set());
        if (failed.length === 0) {
          setNotice(`Deleted ${ids.length} RFQ${ids.length === 1 ? "" : "s"}.`, "info");
        } else {
          setNotice(`Deleted ${deleted.size} of ${ids.length}; ${failed.length} failed.`, "error");
        }
      },
    );
  };

  // Bulk "Send to Vendor" — publish all selected RFQs at once (publish + notify
  // their invited vendors). Idempotent server-side, so re-sending an already-
  // published RFQ is fine.
  const onBulkSend = () => {
    const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    appConfirm(
      `Send ${ids.length} RFQ${ids.length === 1 ? "" : "s"} to their invited vendors? This publishes each and notifies the vendor(s).`,
      `Send ${ids.length}`,
      async () => {
        setSending((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; });
        const failed: string[] = [];
        let notified = 0;
        await Promise.all(
          ids.map(async (id) => {
            try { const r = await publishRfq(id); notified += r.notified || 0; }
            catch { failed.push(id); }
          }),
        );
        const sent = new Set(ids.filter((id) => !failed.includes(id)));
        setRows((prev) => prev.map((x) => (sent.has(x.id) ? { ...x, status: "published" } : x)));
        setSending((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
        setSelected(new Set());
        if (failed.length === 0) {
          setNotice(`Sent ${ids.length} RFQ${ids.length === 1 ? "" : "s"} — ${notified} vendor notification${notified === 1 ? "" : "s"} sent.`, "info");
        } else {
          setNotice(`Sent ${sent.size} of ${ids.length}; ${failed.length} failed.`, "error");
        }
      },
    );
  };

  // "Send to Vendor" — publish + notify the invited vendor(s). Idempotent on
  // the server, so the same action re-sends on an already-published RFQ.
  const onSend = (r: RfqListRow) => {
    const vendorLabel = r.vendor_name || "the vendor";
    const isDraft = r.status === "draft";
    appConfirm(
      isDraft
        ? `Send RFQ "${r.title || r.code || "RFQ"}" to ${vendorLabel}? This publishes it and notifies the invited vendor(s).`
        : `Re-send RFQ "${r.title || r.code || "RFQ"}" to ${vendorLabel}? The invited vendor(s) will be notified again.`,
      isDraft ? "Send" : "Re-send",
      async () => {
        setSending((prev) => new Set(prev).add(r.id));
        try {
          const result = await publishRfq(r.id);
          setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "published" } : x));
          const n = result.notified;
          setNotice(
            `RFQ sent to ${vendorLabel} — ${n === 0 ? "no invited vendors to notify yet" : `${n} ${n === 1 ? "vendor has" : "vendors have"} been notified`}.`,
            "info",
          );
        } catch (e) {
          setNotice(`Could not send to vendor: ${(e as Error).message}`, "error");
        } finally {
          setSending((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
        }
      },
    );
  };

  // "Award" — award the RFQ to its invited vendor. The handler requires the
  // vendor to have a SUBMITTED quote and 409s otherwise; the list row carries
  // no quote status, so we offer Award on any published RFQ and surface the
  // handler's error verbatim when the quote isn't ready.
  const onAward = (r: RfqListRow) => {
    if (!r.vendor_id) {
      setNotice("This RFQ has no invited vendor to award.", "error");
      return;
    }
    const vendorLabel = r.vendor_name || "the vendor";
    appConfirm(
      `Award this RFQ to ${vendorLabel}? This notifies the vendor and the Production Manager and flows the price into the costing project.`,
      "Award",
      async () => {
        setAwarding((prev) => new Set(prev).add(r.id));
        try {
          await awardRfq(r.id, r.vendor_id as string);
          setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, status: "awarded" } : x));
          setNotice(`RFQ awarded to ${vendorLabel}. Vendor + Production Manager notified; price flowed into the costing project.`, "info");
        } catch (e) {
          setNotice(`Could not award: ${(e as Error).message}`, "error");
        } finally {
          setAwarding((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
        }
      },
    );
  };

  return (
    <div style={{ padding: "20px 24px", background: "#0F172A", minHeight: "100%", color: "#E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>RFQs</h2>
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          placeholder="Search by vendor, customer, style, or RFQ title…"
          style={{
            flex: 1, maxWidth: 480,
            background: "#1E293B", color: "#E2E8F0",
            border: "1px solid #334155", borderRadius: 4,
            padding: "6px 10px", fontSize: 13, outline: "none",
          }}
        />
        <SearchableSelect
          value={status}
          onChange={(v) => setStatus(v as RfqStatus | "")}
          options={[{ value: "", label: "All statuses" }, ...STATUS_OPTIONS.map((s) => ({ value: s, label: s }))]}
          placeholder="All statuses"
          inputStyle={{
            background: "#1E293B", color: "#E2E8F0",
            border: "1px solid #334155", borderRadius: 4,
            padding: "6px 10px", fontSize: 13, outline: "none",
          }}
        />
        {selected.size > 0 && (
          <>
            <button
              onClick={onBulkSend}
              title="Send all selected RFQs to their invited vendors (publish + notify)"
              style={{
                marginLeft: "auto",
                background: "#1E3A8A", color: "#DBEAFE",
                border: "1px solid #3B82F6", borderRadius: 4,
                padding: "6px 12px", fontSize: 12, fontWeight: 700,
                cursor: "pointer",
              }}
            >Send {selected.size} selected</button>
            <button
              onClick={onBulkDelete}
              title="Delete all selected RFQs (with confirmation)"
              style={{
                background: "#7F1D1D", color: "#FEE2E2",
                border: "1px solid #B91C1C", borderRadius: 4,
                padding: "6px 12px", fontSize: 12, fontWeight: 700,
                cursor: "pointer",
              }}
            >Delete {selected.size} selected</button>
          </>
        )}
        <span style={{ marginLeft: selected.size > 0 ? 0 : "auto", fontSize: 11, color: "#94A3B8" }}>
          {loading ? "Searching…" : `${rows.length} RFQ${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && (
        <div style={{ color: "#F87171", fontSize: 13, padding: 8, background: "#7F1D1D33", borderRadius: 4, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto", border: "1px solid #334155", borderRadius: 6, background: "#1E293B" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ background: "#0F172A" }}>
            <tr>
              <Th align="center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  title={allSelected ? "Clear selection" : "Select all"}
                  style={{ cursor: "pointer", accentColor: "#60A5FA" }}
                />
              </Th>
              <SortableTh label="Code" sortKey="code" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Title" sortKey="title" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Vendor" sortKey="vendor_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Customer" sortKey="customer_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Project" sortKey="project_name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Lines" sortKey="line_count" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle("right")} />
              <SortableTh label="Est Qty" sortKey="estimated_quantity" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle("right")} />
              <SortableTh label="Est Budget" sortKey="estimated_budget" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle("right")} />
              <SortableTh label="Target Cost / Unit" sortKey="target_cost" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle("right")} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Due" sortKey="due" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <SortableTh label="Created" sortKey="created_at" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={thStyle()} />
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={14} style={{ padding: 24, textAlign: "center", color: "#64748B" }}>
                {q || status ? "No RFQs match the filter." : "No RFQs yet — generate one from a Costing project."}
              </td></tr>
            )}
            {sortedRows.map((r) => {
              const sc = STATUS_COLOR[r.status] || STATUS_COLOR.draft;
              const isExpanded = expandedId === r.id;
              return (
                <React.Fragment key={r.id}>
                <tr
                  onClick={() => onOpenProject(r)}
                  style={{ borderTop: "1px solid #334155", cursor: "pointer", background: isExpanded ? "#243042" : "transparent" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#334155"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = isExpanded ? "#243042" : "transparent"; }}
                  title={r.source_costing_project_id ? "Open source project in new tab" : "Click to view + edit RFQ"}
                >
                  <Td align="center">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleOne(r.id)}
                      title="Select for bulk delete"
                      style={{ cursor: "pointer", accentColor: "#60A5FA" }}
                    />
                  </Td>
                  <Td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); void toggleExpand(r.id); }}
                        title={isExpanded ? "Collapse line items" : "Expand to see styles + quoted prices"}
                        style={{
                          background: "transparent", border: "none", padding: 0, cursor: "pointer",
                          color: "#94A3B8", fontSize: 11, lineHeight: 1, width: 12, flexShrink: 0,
                        }}
                      >{isExpanded ? "▾" : "▸"}</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenRfq(r.id); }}
                        title="Open RFQ"
                        style={{
                          background: "transparent", border: "none", padding: 0, cursor: "pointer",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: 12, color: "#CBD5E1", whiteSpace: "nowrap",
                          textDecoration: "underline", textDecorationColor: "#475569",
                        }}
                      >{r.code || "—"}</button>
                    </div>
                  </Td>
                  <Td>
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenRfq(r.id); }}
                      title="Open RFQ"
                      style={{
                        background: "transparent", border: "none", padding: 0, cursor: "pointer",
                        color: "#60A5FA", fontWeight: 600, textAlign: "left",
                        textDecoration: "underline", textDecorationColor: "#3B82F6",
                      }}
                    >{r.title || "(untitled)"}</button>
                  </Td>
                  <Td>{r.vendor_name || "—"}</Td>
                  <Td>{stripExcelPrefix(r.customer_name) || "—"}</Td>
                  <Td>{r.project_name || "—"}</Td>
                  <Td align="right">{r.line_count}</Td>
                  <Td align="right">{typeof r.estimated_quantity === "number" ? fmtQty.format(r.estimated_quantity) : "—"}</Td>
                  <Td align="right">{typeof r.estimated_budget === "number" ? `${r.currency || "USD"} ${fmtMoney.format(r.estimated_budget)}` : "—"}</Td>
                  <Td align="right">{typeof r.target_cost === "number" ? `${r.currency || "USD"} ${fmtUnit.format(r.target_cost)}` : "—"}</Td>
                  <Td>
                    <span style={{ background: sc.bg, color: sc.fg, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      {r.status}
                    </span>
                  </Td>
                  <Td>{(r.due_date || r.delivery_required_by) ? fmtDateDisplay((r.due_date || r.delivery_required_by) as string) : "—"}</Td>
                  <Td>{r.created_at ? fmtDateDisplay(r.created_at.slice(0, 10)) : "—"}</Td>
                  <Td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {(r.status === "draft" || r.status === "published") && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onSend(r); }}
                          disabled={sending.has(r.id)}
                          title={r.status === "draft"
                            ? "Send to vendor — publish + notify the invited vendor(s)"
                            : "Re-send — re-notify the invited vendor(s)"}
                          style={{
                            background: r.status === "draft" ? "#1D4ED8" : "transparent",
                            color: r.status === "draft" ? "#FFFFFF" : "#60A5FA",
                            border: "1px solid #1D4ED8", borderRadius: 3,
                            padding: "2px 8px", fontSize: 11, fontWeight: 600,
                            cursor: sending.has(r.id) ? "wait" : "pointer",
                            opacity: sending.has(r.id) ? 0.6 : 1,
                            whiteSpace: "nowrap",
                          }}
                        >{sending.has(r.id) ? "Sending…" : r.status === "draft" ? "Send" : "Re-send"}</button>
                      )}
                      {r.status === "published" && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onAward(r); }}
                          disabled={awarding.has(r.id)}
                          title="Award to the invited vendor — notifies the vendor + Production Manager and flows the price into costing (requires a submitted quote)"
                          style={{
                            background: "#047857", color: "#FFFFFF",
                            border: "1px solid #047857", borderRadius: 3,
                            padding: "2px 8px", fontSize: 11, fontWeight: 600,
                            cursor: awarding.has(r.id) ? "wait" : "pointer",
                            opacity: awarding.has(r.id) ? 0.6 : 1,
                            whiteSpace: "nowrap",
                          }}
                        >{awarding.has(r.id) ? "Awarding…" : "Award"}</button>
                      )}
                      {r.status === "awarded" && (
                        <span
                          title="This RFQ has been awarded"
                          style={{
                            color: "#10B981", border: "1px solid #10B981",
                            borderRadius: 3, padding: "2px 8px", fontSize: 11, fontWeight: 700,
                            textTransform: "uppercase", letterSpacing: ".04em", whiteSpace: "nowrap",
                          }}
                        >✓ Awarded</span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(r); }}
                        title="Delete this RFQ (with confirmation)"
                        style={{
                          background: "transparent", color: "#F87171",
                          border: "1px solid #7F1D1D", borderRadius: 3,
                          padding: "2px 8px", fontSize: 11, fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >Delete</button>
                    </div>
                  </Td>
                </tr>
                {isExpanded && (
                  <tr style={{ background: "#0F172A" }}>
                    <td colSpan={14} style={{ padding: 0, borderTop: "1px solid #334155" }}>
                      <RfqExpandPanel
                        detail={detailById[r.id]}
                        loading={detailLoadingId === r.id}
                        currency={r.currency || "USD"}
                      />
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function thStyle(align?: "left" | "right" | "center"): React.CSSProperties {
  return { textAlign: align || "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "#94A3B8", textTransform: "uppercase", letterSpacing: ".06em" };
}
function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return <th style={thStyle(align)}>{children}</th>;
}
function Td({ children, align }: { children: React.ReactNode; align?: "left" | "right" | "center" }) {
  return <td style={{ padding: "8px 12px", color: "#E2E8F0", textAlign: align || "left" }}>{children}</td>;
}

// Inline-expand panel: each RFQ line (style) × the vendors' quoted unit prices.
// Lets the operator see, at a glance, which styles a vendor has actually quoted.
function RfqExpandPanel({ detail, loading, currency }: { detail?: RfqDetail; loading: boolean; currency: string }) {
  const pad: React.CSSProperties = { padding: "12px 16px 12px 34px", color: "#94A3B8", fontSize: 12 };
  if (loading && !detail) return <div style={pad}>Loading line items…</div>;
  if (!detail) return <div style={pad}>Could not load line items.</div>;
  const items: RfqLineItem[] = detail.line_items || [];
  const quotes: RfqQuoteSummary[] = detail.quotes || [];
  if (items.length === 0) return <div style={pad}>This RFQ has no line items.</div>;

  // quoteId → (rfq_line_item_id → unit_price)
  const lookup = new Map<string, Map<string, number | null>>();
  for (const q of quotes) {
    const m = new Map<string, number | null>();
    for (const l of q.lines) m.set(l.rfq_line_item_id, l.unit_price);
    lookup.set(q.id, m);
  }
  const money = (n: number | null | undefined) =>
    typeof n === "number" && Number.isFinite(n) ? `${currency} ${n.toFixed(2)}` : "—";
  const cellL: React.CSSProperties = { padding: "5px 10px", textAlign: "left", whiteSpace: "nowrap" };
  const cellR: React.CSSProperties = { padding: "5px 10px", textAlign: "right", whiteSpace: "nowrap" };

  return (
    <div style={{ padding: "10px 16px 14px 34px" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#94A3B8", textTransform: "uppercase", fontSize: 10, letterSpacing: ".04em" }}>
            <th style={cellL}>Style / Item</th>
            <th style={cellR}>Qty</th>
            <th style={cellR}>Target</th>
            {quotes.map((q) => (
              <th key={q.id} style={cellR}>{q.vendor_name || "Vendor"}{q.status ? ` · ${q.status}` : ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((li) => (
            <tr key={li.id} style={{ borderTop: "1px solid #1E293B" }}>
              <td style={cellL}>
                <span style={{ fontWeight: 600, color: "#E2E8F0" }}>{li.style_code || li.description || "(item)"}</span>
                {li.color ? <span style={{ color: "#94A3B8" }}> · {li.color}</span> : null}
              </td>
              <td style={cellR}>{typeof li.quantity === "number" ? li.quantity.toLocaleString() : "—"}</td>
              <td style={{ ...cellR, color: "#94A3B8" }}>{money(li.target_price)}</td>
              {quotes.map((q) => {
                const price = lookup.get(q.id)?.get(li.id);
                const quoted = typeof price === "number";
                return (
                  <td key={q.id} style={{ ...cellR, color: quoted ? "#A7F3D0" : "#64748B", fontWeight: quoted ? 600 : 400 }}>
                    {money(price ?? null)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {quotes.length === 0 && (
        <div style={{ marginTop: 8, color: "#64748B", fontSize: 11 }}>No vendor has submitted quoted prices yet.</div>
      )}
    </div>
  );
}
