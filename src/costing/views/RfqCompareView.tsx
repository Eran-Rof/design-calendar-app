// Costing Module — Compare RFQs view.
//
// Pick a costing PROJECT, then see EVERY vendor quote across that project's
// RFQs in one comparison matrix. Per RFQ: rows = line items, columns = each
// vendor that quoted, cells = unit price (+ extended). The matrix POINTS OUT
// the differences:
//   • cheapest unit price per line is highlighted green (and tagged "best")
//   • each non-cheapest cell shows its % above the line's lowest price
//   • the per-line spread (max − min) is shown in a dedicated column
//   • per-vendor footer totals (Σ extended) + WEIGHTED MARGIN + lead time
//   • each cell shows the line's gross margin (sell − quoted)/sell vs the
//     reference sell_price from the source costing line ("—" when unknown)
//   • the overall cheapest vendor AND the best-margin vendor are both flagged
//     (they can differ) per RFQ
//   • a project-level summary names lowest-total + best-margin + fastest-lead
//   • vendor quote-level notes + per-line notes are surfaced

import React, { useEffect, useMemo, useRef, useState } from "react";
import { compareEligibleProjects, compareRfqs } from "../services/costingApi";
import type {
  CostingProject,
  RfqCompareResult,
  RfqCompareRfq,
  RfqCompareQuote,
} from "../services/costingApi";
import { fmtDateDisplay } from "../helpers";
import CollapsibleHeader from "../panels/CollapsibleHeader";
import { useCanSeeMargins } from "../../hooks/useCanSeeMargins";

const fmtUnit = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// DARK palette — matches the rest of the Costing module (RfqListView): page
// #0F172A, cards #1E293B, borders #334155, text #E2E8F0, muted #94A3B8.
const C = {
  pageBg: "#0F172A",
  card: "#1E293B",
  border: "#334155",
  borderStrong: "#475569",
  text: "#E2E8F0",
  subtle: "#94A3B8",
  headerBg: "#1E293B",
  // thead / tfoot / summary bands — darker than the card so they read as header
  // rows against the #1E293B card (matches RfqListView thead = page bg).
  bandBg: "#0F172A",
  hover: "#334155",     // row/option hover + selected on dark
  best: "#064E3B",      // cheapest cell fill (green, on dark)
  bestFg: "#6EE7B7",
  bestBorder: "#065F46",
  worst: "rgba(127,29,29,0.35)", // subtle red tint for the priciest
  accent: "#60A5FA",
  // Margin colors (legible on dark).
  marginGood: "#6EE7B7",
  marginThin: "#FBBF24",
  marginBad: "#F87171",
  pctAbove: "#FBBF24",  // "+x% above lowest" (amber on dark)
};

// Margin color tiers (operator spec 2026-06-05): >=20% healthy (green),
// 18-19.99% thin (amber), below 18% (incl. negative) bad (red).
const HEALTHY_MARGIN = 0.20;
const THIN_MARGIN = 0.18;

function money(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${fmtMoney.format(n)}` : "—";
}
function unit(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${fmtUnit.format(n)}` : "—";
}
// Gross margin (fraction 0..1) if bought at `quoted` and sold at `sell`.
function margin(sell: number | null | undefined, quoted: number | null | undefined): number | null {
  if (typeof sell !== "number" || !Number.isFinite(sell) || sell <= 0) return null;
  if (typeof quoted !== "number" || !Number.isFinite(quoted)) return null;
  return (sell - quoted) / sell;
}
function marginColor(m: number | null): string {
  if (m === null) return C.subtle;
  if (m >= HEALTHY_MARGIN) return C.marginGood;   // >=20% green
  if (m >= THIN_MARGIN) return C.marginThin;       // 18-19.99% amber
  return C.marginBad;                              // <18% (incl. negative) red
}
function pctMargin(m: number | null): string {
  return m === null ? "—" : `${(m * 100).toFixed(2)}%`;
}

export default function RfqCompareView() {
  const [projects, setProjects] = useState<CostingProject[]>([]);
  const [projLoading, setProjLoading] = useState(false);
  const [projErr, setProjErr] = useState<string | null>(null);

  const [picked, setPicked] = useState<string>("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<RfqCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load projects for the picker — only those with RFQs that have vendor quotes.
  // Auto-select the first (newest) project so the comparison loads immediately.
  useEffect(() => {
    let alive = true;
    setProjLoading(true);
    compareEligibleProjects()
      .then((rows) => {
        if (!alive) return;
        setProjects(rows);
        setProjErr(null);
        if (rows.length > 0) setPicked((prev) => prev || rows[0].id);
      })
      .catch((e) => { if (alive) setProjErr((e as Error).message); })
      .finally(() => { if (alive) setProjLoading(false); });
    return () => { alive = false; };
  }, []);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Load the comparison when a project is picked.
  useEffect(() => {
    if (!picked) { setData(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    compareRfqs(picked)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [picked]);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = projects.filter((p) => p.project_name);
    if (!q) return list.slice(0, 100);
    return list.filter((p) => p.project_name.toLowerCase().includes(q)).slice(0, 100);
  }, [projects, search]);

  const pickedName = projects.find((p) => p.id === picked)?.project_name || "";

  return (
    <div style={{ padding: 24, background: C.pageBg, minHeight: "100%", color: C.text }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 4px" }}>Compare RFQs</h1>
      <p style={{ margin: "0 0 20px", color: C.subtle, fontSize: 13 }}>
        Pick a costing project to see every vendor quote across its RFQs side by side — the cheapest
        price per line is highlighted, with each vendor&apos;s delta vs. the lowest, totals, and lead times.
      </p>

      {/* Searchable project picker */}
      <div ref={boxRef} style={{ position: "relative", maxWidth: 460, marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.subtle, marginBottom: 6 }}>
          Project
        </label>
        <input
          value={open ? search : pickedName || search}
          placeholder={projLoading ? "Loading projects…" : "Search a project by name…"}
          onFocus={() => { setOpen(true); setSearch(""); }}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          style={{
            width: "100%", padding: "9px 12px", fontSize: 14, color: C.text,
            border: `1px solid ${C.borderStrong}`, borderRadius: 8, background: C.card, boxSizing: "border-box",
          }}
        />
        {open && (
          <div style={{
            position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 30,
            background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)", maxHeight: 320, overflowY: "auto",
          }}>
            {projErr && <div style={{ padding: 12, color: "#F87171", fontSize: 13 }}>{projErr}</div>}
            {!projErr && filteredProjects.length === 0 && (
              <div style={{ padding: 12, color: C.subtle, fontSize: 13 }}>
                {projects.length === 0 ? "No projects have vendor quotes to compare yet." : "No matching projects."}
              </div>
            )}
            {filteredProjects.map((p) => (
              <div
                key={p.id}
                onClick={() => { setPicked(p.id); setOpen(false); setSearch(""); }}
                style={{
                  padding: "9px 12px", fontSize: 13, cursor: "pointer", color: C.text,
                  background: p.id === picked ? C.hover : "transparent",
                  borderBottom: `1px solid ${C.border}`,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = C.hover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = p.id === picked ? C.hover : "transparent")}
              >
                {p.project_name}
                {p.brand && <span style={{ color: C.subtle, marginLeft: 8 }}>· {p.brand}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && <div style={{ color: C.subtle, fontSize: 14 }}>Loading comparison…</div>}
      {error && <div style={{ color: "#F87171", fontSize: 14 }}>{error}</div>}

      {!loading && !error && picked && data && (
        <CompareBody data={data} />
      )}
      {!loading && !error && !picked && (
        <div style={{ color: C.subtle, fontSize: 14, marginTop: 8 }}>
          Select a project above to build the comparison.
        </div>
      )}
    </div>
  );
}

function CompareBody({ data }: { data: RfqCompareResult }) {
  const rfqsWithQuotes = data.rfqs.filter((r) => r.quotes.length > 0);
  if (data.rfqs.length === 0) {
    return <div style={{ color: C.subtle, fontSize: 14 }}>This project has no RFQs yet.</div>;
  }
  if (rfqsWithQuotes.length === 0) {
    return (
      <div style={{ color: C.subtle, fontSize: 14 }}>
        This project has {data.rfqs.length} RFQ{data.rfqs.length === 1 ? "" : "s"}, but none have a submitted vendor quote yet.
      </div>
    );
  }
  return (
    <div>
      {data.rfqs.map((rfq) => (
        <RfqMatrix key={rfq.id} rfq={rfq} />
      ))}
    </div>
  );
}

// Extended total per quote = Σ(unit_price × qty). Quantity preference:
// the quote-line quantity, else the RFQ line item's quantity.
function quoteExtendedTotal(rfq: RfqCompareRfq, q: RfqCompareQuote): number | null {
  const qtyByItem = new Map<string, number>();
  for (const li of rfq.line_items) qtyByItem.set(li.id, typeof li.quantity === "number" ? li.quantity : 0);
  let total = 0;
  let any = false;
  for (const ql of q.lines) {
    if (typeof ql.unit_price !== "number") continue;
    const qty = typeof ql.quantity === "number" ? ql.quantity : (qtyByItem.get(ql.rfq_line_item_id) ?? 0);
    total += ql.unit_price * qty;
    any = true;
  }
  return any ? total : (typeof q.total_price === "number" ? q.total_price : null);
}

function RfqMatrix({ rfq }: { rfq: RfqCompareRfq }) {
  const quotes = rfq.quotes;
  const hasQuotes = quotes.length > 0;
  // Margin-visibility gate (P14 RBAC `margins:read`). When false, every margin
  // surface in the matrix — the per-cell "mgn", the per-vendor "Weighted margin"
  // footer, the project-summary "Best margin", and the "best margin" vendor pill
  // — is simply absent. Cost/price/spread cells are unaffected. Fail-open today.
  const { canView: canViewMargins } = useCanSeeMargins();

  // Per-line sell-price overrides — seeded from server data, editable inline.
  // useEffect re-seeds whenever the server returns updated sell_price values so
  // stale snapshots don't persist across re-fetches (lazy initializer only runs once).
  const [sellOverrides, setSellOverrides] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const li of rfq.line_items) {
      if (typeof li.sell_price === "number" && li.sell_price > 0) m.set(li.id, li.sell_price);
    }
    return m;
  });
  const [sellDrafts, setSellDrafts] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const li of rfq.line_items) {
      if (typeof li.sell_price === "number" && li.sell_price > 0) m.set(li.id, fmtUnit.format(li.sell_price));
    }
    return m;
  });
  // Re-seed sell state when server data changes (e.g. after costing line revision).
  // Only overwrite cells that have NOT been manually edited (i.e. still equal to the
  // previous server value or absent) to avoid clobbering in-progress edits.
  useEffect(() => {
    setSellOverrides(prev => {
      const next = new Map(prev);
      for (const li of rfq.line_items) {
        if (typeof li.sell_price === "number" && li.sell_price > 0) next.set(li.id, li.sell_price);
      }
      return next;
    });
    setSellDrafts(prev => {
      const next = new Map(prev);
      for (const li of rfq.line_items) {
        if (typeof li.sell_price === "number" && li.sell_price > 0) next.set(li.id, fmtUnit.format(li.sell_price));
      }
      return next;
    });
  // rfq.id ensures re-seed on RFQ switch; JSON-stringify line sell prices triggers
  // re-seed when the server returns a revised value for the same RFQ.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfq.id, rfq.line_items.map(li => li.sell_price).join(",")]);

  // unit price lookup: vendorIdx → (rfq_line_item_id → {unit, qty, notes})
  const priceByVendorLine = useMemo(() => {
    return quotes.map((q) => {
      const m = new Map<string, { unit: number | null; qty: number | null; notes: string | null }>();
      for (const l of q.lines) {
        m.set(l.rfq_line_item_id, { unit: l.unit_price, qty: l.quantity, notes: l.notes });
      }
      return m;
    });
  }, [quotes]);

  // Per-quote extended totals + the cheapest-overall vendor for this RFQ.
  const extendedTotals = useMemo(
    () => quotes.map((q) => quoteExtendedTotal(rfq, q)),
    [rfq, quotes],
  );
  const cheapestVendorIdx = useMemo(() => {
    let best = -1; let bestVal = Infinity;
    extendedTotals.forEach((t, i) => {
      if (typeof t === "number" && t < bestVal) { bestVal = t; best = i; }
    });
    return best;
  }, [extendedTotals]);

  // Effective sell prices: user override if set, else server value.
  const effectiveSellByItem = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const li of rfq.line_items) m.set(li.id, typeof li.sell_price === "number" ? li.sell_price : null);
    for (const [id, v] of sellOverrides) m.set(id, v);
    return m;
  }, [rfq.line_items, sellOverrides]);

  // Per-vendor WEIGHTED margin — recalculates whenever sell prices change.
  const vendorMargins = useMemo(() => {
    return quotes.map((q) => {
      const qtyByItem = new Map<string, number>();
      for (const li of rfq.line_items) qtyByItem.set(li.id, typeof li.quantity === "number" ? li.quantity : 0);
      let sumSell = 0; let sumQuoted = 0; let any = false;
      for (const ql of q.lines) {
        const sell = effectiveSellByItem.get(ql.rfq_line_item_id) ?? null;
        if (typeof sell !== "number" || sell <= 0 || typeof ql.unit_price !== "number") continue;
        const qty = typeof ql.quantity === "number" ? ql.quantity : (qtyByItem.get(ql.rfq_line_item_id) ?? 0);
        if (qty <= 0) continue;
        sumSell += sell * qty;
        sumQuoted += ql.unit_price * qty;
        any = true;
      }
      return any && sumSell > 0 ? (sumSell - sumQuoted) / sumSell : null;
    });
  }, [quotes, rfq.line_items, effectiveSellByItem]);

  // Vendor with the BEST overall margin (may differ from cheapest total).
  const bestMarginVendorIdx = useMemo(() => {
    let best = -1; let bestVal = -Infinity;
    vendorMargins.forEach((m, i) => {
      if (typeof m === "number" && m > bestVal) { bestVal = m; best = i; }
    });
    return best;
  }, [vendorMargins]);

  // Lead-time spread for the project-level summary.
  const leadTimes = quotes
    .map((q, i) => ({ i, lt: q.lead_time_days }))
    .filter((x) => typeof x.lt === "number") as { i: number; lt: number }[];
  const fastest = leadTimes.length ? leadTimes.reduce((a, b) => (b.lt < a.lt ? b : a)) : null;

  const colW = 150;

  if (!hasQuotes) {
    return (
      <div style={cardStyle}>
        <MatrixHeader rfq={rfq} />
        <div style={{ padding: 16, color: C.subtle, fontSize: 13 }}>No submitted quotes for this RFQ.</div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <MatrixHeader rfq={rfq} />

      {/* Project-level summary line — collapsible via the ▾ triangle. */}
      <CollapsibleHeader
        storageKey={`compare-summary-${rfq.id}`}
        title="summary"
        style={{ padding: "10px 16px", background: C.bandBg, borderBottom: `1px solid ${C.border}`, fontSize: 13 }}
        collapsedSummary={
          <div style={{ color: C.subtle, fontSize: 12, paddingRight: 24 }}>
            {cheapestVendorIdx >= 0
              ? `Lowest: ${quotes[cheapestVendorIdx].vendor_name || "Vendor"} (${money(extendedTotals[cheapestVendorIdx])})`
              : "No priced quotes"}
            {` · ${quotes.length} vendor${quotes.length === 1 ? "" : "s"}`}
          </div>
        }
      >
      <div style={{ fontSize: 13 }}>
        {cheapestVendorIdx >= 0 ? (
          <span>
            <strong style={{ color: C.bestFg }}>Lowest total:</strong>{" "}
            {quotes[cheapestVendorIdx].vendor_name || "Vendor"}{" "}
            ({money(extendedTotals[cheapestVendorIdx])})
          </span>
        ) : (
          <span style={{ color: C.subtle }}>No priced quotes to total.</span>
        )}
        {canViewMargins && bestMarginVendorIdx >= 0 && vendorMargins[bestMarginVendorIdx] !== null && (
          <span style={{ marginLeft: 18 }}>
            <strong style={{ color: C.bestFg }}>Best margin:</strong>{" "}
            {quotes[bestMarginVendorIdx].vendor_name || "Vendor"}{" "}
            (<span style={{ color: marginColor(vendorMargins[bestMarginVendorIdx]) }}>
              {pctMargin(vendorMargins[bestMarginVendorIdx])}
            </span>)
          </span>
        )}
        {fastest && (
          <span style={{ marginLeft: 18 }}>
            <strong>Fastest lead:</strong> {quotes[fastest.i].vendor_name || "Vendor"} ({fastest.lt}d)
          </span>
        )}
        <span style={{ marginLeft: 18, color: C.subtle }}>
          {quotes.length} vendor{quotes.length === 1 ? "" : "s"} · {rfq.line_items.length} line{rfq.line_items.length === 1 ? "" : "s"}
        </span>
      </div>
      </CollapsibleHeader>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.bandBg }}>
              <th style={{ ...thStyle, position: "sticky", left: 0, background: C.bandBg, minWidth: 240, textAlign: "left" }}>
                Line item
              </th>
              {quotes.map((q, i) => (
                <th key={q.vendor_id + i} style={{ ...thStyle, minWidth: colW }}>
                  <div style={{ fontWeight: 700, color: C.text }}>
                    {q.vendor_name || "Vendor"}
                    {i === cheapestVendorIdx && (
                      <span style={bestPill}>cheapest</span>
                    )}
                    {canViewMargins && i === bestMarginVendorIdx && vendorMargins[i] !== null && (
                      <span style={bestMarginPill}>best margin</span>
                    )}
                  </div>
                  {q.status && <div style={{ fontSize: 11, color: C.subtle, fontWeight: 400 }}>{q.status}</div>}
                </th>
              ))}
              <th style={{ ...thStyle, minWidth: 110 }}>Spread</th>
            </tr>
          </thead>
          <tbody>
            {rfq.line_items.map((li) => {
              // Collect this line's unit prices across vendors.
              const cells = priceByVendorLine.map((m) => m.get(li.id) || null);
              const prices = cells
                .map((c, i) => ({ i, p: c?.unit }))
                .filter((x) => typeof x.p === "number") as { i: number; p: number }[];
              const min = prices.length ? Math.min(...prices.map((x) => x.p)) : null;
              const max = prices.length ? Math.max(...prices.map((x) => x.p)) : null;
              const spread = min !== null && max !== null ? max - min : null;

              return (
                <tr key={li.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...tdStyle, position: "sticky", left: 0, background: C.card, textAlign: "left" }}>
                    <div style={{ fontWeight: 600 }}>
                      #{li.line_index ?? "?"} {li.description || "(no description)"}
                    </div>
                    <div style={{ fontSize: 11, color: C.subtle }}>
                      qty {typeof li.quantity === "number" ? fmtMoney.format(li.quantity) : "—"}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                      <span style={{ fontSize: 10, color: C.subtle, whiteSpace: "nowrap" }}>Sell $</span>
                      <input
                        title="What-if sell price — recomputes the margins below. Local to this view only; does NOT change the project row."
                        value={sellDrafts.get(li.id) ?? ""}
                        // Live what-if: update the override on every keystroke so the
                        // margin cells + per-vendor margin recompute immediately (not
                        // only on blur). Local state only — never written to the line.
                        onChange={(e) => {
                          const text = e.target.value;
                          setSellDrafts((p) => new Map(p).set(li.id, text));
                          const val = parseFloat(text.replace(/[^0-9.]/g, ""));
                          setSellOverrides((p) => {
                            const next = new Map(p);
                            if (!isNaN(val) && val > 0) next.set(li.id, val);
                            else next.delete(li.id);
                            return next;
                          });
                        }}
                        placeholder="—"
                        style={{
                          width: 60, padding: "2px 4px", fontSize: 11,
                          background: "#0F172A", border: `1px solid ${C.borderStrong}`,
                          borderRadius: 3, color: C.text, outline: "none",
                        }}
                      />
                    </div>
                  </td>
                  {cells.map((c, i) => {
                    const isMin = min !== null && typeof c?.unit === "number" && c.unit === min;
                    const isMax = max !== null && min !== null && max !== min && typeof c?.unit === "number" && c.unit === max;
                    const pctAbove =
                      typeof c?.unit === "number" && min !== null && min > 0 && c.unit > min
                        ? ((c.unit - min) / min) * 100
                        : 0;
                    const qty = typeof c?.qty === "number" ? c.qty : (typeof li.quantity === "number" ? li.quantity : null);
                    const ext = typeof c?.unit === "number" && typeof qty === "number" ? c.unit * qty : null;
                    const mgn = margin(effectiveSellByItem.get(li.id), c?.unit);
                    return (
                      <td
                        key={i}
                        title={c?.notes || undefined}
                        style={{
                          ...tdStyle,
                          background: isMin ? C.best : isMax ? C.worst : undefined,
                          fontWeight: isMin ? 700 : 400,
                          color: isMin ? C.bestFg : C.text,
                          border: isMin ? `1px solid ${C.bestBorder}` : undefined,
                        }}
                      >
                        {c && typeof c.unit === "number" ? (
                          <>
                            <div>{unit(c.unit)}{isMin && <span style={{ fontSize: 10, marginLeft: 4 }}>best</span>}</div>
                            {ext !== null && <div style={{ fontSize: 11, color: C.subtle }}>ext {money(ext)}</div>}
                            {canViewMargins && (
                              <div style={{ fontSize: 11, color: marginColor(mgn), fontWeight: mgn !== null ? 600 : 400 }}>
                                mgn {pctMargin(mgn)}
                              </div>
                            )}
                            {pctAbove > 0 && (
                              <div style={{ fontSize: 11, color: C.pctAbove }}>+{fmtPct.format(pctAbove)}%</div>
                            )}
                            {c.notes && <div style={{ fontSize: 10, color: C.subtle, fontStyle: "italic" }} title={c.notes}>note</div>}
                          </>
                        ) : (
                          <span style={{ color: C.subtle }}>—</span>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ ...tdStyle, color: spread ? C.pctAbove : C.subtle }}>
                    {spread !== null ? unit(spread) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${C.borderStrong}`, background: C.bandBg }}>
              <td style={{ ...tdStyle, position: "sticky", left: 0, background: C.bandBg, fontWeight: 700, textAlign: "left" }}>
                Total
              </td>
              {quotes.map((q, i) => (
                <td
                  key={q.vendor_id + i}
                  style={{
                    ...tdStyle, fontWeight: 700,
                    background: i === cheapestVendorIdx ? C.best : C.bandBg,
                    color: i === cheapestVendorIdx ? C.bestFg : C.text,
                  }}
                >
                  {money(extendedTotals[i])}
                </td>
              ))}
              <td style={{ ...tdStyle, background: C.bandBg }} />
            </tr>
            {canViewMargins && (
            <tr style={{ background: C.bandBg }}>
              <td style={{ ...tdStyle, position: "sticky", left: 0, background: C.bandBg, fontWeight: 700, textAlign: "left" }}>
                Weighted margin
              </td>
              {quotes.map((q, i) => {
                const m = vendorMargins[i];
                const isBest = i === bestMarginVendorIdx && m !== null;
                return (
                  <td
                    key={q.vendor_id + i}
                    style={{
                      ...tdStyle, fontWeight: 700,
                      background: isBest ? C.best : C.bandBg,
                      color: m === null ? C.subtle : marginColor(m),
                    }}
                  >
                    {pctMargin(m)}
                    {isBest && <span style={{ fontSize: 10, marginLeft: 4 }}>best</span>}
                  </td>
                );
              })}
              <td style={{ ...tdStyle, background: C.bandBg }} />
            </tr>
            )}
            <tr style={{ background: C.bandBg }}>
              <td style={{ ...tdStyle, position: "sticky", left: 0, background: C.bandBg, fontWeight: 600, textAlign: "left", color: C.subtle }}>
                Lead time · Valid until
              </td>
              {quotes.map((q, i) => (
                <td key={q.vendor_id + i} style={{ ...tdStyle, background: C.bandBg, fontSize: 12, color: C.subtle }}>
                  <div>{typeof q.lead_time_days === "number" ? `${q.lead_time_days}d` : "—"}</div>
                  <div>{q.valid_until ? fmtDateDisplay(q.valid_until) : "—"}</div>
                </td>
              ))}
              <td style={{ ...tdStyle, background: C.bandBg }} />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Vendor quote-level notes */}
      {quotes.some((q) => q.notes) && (
        <div style={{ padding: "10px 16px", borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
          <div style={{ fontWeight: 600, color: C.subtle, marginBottom: 4 }}>Vendor notes</div>
          {quotes.filter((q) => q.notes).map((q, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              <strong>{q.vendor_name || "Vendor"}:</strong> {q.notes}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MatrixHeader({ rfq }: { rfq: RfqCompareRfq }) {
  // Most recent quote-submission date across this RFQ's vendor quotes.
  const lastQuotedAt = (rfq.quotes || [])
    .map((q) => q.submitted_at)
    .filter((d): d is string => !!d)
    .sort()
    .pop() || null;
  // Flex row with a gap so code / title / status / date are clearly separated
  // (and copy with real whitespace, not just CSS margins).
  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
      {rfq.code ? <span style={{ fontSize: 15, fontWeight: 700, color: C.accent }}>{rfq.code}</span> : null}
      <span style={{ fontSize: 15, fontWeight: 700 }}>{rfq.title || "(untitled RFQ)"}</span>
      {rfq.status && (
        <span style={{ fontSize: 11, color: C.subtle, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {rfq.status}
        </span>
      )}
      {lastQuotedAt && (
        <span style={{ fontSize: 11, color: C.subtle }}>
          quoted {fmtDateDisplay(lastQuotedAt)}
        </span>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  marginBottom: 24,
  overflow: "hidden",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  textAlign: "center",
  fontWeight: 600,
  color: C.subtle,
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  textAlign: "center",
  verticalAlign: "top",
};

const bestPill: React.CSSProperties = {
  marginLeft: 6,
  fontSize: 10,
  fontWeight: 700,
  color: C.bestFg,
  background: C.best,
  border: `1px solid ${C.bestBorder}`,
  borderRadius: 6,
  padding: "1px 5px",
  textTransform: "uppercase",
};

const bestMarginPill: React.CSSProperties = {
  marginLeft: 6,
  fontSize: 10,
  fontWeight: 700,
  color: "#0F172A",
  background: C.marginGood,
  border: `1px solid ${C.marginGood}`,
  borderRadius: 6,
  padding: "1px 5px",
  textTransform: "uppercase",
};
