// Collections "Grid" view (card grid) extracted from dashboardPanel.tsx.
// Each card is one collection with brand · season · vendor info, a
// progress bar, the next-task date, status dots, assignee avatars,
// and Timeline / Calendar nav buttons. Click a card to focus it,
// right-click to open the context menu.
//
// State + setters all come in as props so the component can be tested
// in isolation.

import { S, TH } from "../styles";
import { STATUS_CONFIG } from "../../utils/constants";
import { formatDate, getDaysUntil } from "../../utils/dates";
import Avatar from "../../components/Avatar";
import type { Task, Brand, TeamMember, CollectionGroup } from "../../store/types";

// Shape of a single value in `state.collections` — partial coverage of
// the fields the card actually reads (sample/customer/cancel dates,
// year, gender, customer, sku list). Loose-typed because the store
// uses Record<string, any> here.
type CollectionData = {
  skus?: Array<unknown>;
  sampleDueDate?: string;
  year?: string;
  gender?: string;
  customer?: string;
  orderType?: string;
  customerShipDate?: string;
  cancelDate?: string;
};

export interface CollectionGridViewProps {
  collList: CollectionGroup[];
  collections: Record<string, CollectionData>;
  team: TeamMember[];
  focusCollKey: string | null;
  getBrand: (brand: string) => Brand | undefined;
  setFocusCollKey: (key: string | null) => void;
  setCtxMenu: (menu: { x: number; y: number; collKey: string }) => void;
  setEditTask: (task: Task) => void;
  setView: (view: string) => void;
}

export function CollectionGridView({
  collList,
  collections,
  team,
  focusCollKey,
  getBrand,
  setFocusCollKey,
  setCtxMenu,
  setEditTask,
  setView,
}: CollectionGridViewProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
        gap: 12,
        marginBottom: 28,
      }}
    >
      {collList.map((c) => {
        const brand = getBrand(c.brand) || ({ id: "unknown", name: "Unknown", color: "#6B7280", short: "?" } as Brand);
        const done = c.tasks.filter((t) => ["Complete", "Approved"].includes(t.status)).length;
        const pct = c.tasks.length === 0 ? 0 : Math.round((done / c.tasks.length) * 100);
        const hasDelay = c.tasks.some((t) => t.status === "Delayed");
        const next = c.tasks
          .filter((t) => !["Complete", "Approved"].includes(t.status))
          .sort((a, b) => +new Date(a.due) - +new Date(b.due))[0];
        const collData: CollectionData = collections[c.key] || {};
        const skuCount = collData.skus?.length || 0;
        const assigneeIds = [
          ...new Set(c.tasks.map((t) => t.assigneeId).filter(Boolean)),
        ] as string[];
        const isFocused = focusCollKey === c.key;
        const ddpTask = c.tasks.find((t) => t.phase === "DDP");
        return (
          <div
            key={c.key}
            onClick={(e) => {
              e.stopPropagation();
              setFocusCollKey(isFocused ? null : c.key);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ x: e.clientX, y: e.clientY, collKey: c.key });
            }}
            style={{
              ...S.card,
              cursor: "pointer",
              outline: isFocused ? `2px solid ${brand.color}` : "2px solid transparent",
              outlineOffset: 2,
              transition: "all 0.15s",
              transform: isFocused ? "scale(1.01)" : "scale(1)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: TH.primary }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, paddingTop: 4 }}>
              <div>
                {/* Line 1: Brand · Collection Name · Sample Due */}
                <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 2 }}>
                  {brand.short || brand.name} · {c.collection}
                  {collData.sampleDueDate ? ` · Sample: ${formatDate(collData.sampleDueDate)}` : ""}
                </div>
                {/* Line 2: Season Year · Gender · Category */}
                <div style={{ fontSize: 11, color: TH.textSub2 }}>
                  {c.season}
                  {collData.year ? ` ${collData.year}` : ""}
                  {collData.gender ? ` · ${collData.gender}` : ""}
                  {c.category ? ` · ${c.category}` : ""}
                </div>
                {/* Line 3: Vendor · DDP · Exit Factory */}
                {(() => {
                  const shipTask = c.tasks.find((t) => t.phase === "Ship Date");
                  const parts: string[] = [];
                  if (c.vendorName) parts.push(c.vendorName);
                  if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                  if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                  return parts.length > 0 ? (
                    <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>{parts.join(" · ")}</div>
                  ) : null;
                })()}
                {/* Line 4: Customer · Start Ship · Cancel */}
                {(() => {
                  const parts: string[] = [];
                  if (collData.customer) {
                    parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                  }
                  if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                  if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                  return parts.length > 0 ? (
                    <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>{parts.join(" · ")}</div>
                  ) : null;
                })()}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: pct === 100 ? "#047857" : TH.text,
                  lineHeight: 1,
                }}>
                  {pct}%
                </div>
                {hasDelay && (
                  <div style={{ fontSize: 10, color: "#B91C1C", fontWeight: 700 }}>
                    ⚠ Delayed
                  </div>
                )}
              </div>
            </div>
            <div style={{
              height: 5,
              background: TH.surfaceHi,
              border: `1px solid ${TH.border}`,
              borderRadius: 3,
              overflow: "hidden",
              marginBottom: 10,
            }}>
              <div style={{
                height: "100%",
                width: `${pct}%`,
                background: `linear-gradient(90deg,${brand.color},${TH.primary})`,
                borderRadius: 3,
                transition: "width 0.6s",
              }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              {next && (
                <div style={{ fontSize: 11, color: TH.textMuted }}>
                  Next:{" "}
                  <span style={{ color: TH.textSub2, fontWeight: 600 }}>{next.phase}</span>{" — "}
                  <span style={{
                    color: getDaysUntil(next.due) < 0 ? "#B91C1C"
                      : getDaysUntil(next.due) < 7 ? "#B45309"
                      : TH.primary,
                    fontWeight: 600,
                  }}>
                    {formatDate(next.due)}
                  </span>
                </div>
              )}
              <div style={{ fontSize: 11, color: TH.textMuted }}>
                {skuCount} SKU{skuCount !== 1 ? "s" : ""}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {c.tasks
                  .sort((a, b) => +new Date(a.due) - +new Date(b.due))
                  .map((t) => (
                    <span
                      key={t.id}
                      title={`${t.phase}: ${t.status}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditTask(t);
                      }}
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 2,
                        background: STATUS_CONFIG[t.status]?.dot || TH.border,
                        display: "inline-block",
                        cursor: "pointer",
                      }}
                    />
                  ))}
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                {assigneeIds.slice(0, 4).map((id) => {
                  const m = team.find((x) => x.id === id);
                  return m ? <Avatar key={id} member={m} size={20} /> : null;
                })}
              </div>
            </div>
            <div style={{
              marginTop: 10,
              paddingTop: 10,
              borderTop: `1px solid ${TH.border}`,
              display: "flex",
              gap: 6,
            }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusCollKey(c.key);
                  setView("timeline");
                }}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: `1px solid ${brand.color}44`,
                  background: brand.color + "12",
                  color: brand.color,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                📊 Timeline
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusCollKey(c.key);
                  setView("calendar");
                }}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: 6,
                  border: `1px solid ${brand.color}44`,
                  background: brand.color + "12",
                  color: brand.color,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                📅 Calendar
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
