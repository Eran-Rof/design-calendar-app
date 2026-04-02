import React from "react";
import S from "./styles";
import { StatCard } from "./StatCard";
import { fmtDate, fmtDateShort, fmtDateDisplay, fmtDateHeader, isToday, isWeekend, getQtyColor, getQtyBg } from "./helpers";

export type ATSRenderCtx = Record<string, any>;

export function atsRenderPanel(ctx: ATSRenderCtx): React.ReactElement {
  const { startDate, setStartDate, rangeUnit, setRangeUnit, rangeValue, setRangeValue, search, setSearch, filterCategory, setFilterCategory, filterStatus, setFilterStatus, minATS, setMinATS, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen, soDropOpen, setSoDropOpen, rows, setRows, loading, mockMode, page, setPage, excelData, setExcelData, uploadingFile, uploadProgress, uploadSuccess, setUploadSuccess, uploadError, setUploadError, uploadWarnings, setUploadWarnings, pendingUploadData, setPendingUploadData, showUpload, setShowUpload, invFile, setInvFile, purFile, setPurFile, ordFile, setOrdFile, syncing, syncStatus, lastSync, syncError, setSyncError, hoveredCell, setHoveredCell, pinnedSku, setPinnedSku, ctxMenu, setCtxMenu, summaryCtx, setSummaryCtx, activeSort, setActiveSort, sortCol, sortDir, STORES, PAGE_SIZE, poStores, soStores, poDropRef, soDropRef, invRef, purRef, ordRef, ctxRef, summaryCtxRef, tableRef, dates, displayPeriods, eventIndex, filtered, statFiltered, sortedFiltered, pageRows, totalPages, categories, filteredSkuSet, totalSoValue, totalPoValue, marginDollars, marginPct, handleFileUpload, handleThClick, loadFromSupabase, saveUploadData, toggleStore, exportToExcel, repositionCtxMenu, repositionSummaryCtx, cancelRef, abortRef, cancelUpload, openSummaryCtx, getEventsInPeriod, lowStock, negATSCount, zeroStock, totalSKUs, totalPoQty, totalSoQty, todayKey, syncProgress, normChanges, setNormChanges, applyNormReview, dismissNormReview, customerFilter, setCustomerFilter, customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch, dragSku, setDragSku, dragOverSku, setDragOverSku, pendingMerge, setPendingMerge, isAdmin, commitMerge, handleSkuDrop,
  mergeHistory, undoLastMerge, clearAllAtsData,
  atShip, setAtShip } = ctx;

  return (
    <div style={S.app}>
      <style>{`
        input[type=number]::-webkit-outer-spin-button { display: none; }
        input[type=number]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          appearance: none;
          cursor: pointer;
          width: 14px;
          background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='18' viewBox='0 0 14 18'%3E%3Cpath d='M7 3 L11 8 L3 8 Z' fill='%2394A3B8'/%3E%3Cpath d='M7 15 L3 10 L11 10 Z' fill='%2394A3B8'/%3E%3C/svg%3E") no-repeat center;
          opacity: 0.7;
          border: none;
          border-left: 1px solid #334155;
        }
        input[type=number]::-webkit-inner-spin-button:hover { opacity: 1; }
      `}</style>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>ATS</div>
          <span style={S.navTitle}>ATS Report</span>
          <span style={S.navSub}>Available to Sell</span>
        </div>
        <div style={S.navRight}>
          <button
            style={{ display: "none" }}
            onClick={() => {}}
          >
            {"" /* Demo button removed */}
          </button>
          {/* Undo last merge — only shown when there are merges */}
          {mergeHistory?.length > 0 && (
            <button
              style={{ ...S.navBtn, background: "#7C3AED", border: "1px solid #5B21B6", color: "#fff", fontWeight: 600 }}
              title={`Undo merge: ${mergeHistory[mergeHistory.length - 1]?.fromSku} → ${mergeHistory[mergeHistory.length - 1]?.toSku}`}
              onClick={undoLastMerge}
            >
              ↩ Undo Merge ({mergeHistory.length})
            </button>
          )}
          {/* Clear all ATS data */}
          <button
            style={{ ...S.navBtn, background: "#7F1D1D", border: "1px solid #991B1B", color: "#FCA5A5", fontWeight: 600 }}
            onClick={async () => {
              if (window.confirm("Delete ALL uploaded ATS data (Excel, PO, merges) and start fresh?\n\nThis cannot be undone.")) {
                await clearAllAtsData();
              }
            }}
          >
            🗑 Clear Data
          </button>
          <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
            {uploadingFile ? "Uploading…" : "Upload Excel"}
            {!uploadingFile && (invFile || purFile || ordFile) && (
              <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {[invFile, ordFile].filter(Boolean).length}/2{purFile ? "+PO" : ""}
              </span>
            )}
          </button>
          {/* PO data auto-refreshes from PO WIP on every load */}
          <button
            style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => exportToExcel(filtered, displayPeriods.map(p => ({ endDate: p.endDate, label: p.label })), atShip)}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="20" height="20" rx="3" fill="#1D6F42"/>
              <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white"/>
            </svg>
            Export Excel
          </button>
          <a href="/" style={{ ...S.navBtn, textDecoration: "none" }}>← PLM Home</a>
        </div>
      </nav>

      {/* BANNER */}
      {false && (
        <div style={S.demoBanner}>
          {"" /* Demo banner removed */}
        </div>
      )}

      {/* Sync Progress Bar + Log */}
      {syncProgress && (
        <div style={{ background: "#1E293B", borderBottom: "1px solid #334155", padding: "12px 24px" }}>
          <div style={{ maxWidth: 1600, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: "#F1F5F9", fontWeight: 600 }}>{syncProgress.step}</span>
              <span style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{syncProgress.pct}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: "#0F172A", overflow: "hidden", marginBottom: 8 }}>
              <div style={{ width: `${syncProgress.pct}%`, height: "100%", background: syncProgress.pct === 100 ? "linear-gradient(90deg, #6EE7B7, #047857)" : "linear-gradient(90deg, #93C5FD, #1D4ED8)", borderRadius: 4, transition: "width 0.3s" }} />
            </div>
            {syncProgress.log.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: "auto", background: "#0F172A", borderRadius: 6, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", color: "#94A3B8", lineHeight: 1.6 }}>
                {syncProgress.log.map((l, i) => (
                  <div key={i} style={{ color: l.includes("ERROR") ? "#EF4444" : l.includes("✅") ? "#10B981" : l.includes("FAILED") ? "#F59E0B" : "#94A3B8" }}>{l}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={S.content}>
        {/* STAT CARDS */}
        <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(9,1fr)" }}>
          <StatCard icon="△" label="Low Stock (≤10)"  value={lowStock}        color="#F59E0B" sortKey="lowStock"   activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="▽" label="Zero Stock"        value={zeroStock}       color="#EF4444" sortKey="zeroStock"  activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="↓" label="Negative ATS"      value={negATSCount}     color="#F87171" sortKey="negATS"     activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="▦" label="Total SKUs"         value={totalSKUs}       color="#3B82F6" sortKey="total"      activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="↑" label="Units on Order"     value={totalSoQty}      color="#10B981" sortKey="onOrder"   activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="$" label="$ on Order"         value={totalSoValue}    color="#10B981" fmt="dollar" />
          <StatCard icon="⬆" label="Units on PO"        value={totalPoQty}      color="#60A5FA" />
          <StatCard icon="$" label="$ on PO"            value={totalPoValue}    color="#60A5FA" fmt="dollar" />
          <StatCard icon="%" label="Margin"             value={marginDollars}   color={marginDollars >= 0 ? "#A3E635" : "#F87171"} fmt="margin" marginPct={marginPct} />
        </div>

        {/* TOOLBAR */}
        <div style={S.toolbar}>
          <input
            type="text"
            inputMode="text"
            style={S.searchInput}
            placeholder="Search SKU or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select style={S.select} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
          <select style={S.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="All">All status</option>
            <option value="InStock">In stock</option>
            <option value="Low">Low stock</option>
            <option value="Out">Out of stock</option>
          </select>
          {/* Store filter dropdown — single filter for everything */}
          <div ref={poDropRef} style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 140, justifyContent: "space-between" }}
              onClick={() => { setPoDropOpen(o => !o); setSoDropOpen(false); }}
            >
              <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Store:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {storeFilter.includes("All") ? "All stores" : storeFilter.join(", ")}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {poDropOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
                {(["All", ...STORES] as string[]).map(s => {
                  const checked = s === "All" ? storeFilter.includes("All") : storeFilter.includes(s);
                  return (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: checked ? "rgba(16,185,129,0.08)" : "transparent" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                      onMouseLeave={e => (e.currentTarget.style.background = checked ? "rgba(16,185,129,0.08)" : "transparent")}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleStore(storeFilter, setStoreFilter, s)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                      <span style={{ color: checked ? "#6EE7B7" : "#9CA3AF", fontSize: 13 }}>{s}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>Min ATS</label>
            <input
              type="number"
              style={{ ...S.dateInput, width: 72 }}
              placeholder="0"
              value={minATS}
              onChange={e => setMinATS(e.target.value === "" ? "" : Number(e.target.value))}
            />
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>From</label>
            <input
              type="date"
              style={S.dateInput}
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>Show</label>
            <input
              type="number"
              min="1"
              max={rangeUnit === "days" ? 365 : rangeUnit === "weeks" ? 52 : 24}
              style={{ ...S.dateInput, width: 60 }}
              value={rangeValue}
              onChange={e => { const v = Math.max(1, Number(e.target.value)); if (v) setRangeValue(v); }}
            />
            <select style={{ ...S.select, minWidth: 96 }} value={rangeUnit} onChange={e => { setRangeUnit(e.target.value as "days"|"weeks"|"months"); setRangeValue(e.target.value === "days" ? 14 : e.target.value === "weeks" ? 2 : 1); }}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>
          <div style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 160, justifyContent: "space-between" }}
              onClick={() => setCustomerDropOpen(!customerDropOpen)}
            >
              <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Cust/Vend:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {customerFilter || "All"}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {customerDropOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 280, maxHeight: 340, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
                  <input
                    type="text"
                    placeholder="Search customers…"
                    value={customerSearch}
                    onChange={e => setCustomerSearch(e.target.value)}
                    autoFocus
                    style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
                  />
                </div>
                <div style={{ overflowY: "auto", flex: 1 }}>
                  <div
                    style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: !customerFilter ? "#6EE7B7" : "#9CA3AF", background: !customerFilter ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: !customerFilter ? 600 : 400 }}
                    onClick={() => { setCustomerFilter(""); setCustomerDropOpen(false); setCustomerSearch(""); }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                    onMouseLeave={e => (e.currentTarget.style.background = !customerFilter ? "rgba(16,185,129,0.08)" : "transparent")}
                  >All Customers</div>
                  {(() => {
                    const custSet = new Set<string>();
                    if (excelData) {
                      excelData.sos.forEach(s => { if (s.customerName) custSet.add(s.customerName); });
                      excelData.pos.forEach(p => { if (p.vendor) custSet.add(p.vendor); });
                    }
                    const all = [...custSet].sort();
                    const q = customerSearch.toLowerCase();
                    const filtered2 = q ? all.filter(c => c.toLowerCase().includes(q)) : all;
                    return filtered2.map(c => (
                      <div
                        key={c}
                        style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: customerFilter === c ? "#6EE7B7" : "#CBD5E1", background: customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: customerFilter === c ? 600 : 400 }}
                        onClick={() => { setCustomerFilter(c); setCustomerDropOpen(false); setCustomerSearch(""); }}
                        onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                        onMouseLeave={e => (e.currentTarget.style.background = customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent")}
                      >{c}</div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>
          {/* AT SHIP toggle */}
          <label title="Show only qty free to ship — not reserved for future uncovered SOs" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${atShip ? "#10B981" : "#334155"}`, background: atShip ? "rgba(16,185,129,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={atShip} onChange={e => setAtShip(e.target.checked)} style={{ accentColor: "#10B981", cursor: "pointer", width: 14, height: 14 }} />
            <span style={{ color: atShip ? "#6EE7B7" : "#9CA3AF", fontSize: 12, fontWeight: atShip ? 700 : 400 }}>AT SHIP</span>
          </label>
          <div style={{ color: "#6B7280", fontSize: 12, whiteSpace: "nowrap" }}>
            {filtered.length.toLocaleString()} SKUs
            {lastSync && <span style={{ display: "block" }}>Synced {fmtDateDisplay(lastSync.split("T")[0])} {new Date(lastSync).toLocaleTimeString()}</span>}
          </div>
        </div>

        {/* LEGEND */}
        <div style={S.legend}>
          {[
            { color: "#10B981", bg: "rgba(16,185,129,0.1)",  label: "In stock (>50)" },
            { color: "#3B82F6", bg: "rgba(59,130,246,0.12)", label: "OK (11–50)" },
            { color: "#F59E0B", bg: "rgba(245,158,11,0.15)", label: "Low (1–10)" },
            { color: "#EF4444", bg: "rgba(239,68,68,0.15)",  label: "Out of stock (0)" },
          ].map(l => (
            <div key={l.label} style={S.legendItem}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: l.bg, border: `1px solid ${l.color}`, flexShrink: 0 }} />
              <span style={{ color: "#9CA3AF", fontSize: 11 }}>{l.label}</span>
            </div>
          ))}
        </div>

        {/* GRID TABLE */}
        {loading ? (
          <div style={S.loadingState}>Loading ATS data…</div>
        ) : filtered.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>▦</div>
            <p style={{ color: "#9CA3AF", margin: 0 }}>No SKUs match your filters.</p>
          </div>
        ) : (
          <div style={S.tableWrap} ref={tableRef}>
            <table style={S.table}>
              <thead>
                <tr>
                  {/* Sticky left columns */}
                  {(["sku","description","onHand","onOrder","onPO"] as const).map((col, ci) => {
                    const labels: Record<string, string> = { sku: "SKU", description: "Description", onHand: "On Hand", onOrder: "On Order", onPO: "On PO" };
                    const lefts = [0, 130, 330, 410, 490];
                    const widths = [130, 200, 80, 80, 80];
                    const isActive = sortCol === col;
                    return (
                      <th key={col} style={{ ...S.th, ...S.stickyCol, left: lefts[ci], minWidth: widths[ci], zIndex: 3, textAlign: ci >= 2 ? "center" : "left", cursor: "pointer",
                        color: isActive ? "#F1F5F9" : "#6B7280", background: isActive ? "#243048" : "#1E293B" }}
                        onClick={() => handleThClick(col)}
                      >
                        {labels[col]}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    );
                  })}
                  {/* Period columns */}
                  {displayPeriods.map(p => {
                    const isActive = sortCol === p.endDate;
                    return (
                      <th key={p.key} style={{
                        ...S.th,
                        minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                        textAlign: "center",
                        background: isActive ? "#243048" : p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                        color: isActive ? "#F1F5F9" : p.isToday ? "#10B981" : p.isWeekend ? "#475569" : "#6B7280",
                        borderBottom: p.isToday ? "2px solid #10B981" : "1px solid #334155",
                        whiteSpace: "pre-line",
                        lineHeight: 1.3,
                        fontSize: rangeUnit === "days" ? 10 : 11,
                        padding: "8px 6px",
                        cursor: "pointer",
                      }}
                        onClick={() => handleThClick(p.endDate)}
                      >
                        {p.label}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, ri) => {
                  const isPinned   = pinnedSku === row.sku;
                  const isDragging = dragSku === row.sku;
                  const isDropTarget = dragOverSku === row.sku && dragSku !== row.sku;
                  return (
                    <tr
                      key={`${row.sku}::${row.store ?? "ROF"}`}
                      draggable
                      onDragStart={e => { setDragSku(row.sku); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => { setDragSku(null); setDragOverSku(null); }}
                      onDragOver={e => { e.preventDefault(); if (dragSku && dragSku !== row.sku) setDragOverSku(row.sku); }}
                      onDragLeave={() => setDragOverSku(null)}
                      onDrop={e => { e.preventDefault(); if (dragSku && dragSku !== row.sku) { handleSkuDrop(dragSku, row.sku); setDragSku(null); setDragOverSku(null); } }}
                      style={{
                        background: isDropTarget ? "#1e3a2a" : isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827",
                        opacity: isDragging ? 0.45 : 1,
                        outline: isDropTarget ? "2px solid #10B981" : "none",
                        transition: "background 0.1s, opacity 0.1s",
                        cursor: "grab",
                      }}
                    >
                      {/* SKU */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 0, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827" }}
                        onClick={() => setPinnedSku(isPinned ? null : row.sku)}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 6, height: 6, borderRadius: 2, background: getQtyColor(row.dates[todayKey] ?? row.onHand), flexShrink: 0 }} />
                          <span style={{ fontFamily: "monospace", color: "#60A5FA", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                            {row.sku}
                          </span>
                        </div>
                        {row.category && <div style={{ fontSize: 10, color: "#475569", marginTop: 2, paddingLeft: 12 }}>{row.category}</div>}
                      </td>
                      {/* Description */}
                      <td style={{ ...S.td, ...S.stickyCol, left: 130, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", color: "#D1D5DB", fontSize: 13 }}>
                        {row.description}
                      </td>
                      {/* On Hand */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 330, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: "context-menu" }}
                        onContextMenu={e => openSummaryCtx(e, "onHand", row)}
                      >
                        <span style={{ color: "#F1F5F9", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onHand.toLocaleString()}
                        </span>
                      </td>
                      {/* On Order (committed SOs) */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 410, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: row.onCommitted > 0 ? "context-menu" : "default" }}
                        onContextMenu={e => { if (row.onCommitted > 0) openSummaryCtx(e, "onOrder", row); }}
                      >
                        <span style={{ color: "#F59E0B", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onCommitted > 0 ? row.onCommitted.toLocaleString() : "—"}
                        </span>
                      </td>
                      {/* On PO (open purchase orders) */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 490, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: row.onOrder > 0 ? "context-menu" : "default" }}
                        onContextMenu={e => { if (row.onOrder > 0) openSummaryCtx(e, "onPO", row); }}
                      >
                        <span style={{ color: "#10B981", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onOrder > 0 ? `+${row.onOrder.toLocaleString()}` : "—"}
                        </span>
                      </td>
                      {/* Period cells */}
                      {displayPeriods.map(p => {
                        const fullQty = row.dates[p.endDate]; // real balance, may be negative
                        const qty     = atShip ? (row.freeMap?.[p.endDate] ?? fullQty) : fullQty;
                        const isNeg   = qty != null && qty < 0;
                        const isHov   = hoveredCell?.sku === row.sku && hoveredCell?.date === p.key;
                        const isEmpty = qty === undefined || qty === null;
                        const ev      = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate, row.store) : null;
                        const hasPO   = (ev?.pos.length ?? 0) > 0;
                        const hasSO   = (ev?.sos.length ?? 0) > 0;
                        const canClick = hasPO || hasSO || isNeg;
                        const freeQty  = row.freeMap?.[p.endDate];
                        // Cell background
                        const baseBg = p.isToday
                          ? (isEmpty ? "#12201a" : isNeg ? "rgba(239,68,68,0.18)cc" : getQtyBg(qty!) + "cc")
                          : (isEmpty ? "#0F172A"  : isNeg ? "rgba(239,68,68,0.12)"  : getQtyBg(qty!));
                        const cellBg = hasPO && hasSO
                          ? `repeating-linear-gradient(45deg, rgba(245,158,11,0.22) 0px, rgba(245,158,11,0.22) 4px, rgba(59,130,246,0.22) 4px, rgba(59,130,246,0.22) 8px)`
                          : hasPO ? "rgba(245,158,11,0.18)"
                          : hasSO ? "rgba(59,130,246,0.18)"
                          : baseBg;
                        return (
                          <td
                            key={p.key}
                            style={{
                              ...S.td,
                              textAlign: "center",
                              padding: "4px",
                              background: cellBg,
                              cursor: canClick ? "context-menu" : "default",
                              transition: "all 0.1s",
                              outline: isHov ? `1px solid ${isEmpty ? "#334155" : isNeg ? "#EF4444" : getQtyColor(qty!)}` : "none",
                              outlineOffset: -1,
                              position: "relative",
                              boxShadow: hasPO && hasSO ? "inset 0 0 0 1px rgba(245,158,11,0.5)"
                                : hasPO ? "inset 0 0 0 1px rgba(245,158,11,0.4)"
                                : hasSO ? "inset 0 0 0 1px rgba(59,130,246,0.4)"
                                : isNeg ? "inset 0 0 0 1px rgba(239,68,68,0.5)"
                                : undefined,
                            }}
                            onMouseEnter={() => setHoveredCell({ sku: row.sku, date: p.key })}
                            onMouseLeave={() => setHoveredCell(null)}
                            onContextMenu={e => {
                              if (!canClick) return;
                              e.preventDefault();
                              const cellKey = `${row.sku}::${p.key}`;
                              if (ctxMenu?.cellKey === cellKey) { setCtxMenu(null); return; }
                              const cellEl   = e.currentTarget as HTMLElement;
                              const cellRect = cellEl.getBoundingClientRect();
                              setSummaryCtx(null);
                              setCtxMenu({ x: cellRect.left, y: cellRect.bottom + 2, anchorY: cellRect.top, pos: ev?.pos ?? [], sos: ev?.sos ?? [], onHand: row.onHand, skuStore: row.store ?? "ROF", cellKey, cellEl, flipped: false, arrowLeft: 20 });
                            }}
                          >
                            {isEmpty ? (
                              <span style={{ color: "#334155", fontSize: 11 }}>—</span>
                            ) : isNeg ? (
                              <span style={{
                                display: "inline-block",
                                background: "rgba(239,68,68,0.22)",
                                color: "#F87171",
                                fontSize: 11,
                                fontFamily: "monospace",
                                fontWeight: 700,
                                padding: "1px 5px",
                                borderRadius: 4,
                                border: "1px solid rgba(239,68,68,0.4)",
                              }}>
                                {qty!.toLocaleString()}
                              </span>
                            ) : (
                              <span style={{
                                color: getQtyColor(qty!),
                                fontSize: 12,
                                fontFamily: "monospace",
                                fontWeight: qty! <= 10 ? 700 : 500,
                              }}>
                                {qty === 0 ? "0" : qty!.toLocaleString()}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* PAGINATION */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button
              style={{ ...S.navBtn, opacity: page === 0 ? 0.3 : 1, cursor: page === 0 ? "default" : "pointer" }}
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
            >← Prev</button>
            <span style={{ color: "#9CA3AF", fontSize: 13 }}>
              Page {page + 1} of {totalPages} &nbsp;·&nbsp; {filtered.length.toLocaleString()} SKUs
            </span>
            <button
              style={{ ...S.navBtn, opacity: page >= totalPages - 1 ? 0.3 : 1, cursor: page >= totalPages - 1 ? "default" : "pointer" }}
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            >Next →</button>
          </div>
        )}
      </div>

      {/* SUMMARY COLUMN RIGHT-CLICK CONTEXT MENU */}
      {summaryCtx && (() => {
        const { type, row, pos, sos } = summaryCtx;
        const storeTag = (store: string) => (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
            background: store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
            color:      store === "ROF ECOM" ? "#7dd3fc"              : store === "PT" ? "#c4b5fd"              : "#93c5fd" }}>
            {store}
          </span>
        );
        const poByStore: Record<string, number> = {};
        for (const p of pos) poByStore[p.store ?? "ROF"] = (poByStore[p.store ?? "ROF"] ?? 0) + p.qty;
        const soByStore: Record<string, number> = {};
        for (const s of sos) soByStore[s.store ?? "ROF"] = (soByStore[s.store ?? "ROF"] ?? 0) + s.qty;
        // Average cost from PO history
        const avgCost = (() => {
          const skuPos = pos.filter(p => p.unitCost > 0);
          const totalQty = skuPos.reduce((s, p) => s + p.qty, 0);
          return totalQty > 0 ? skuPos.reduce((s, p) => s + p.qty * p.unitCost, 0) / totalQty : 0;
        })();
        return (
          <div ref={summaryCtxRef} style={{ position: "fixed", left: 0, top: 0, zIndex: 500, minWidth: 280, maxWidth: 420, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }} onClick={e => e.stopPropagation()}>
            {/* Up arrow (normal, popup below cell) */}
            <div data-arrow="up" style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 1, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
            <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px 6px", borderBottom: "1px solid #1a2030", position: "sticky", top: 0, background: "#1E293B", zIndex: 1 }}>
                <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{row.sku}</span>
                <button style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }} onClick={() => setSummaryCtx(null)}>✕</button>
              </div>
              {/* ON HAND */}
              {type === "onHand" && (
                <div>
                  <div style={{ background: "rgba(241,245,249,0.08)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#F1F5F9", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #334155" }}>On Hand</div>
                  <div style={{ padding: "10px 14px", fontSize: 12, borderBottom: "1px solid #1a2030" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      {storeTag(row.store ?? "ROF")}
                      <span style={{ color: "#94A3B8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.description}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                      <span style={{ color: "#F1F5F9", fontWeight: 700, fontFamily: "monospace", fontSize: 14 }}>{row.onHand.toLocaleString()} units</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", marginTop: 8 }}>
                      {(row.avgCost ?? 0) > 0 && <>
                        <span style={{ color: "#6B7280", fontSize: 11 }}>Avg Cost</span>
                        <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600, fontSize: 12, textAlign: "right" }}>${(row.avgCost ?? 0).toFixed(2)}</span>
                      </>}
                      {(row.totalAmount ?? 0) > 0 && <>
                        <span style={{ color: "#6B7280", fontSize: 11 }}>Total Value</span>
                        <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600, fontSize: 12, textAlign: "right" }}>${(row.totalAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </>}
                      {row.lastReceiptDate && <>
                        <span style={{ color: "#6B7280", fontSize: 11 }}>Last Received</span>
                        <span style={{ color: "#94A3B8", fontFamily: "monospace", fontSize: 12, textAlign: "right" }}>{fmtDateDisplay(row.lastReceiptDate ?? "")}</span>
                      </>}
                    </div>
                    {avgCost > 0 && (row.avgCost ?? 0) === 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 6 }}>Avg Cost (from POs): <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600 }}>${avgCost.toFixed(2)}</span></div>}
                  </div>
                </div>
              )}
              {/* ON ORDER (committed SOs) */}
              {type === "onOrder" && (
                <div>
                  {(() => { const totalSoQty = sos.reduce((s, o) => s + o.qty, 0); const totalSoVal = sos.reduce((s, o) => s + (o.totalPrice || 0), 0); return (
                  <div style={{ background: "rgba(245,158,11,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                    Committed Sales Orders — {sos.length} line{sos.length !== 1 ? "s" : ""} · {totalSoQty.toLocaleString()} units{totalSoVal > 0 ? ` · $${totalSoVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(totalSoVal / totalSoQty).toFixed(2)}/unit` : ""}
                  </div>); })()}
                  {Object.keys(soByStore).length > 1 && (
                    <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {Object.entries(soByStore).map(([st, qty]) => (
                        <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#F59E0B", fontFamily: "monospace", fontWeight: 600 }}>{qty.toLocaleString()}</span></span>
                      ))}
                    </div>
                  )}
                  {sos.map((s, i) => (
                    <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{s.orderNumber || "—"}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.store && storeTag(s.store)}<span style={{ color: "#F59E0B", fontWeight: 700 }}>{s.qty.toLocaleString()} units</span></span>
                      </div>
                      <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{s.customerName || "—"}</div>
                      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                        <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(s.date)}</span>
                        {s.unitPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit: ${s.unitPrice.toFixed(2)}</span>}
                        {s.totalPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${s.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* ON PO — grouped by PO number */}
              {type === "onPO" && (() => {
                // Group PO lines by PO number
                const poGrouped: Record<string, { poNumber: string; vendor: string; store: string; date: string; totalQty: number; totalValue: number }> = {};
                for (const p of pos) {
                  const key = p.poNumber || "Unknown";
                  if (!poGrouped[key]) poGrouped[key] = { poNumber: p.poNumber, vendor: p.vendor, store: p.store, date: p.date, totalQty: 0, totalValue: 0 };
                  poGrouped[key].totalQty += p.qty;
                  poGrouped[key].totalValue += p.qty * (p.unitCost || 0);
                  // Use earliest date
                  if (p.date && (!poGrouped[key].date || p.date < poGrouped[key].date)) poGrouped[key].date = p.date;
                }
                const poList = Object.values(poGrouped);
                const grandQty = poList.reduce((s, p) => s + p.totalQty, 0);
                const grandValue = poList.reduce((s, p) => s + p.totalValue, 0);
                return (
                <div>
                  <div style={{ background: "rgba(16,185,129,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#6EE7B7", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #064E3B" }}>Open Purchase Orders — {poList.length} PO{poList.length !== 1 ? "s" : ""} · {grandQty.toLocaleString()} units{grandValue > 0 ? ` · $${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(grandValue / grandQty).toFixed(2)}/unit` : ""}</div>
                  {Object.keys(poByStore).length > 1 && (
                    <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {Object.entries(poByStore).map(([st, qty]) => (
                        <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#10B981", fontFamily: "monospace", fontWeight: 600 }}>+{qty.toLocaleString()}</span></span>
                      ))}
                    </div>
                  )}
                  {poList.map((p, i) => (
                    <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12, cursor: p.poNumber ? "pointer" : "default" }}
                      title={p.poNumber ? "Click to open PO in PO WIP" : undefined}
                      onClick={() => { if (p.poNumber) { window.open(`/tanda?po=${encodeURIComponent(p.poNumber)}`, "_blank"); setSummaryCtx(null); } }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700, textDecoration: p.poNumber ? "underline" : "none", textUnderlineOffset: 2 }}>{p.poNumber || "—"}</span>
                        <span style={{ color: "#10B981", fontWeight: 700 }}>+{p.totalQty.toLocaleString()} units</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#CBD5E1" }}>{p.vendor || "—"}</span>
                        <span style={{ color: "#94A3B8", fontSize: 11 }}>{fmtDateDisplay(p.date)}</span>
                      </div>
                      {p.totalValue > 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 2 }}>Value: <span style={{ color: "#FCD34D", fontFamily: "monospace" }}>${p.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
                    </div>
                  ))}
                  {grandValue > 0 && (
                    <div style={{ padding: "8px 14px", background: "rgba(16,185,129,0.08)", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "#6EE7B7", fontWeight: 700 }}>Total</span>
                      <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700 }}>${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  )}
                </div>
                );
              })()}
            </div>
            {/* Down arrow (flipped, popup above cell) — hidden by default */}
            <div data-arrow="down" style={{ position: "relative", height: 8, overflow: "visible", display: "none" }}>
              <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          </div>
        );
      })()}

      {/* RIGHT-CLICK CONTEXT MENU */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 500, minWidth: 260, maxWidth: 380, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }}
          onClick={e => e.stopPropagation()}
        >
          {/* Caret arrow — sits outside the clipped inner box so it's visible */}
          {!ctxMenu.flipped ? (
            <div style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 1, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          ) : null}
          {/* Inner box — overflow hidden for rounded corners, does not clip the caret */}
          <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden" }}>
          {/* Close button + On Hand */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 14px 6px 14px", borderBottom: "1px solid #1a2030" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
                background: ctxMenu.skuStore === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
                color:      ctxMenu.skuStore === "PT" ? "#c4b5fd"              : "#93c5fd" }}>
                {ctxMenu.skuStore}
              </span>
              <span style={{ color: "#94A3B8", fontSize: 11 }}>On Hand:</span>
              <span style={{ color: "#F1F5F9", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{ctxMenu.onHand.toLocaleString()}</span>
            </div>
            <button
              style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }}
              onClick={() => setCtxMenu(null)}
              title="Close"
            >✕</button>
          </div>
          {ctxMenu.sos.length > 0 && (
            <div>
              {(() => { const tQty = ctxMenu.sos.reduce((s, o) => s + o.qty, 0); const tVal = ctxMenu.sos.reduce((s, o) => s + (o.totalPrice || o.unitPrice * o.qty || 0), 0); return (
              <div style={{ background: "rgba(59,130,246,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#93C5FD", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #1E3A5F" }}>
                Sales Orders ({ctxMenu.sos.length}) · {tQty.toLocaleString()} units{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})} · Avg $${(tVal / tQty).toFixed(2)}/unit` : ""}
              </div>); })()}
              {ctxMenu.sos.map((s, i) => (
                <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{s.orderNumber || "—"}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {s.store && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: s.store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : s.store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)", color: s.store === "ROF ECOM" ? "#7dd3fc" : s.store === "PT" ? "#c4b5fd" : "#93c5fd" }}>{s.store}</span>}
                      <span style={{ color: "#10B981", fontWeight: 700 }}>{s.qty.toLocaleString()} units</span>
                    </span>
                  </div>
                  <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{s.customerName || "—"}</div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(s.date)}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit: ${s.unitPrice?.toFixed(2) ?? "—"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${s.totalPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {ctxMenu.pos.length > 0 && (() => {
            // Group by PO number
            const poGrp: Record<string, { poNumber: string; vendor: string; store: string; date: string; totalQty: number; totalValue: number }> = {};
            for (const p of ctxMenu.pos) {
              const k = p.poNumber || "Unknown";
              if (!poGrp[k]) poGrp[k] = { poNumber: p.poNumber, vendor: p.vendor, store: p.store, date: p.date, totalQty: 0, totalValue: 0 };
              poGrp[k].totalQty += p.qty;
              poGrp[k].totalValue += p.qty * (p.unitCost || 0);
              if (p.date && (!poGrp[k].date || p.date < poGrp[k].date)) poGrp[k].date = p.date;
            }
            const poList = Object.values(poGrp);
            const tQty = poList.reduce((s, p) => s + p.totalQty, 0);
            const tVal = poList.reduce((s, p) => s + p.totalValue, 0);
            return (
            <div>
              <div style={{ background: "rgba(245,158,11,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                Purchase Orders ({poList.length}) · +{tQty.toLocaleString()} units{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})} · Avg $${(tVal / tQty).toFixed(2)}/unit` : ""}
              </div>
              {poList.map((p, i) => (
                <div
                  key={i}
                  style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12, cursor: p.poNumber ? "pointer" : "default" }}
                  title={p.poNumber ? "Click to open PO in PO WIP" : undefined}
                  onClick={() => { if (p.poNumber) { window.open(`/tanda?po=${encodeURIComponent(p.poNumber)}`, "_blank"); setCtxMenu(null); } }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700, textDecoration: p.poNumber ? "underline" : "none", textUnderlineOffset: 2 }}>
                      {p.poNumber || "—"}
                    </span>
                    <span style={{ color: "#10B981", fontWeight: 700 }}>+{p.totalQty.toLocaleString()} units</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#CBD5E1" }}>{p.vendor || "—"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>{fmtDateDisplay(p.date)}</span>
                  </div>
                  {p.totalValue > 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 2 }}>Value: <span style={{ color: "#FCD34D", fontFamily: "monospace" }}>${p.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
                </div>
              ))}
            </div>
            );
          })()}
          </div>{/* end inner clipped box */}
          {/* Down-arrow caret when popup is flipped above the cell */}
          {ctxMenu.flipped && (
            <div style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          )}
        </div>
      )}

      {/* UPLOAD WARNINGS CONFIRMATION MODAL */}
      {uploadWarnings && pendingUploadData && (
        <div style={S.modalOverlay}>
          <div style={{ ...S.modal, width: 560, border: "1px solid #F59E0B" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #78350f" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚠</div>
                <div>
                  <h2 style={{ ...S.modalTitle, color: "#FCD34D", margin: 0 }}>Review Data Issues</h2>
                  <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>
                    {pendingUploadData.skus.length.toLocaleString()} SKUs · {pendingUploadData.pos.length.toLocaleString()} PO lines · {pendingUploadData.sos.length.toLocaleString()} SO lines parsed
                  </div>
                </div>
              </div>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#CBD5E1", fontSize: 13, marginBottom: 16 }}>
                The following issues were found in your files. Review them before deciding whether to proceed.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
                {uploadWarnings.map((w, i) => (
                  <div key={i} style={{
                    background: w.severity === "error" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                    border: `1px solid ${w.severity === "error" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                    borderRadius: 8, padding: "10px 14px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14 }}>{w.severity === "error" ? "✗" : "△"}</span>
                      <span style={{ color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontWeight: 700, fontSize: 13 }}>{w.field}</span>
                      <span style={{ marginLeft: "auto", color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontFamily: "monospace", fontSize: 12, fontWeight: 700 }}>
                        {w.affected.toLocaleString()} / {w.total.toLocaleString()}
                      </span>
                    </div>
                    <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.5, paddingLeft: 22 }}>{w.message}</div>
                  </div>
                ))}
              </div>
              {pendingUploadData.columnNames && (
                <details style={{ marginBottom: 18 }}>
                  <summary style={{ color: "#60A5FA", fontSize: 12, cursor: "pointer", userSelect: "none" }}>
                    Show detected column names (click to expand)
                  </summary>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    {(["purchases", "orders"] as const).map(file => (
                      <div key={file} style={{ background: "#0F172A", borderRadius: 6, padding: "8px 12px", border: "1px solid #334155" }}>
                        <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontWeight: 600 }}>
                          {file === "purchases" ? "Purchases (PO) file" : "Orders (SO) file"}
                        </div>
                        <div style={{ color: "#94A3B8", fontSize: 11, fontFamily: "monospace", lineHeight: 1.8 }}>
                          {pendingUploadData.columnNames![file].join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{ flex: 1, background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                  onClick={() => { setUploadWarnings(null); setPendingUploadData(null); }}
                >
                  Cancel — Go Back
                </button>
                <button
                  style={{ flex: 2, background: "#F59E0B", border: "none", color: "#0F172A", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 700 }}
                  onClick={() => saveUploadData(pendingUploadData)}
                >
                  Upload Anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SKU NORMALIZATION REVIEW MODAL */}
      {normChanges && normChanges.length > 0 && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 250, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => dismissNormReview()}>
          <div style={{ background: "#1E293B", borderRadius: 14, width: 700, maxHeight: "80vh", display: "flex", flexDirection: "column", border: "1px solid #3B82F6" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(59,130,246,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{"✎"}</div>
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#F1F5F9" }}>Review SKU Normalization</h2>
                <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>
                  {normChanges.length} SKU{normChanges.length !== 1 ? "s" : ""} would be renamed · {normChanges.filter(c => c.accepted).length} accepted
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  style={{ background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
                  onClick={() => setNormChanges(normChanges.map(c => ({ ...c, accepted: true })))}
                >Accept All</button>
                <button
                  style={{ background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontWeight: 600 }}
                  onClick={() => setNormChanges(normChanges.map(c => ({ ...c, accepted: false })))}
                >Reject All</button>
              </div>
            </div>
            <div style={{ overflowY: "auto", padding: "12px 20px", flex: 1 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #334155" }}>
                    <th style={{ padding: "8px 10px", textAlign: "center", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase", width: 40 }}></th>
                    <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Original</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", color: "#6B7280", fontSize: 10, width: 30 }}></th>
                    <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Normalized</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", color: "#6B7280", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>Found In</th>
                  </tr>
                </thead>
                <tbody>
                  {normChanges.map((c, i) => (
                    <tr key={i}
                      style={{
                        borderBottom: "1px solid #1E293B",
                        background: c.accepted ? "rgba(16,185,129,0.06)" : "transparent",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        const updated = [...normChanges];
                        updated[i] = { ...c, accepted: !c.accepted };
                        setNormChanges(updated);
                      }}
                    >
                      <td style={{ padding: "8px 10px", textAlign: "center" }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: 4, display: "inline-flex", alignItems: "center", justifyContent: "center",
                          border: c.accepted ? "none" : "1px solid #475569",
                          background: c.accepted ? "#10B981" : "transparent",
                          color: "#fff", fontSize: 12, fontWeight: 700,
                        }}>{c.accepted ? "✓" : ""}</div>
                      </td>
                      <td style={{ padding: "8px 10px", color: "#FCA5A5", fontFamily: "monospace", fontSize: 11, textDecoration: c.accepted ? "line-through" : "none", opacity: c.accepted ? 0.6 : 1 }}>{c.original}</td>
                      <td style={{ padding: "8px 10px", textAlign: "center", color: "#475569" }}>→</td>
                      <td style={{ padding: "8px 10px", color: "#6EE7B7", fontFamily: "monospace", fontSize: 11 }}>{c.normalized}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <div style={{ display: "flex", gap: 4 }}>
                          {c.sources.map(s => (
                            <span key={s} style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 9, color: "#94A3B8", textTransform: "uppercase" }}>{s}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "14px 20px", borderTop: "1px solid #334155", display: "flex", gap: 10 }}>
              <button
                style={{ flex: 1, background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                onClick={() => dismissNormReview()}
              >Skip All — Keep Original</button>
              <button
                style={{ flex: 2, background: "#3B82F6", border: "none", color: "#fff", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 700 }}
                onClick={() => applyNormReview()}
              >Apply {normChanges.filter(c => c.accepted).length} Change{normChanges.filter(c => c.accepted).length !== 1 ? "s" : ""}</button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD PROGRESS OVERLAY */}
      {uploadProgress && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#1E293B", borderRadius: 14, padding: "28px 32px", width: 380, border: "1px solid #334155" }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 8 }}>Uploading…</div>
            <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20 }}>{uploadProgress.step}</div>
            <div style={{ background: "#0F172A", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20 }}>
              <div style={{ height: "100%", borderRadius: 8, background: "linear-gradient(90deg,#10B981,#3B82F6)", width: `${uploadProgress.pct}%`, transition: "width 0.4s ease" }} />
            </div>
            <button
              style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
              onClick={cancelUpload}
            >
              Cancel Upload
            </button>
          </div>
        </div>
      )}

      {/* SUCCESS TOAST */}
      {uploadSuccess && (
        <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", background: "#064e3b", border: "1px solid #10B981", borderRadius: 10, padding: "12px 24px", color: "#6ee7b7", fontSize: 14, fontWeight: 600, zIndex: 300, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 4px 24px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 18 }}>✓</span>
          {uploadSuccess}
          <button style={{ background: "none", border: "none", color: "#6ee7b7", cursor: "pointer", fontSize: 16, marginLeft: 8 }} onClick={() => setUploadSuccess(null)}>✕</button>
        </div>
      )}

      {/* SYNC ERROR MODAL */}
      {syncError && (
        <div style={S.modalOverlay} onClick={() => setSyncError(null)}>
          <div style={{ ...S.modal, width: 460, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
                <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>{syncError.title}</h2>
              </div>
              <button style={S.closeBtn} onClick={() => setSyncError(null)}>✕</button>
            </div>
            <div style={{ ...S.modalBody, paddingTop: 20 }}>
              <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
                {syncError.detail}
              </p>
              <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 14px", marginBottom: 20, border: "1px solid #334155" }}>
                <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 600 }}>What to check</div>
                <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.8 }}>
                  • Verify <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_KEY</span> and <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_SECRET</span> are set in Vercel<br/>
                  • Confirm Xoro API access is enabled for your account<br/>
                  • Check the browser console for the full error trace
                </div>
              </div>
              <button
                style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }}
                onClick={() => setSyncError(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD ERROR MODAL */}
      {uploadError && (
        <div style={S.modalOverlay} onClick={() => setUploadError(null)}>
          <div style={{ ...S.modal, width: 440, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
                <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>Upload Failed</h2>
              </div>
              <button style={S.closeBtn} onClick={() => setUploadError(null)}>✕</button>
            </div>
            <div style={{ ...S.modalBody, paddingTop: 20 }}>
              <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>{uploadError}</p>
              <button style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }} onClick={() => setUploadError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD MODAL */}
      {showUpload && (
        <div style={S.modalOverlay} onClick={() => setShowUpload(false)}>
          <div style={{ ...S.modal, width: 560 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Upload Excel Files</h2>
              <button style={S.closeBtn} onClick={() => setShowUpload(false)}>✕</button>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 20 }}>
                Upload all three Xoro report exports to compute Available to Sell. All files are required before processing.
              </p>

              {/* File slot helper */}
              {(
                [
                  { label: "Inventory Snapshot", sub: "On-hand quantities by SKU", key: "inv", file: invFile, setFile: setInvFile, ref: invRef, color: "#10B981" },
                  // Purchased Items Report removed — PO data always comes from PO WIP
                  { label: "All Orders Report", sub: "Sales orders by ship date (outgoing)", key: "ord", file: ordFile, setFile: setOrdFile, ref: ordRef, color: "#F59E0B" },
                ] as Array<{ label: string; sub: string; key: string; file: File | null; setFile: (f: File | null) => void; ref: React.RefObject<HTMLInputElement>; color: string }>
              ).map(slot => (
                <div key={slot.key} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: slot.color, flexShrink: 0 }} />
                    <span style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 13 }}>{slot.label}</span>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{slot.sub}</span>
                  </div>
                  <div
                    style={{
                      ...S.dropZone,
                      padding: "14px 16px",
                      borderColor: slot.file ? slot.color : "#334155",
                      background: slot.file ? `${slot.color}10` : "transparent",
                      display: "flex", alignItems: "center", gap: 12,
                    }}
                    onClick={() => slot.ref.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) slot.setFile(f);
                    }}
                  >
                    <span style={{ fontSize: 20, flexShrink: 0 }}>{slot.file ? "✓" : "↑"}</span>
                    {slot.file ? (
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <div style={{ color: slot.color, fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{slot.file.name}</div>
                        <div style={{ color: "#6B7280", fontSize: 11 }}>{(slot.file.size / 1024).toFixed(0)} KB</div>
                      </div>
                    ) : (
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "#D1D5DB", fontSize: 13 }}>Drop file or click to browse</div>
                        <div style={{ color: "#475569", fontSize: 11 }}>.xlsx</div>
                      </div>
                    )}
                    {slot.file && (
                      <button
                        style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); slot.setFile(null); }}
                      >✕</button>
                    )}
                    <input
                      ref={slot.ref}
                      type="file"
                      accept=".xlsx,.xls"
                      style={{ display: "none" }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) slot.setFile(f); }}
                    />
                  </div>
                </div>
              ))}

              <button
                style={{
                  ...S.navBtnPrimary,
                  width: "100%", justifyContent: "center", padding: "11px 0", marginTop: 8, fontSize: 14,
                  opacity: (invFile && ordFile) ? 1 : 0.4,
                  cursor: (invFile && purFile && ordFile) ? "pointer" : "not-allowed",
                }}
                disabled={!(invFile && ordFile)}
                onClick={() => {
                  if (invFile && ordFile) {
                    setShowUpload(false);
                    handleFileUpload(invFile, purFile, ordFile);
                  }
                }}
              >
                {invFile && ordFile ? `Process Files →${!purFile ? " (PO data from PO WIP)" : ""}` : `Select required files (${[invFile, ordFile].filter(Boolean).length}/2 ready)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SKU Merge Confirmation Modal ─────────────────────────────────── */}
      {pendingMerge && (() => {
        const { fromSku, toSku, similarity } = pendingMerge;
        const pct = Math.round(similarity * 100);
        const isLow = similarity < 0.8;
        const canConfirm = !isLow || isAdmin;
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center" }}
               onClick={() => setPendingMerge(null)}>
            <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 12, padding: 28, maxWidth: 480, width: "90%", boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>
                {isLow ? "⚠️ Low Similarity Warning" : "Merge SKUs?"}
              </div>
              <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20, lineHeight: 1.6 }}>
                Merging <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{fromSku}</span> into <span style={{ color: "#10B981", fontFamily: "monospace" }}>{toSku}</span>.
                <br />
                All quantities (On Hand, On PO, On Order) and date projections will be summed.
                The merged row keeps <span style={{ color: "#10B981", fontFamily: "monospace" }}>{toSku}</span>'s identifier.
              </div>
              <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 14px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 13, color: "#64748B" }}>SKU similarity</div>
                <div style={{ flex: 1, height: 6, background: "#1E293B", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: isLow ? "#EF4444" : "#10B981", borderRadius: 3, transition: "width 0.3s" }} />
                </div>
                <div style={{ fontWeight: 700, fontSize: 15, color: isLow ? "#EF4444" : "#10B981", minWidth: 40 }}>{pct}%</div>
              </div>
              {isLow && (
                <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 20, fontSize: 13, color: "#FCA5A5" }}>
                  {canConfirm
                    ? "These SKUs look different. As an admin you can still proceed."
                    : "Admin approval required to merge SKUs with less than 80% similarity."}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setPendingMerge(null)}
                  style={{ padding: "8px 18px", borderRadius: 7, border: "1px solid #334155", background: "none", color: "#94A3B8", cursor: "pointer", fontSize: 13 }}>
                  Cancel
                </button>
                <button
                  disabled={!canConfirm}
                  onClick={() => canConfirm && commitMerge(fromSku, toSku)}
                  style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: canConfirm ? "#10B981" : "#1E3A2A", color: canConfirm ? "#fff" : "#4B5563", cursor: canConfirm ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600 }}>
                  Merge SKUs
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
