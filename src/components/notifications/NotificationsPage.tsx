// NotificationsPage — full-screen route styled like the PO WIP dashboard.
//
// Groups unread notifications into cards by event_type. Each row inside a
// card is clickable and routes to the notification's `link` (the actual
// item — PO, phase review, invoice, etc.). Clicking a row marks it read;
// read rows disappear from the list so the page always reflects what
// still needs attention. A toggle exposes "All" to browse history.

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationRow } from "./types";

interface Props {
  kind: "vendor" | "internal";
  supabase: SupabaseClient;
  userId: string;
  title?: string;
  backLink?: { href: string; label: string };
}

const C = {
  bg: "#0F172A",
  surface: "#1E293B",
  surfaceHi: "#334155",
  surfaceAlt: "#0B1425",
  border: "#334155",
  borderLt: "#475569",
  text: "#F1F5F9",
  textSub: "#CBD5E1",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  primaryLt: "#60A5FA",
  success: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
  accent: "#7C3AED",
};

// Visual metadata per known event_type. Anything not in the map falls
// back to a neutral grey card.
const EVENT_META: Record<string, { icon: string; label: string; color: string }> = {
  phase_change_proposed:    { icon: "📝", label: "Phase change requests",   color: C.accent },
  phase_change_approved:    { icon: "✅", label: "Phase changes approved",  color: C.success },
  phase_change_rejected:    { icon: "❌", label: "Phase changes rejected",  color: C.danger },
  phase_change_reopened:    { icon: "↻",  label: "Phase changes reopened",  color: C.warn },
  invoice_submitted:        { icon: "🧾", label: "New invoices",            color: C.primary },
  invoice_approved:         { icon: "✅", label: "Invoices approved",       color: C.success },
  invoice_discrepancy:      { icon: "⚠️", label: "Invoice discrepancies",   color: C.warn },
  payment_sent:             { icon: "💸", label: "Payments sent",           color: C.success },
  shipment_created:         { icon: "📦", label: "New shipments",           color: C.primary },
  shipment_delivered:       { icon: "🚚", label: "Shipments delivered",     color: C.success },
  po_issued:                { icon: "📄", label: "Purchase orders issued",  color: C.primary },
  new_message:              { icon: "💬", label: "New messages",            color: C.primaryLt },
  compliance_expiring_soon: { icon: "⏰", label: "Compliance expiring",     color: C.warn },
  onboarding_submitted:     { icon: "🆕", label: "Onboarding submitted",    color: C.primary },
  onboarding_approved:      { icon: "✅", label: "Onboarding approved",     color: C.success },
  rfq_invited:              { icon: "📨", label: "RFQ invitations",         color: C.primary },
  rfq_awarded:              { icon: "🏆", label: "RFQ awards",              color: C.success },
  anomaly_detected:         { icon: "⚠️", label: "Anomalies detected",      color: C.danger },
  discount_offer_made:      { icon: "💰", label: "Discount offers",         color: C.warn },
  scf_funded:               { icon: "💵", label: "SCF funded",              color: C.success },
  workspace_task_assigned:  { icon: "🗂", label: "Workspace tasks",         color: C.primary },
  dispute_opened:           { icon: "⚠️", label: "Disputes",                color: C.danger },
  contract_expiring_soon:   { icon: "📜", label: "Contracts expiring",      color: C.warn },
};

function prettify(eventType: string): string {
  if (EVENT_META[eventType]) return EVENT_META[eventType].label;
  return eventType
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function eventIcon(eventType: string): string {
  return EVENT_META[eventType]?.icon || "🔔";
}

function eventColor(eventType: string): string {
  return EVENT_META[eventType]?.color || C.primaryLt;
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationsPage({ kind, supabase, userId, title = "Notifications", backLink }: Props) {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [search, setSearch] = useState("");

  const recipientColumn = kind === "vendor" ? "recipient_auth_id" : "recipient_internal_id";

  async function load() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, event_type, title, body, link, read_at, created_at, recipient_auth_id, recipient_internal_id, metadata")
        .eq(recipientColumn, userId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) return;
      setItems((data ?? []) as NotificationRow[]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId, kind]);

  const unreadCount = useMemo(() => items.filter((n) => !n.read_at).length, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((n) => {
      if (filter === "unread" && n.read_at) return false;
      if (!q) return true;
      return [n.title, n.body, n.event_type].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [items, filter, search]);

  const groups = useMemo(() => {
    const g: Record<string, NotificationRow[]> = {};
    for (const n of filtered) {
      (g[n.event_type] ||= []).push(n);
    }
    return Object.entries(g)
      .sort(([, a], [, b]) => new Date(b[0].created_at).getTime() - new Date(a[0].created_at).getTime());
  }, [filtered]);

  async function markRead(id: string) {
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (n.id === id ? { ...n, read_at: now } : n)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).eq("id", id);
    if (error) void load();
  }

  async function markGroupRead(eventType: string) {
    const ids = items.filter((n) => n.event_type === eventType && !n.read_at).map((n) => n.id);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (ids.includes(n.id) ? { ...n, read_at: now } : n)));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    if (error) void load();
  }

  async function markAllRead() {
    const ids = items.filter((n) => !n.read_at).map((n) => n.id);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    if (error) void load();
  }

  function onRowClick(n: NotificationRow) {
    if (!n.read_at) void markRead(n.id);
    if (n.link) window.location.href = n.link;
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        {backLink && (
          <div style={{ marginBottom: 10 }}>
            <a href={backLink.href} style={{ color: C.textMuted, fontSize: 13, textDecoration: "none" }}>
              ← {backLink.label}
            </a>
          </div>
        )}

        {/* Header: title + unread count + search + filter + actions */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{title}</h1>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              {unreadCount} unread · {items.length} total
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              style={{
                padding: "7px 10px", borderRadius: 6,
                border: `1px solid ${C.borderLt}`, background: C.surface, color: C.text,
                fontSize: 12, fontFamily: "inherit", width: 220,
              }}
            />
            {(["unread", "all"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 14px", borderRadius: 6,
                  border: `1px solid ${filter === f ? C.primary : C.borderLt}`,
                  background: filter === f ? C.primary : C.surface,
                  color: filter === f ? "#fff" : C.textSub,
                  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  textTransform: "capitalize",
                }}>
                {f}{f === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
              </button>
            ))}
            <button onClick={() => void load()} title="Refresh" style={smallBtn}>↻</button>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{ ...smallBtn, color: C.primaryLt, borderColor: C.primary }}>
                Mark all read
              </button>
            )}
          </div>
        </div>

        {/* Cards grid */}
        {loading && items.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 60, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
            Loading…
          </div>
        ) : groups.length === 0 ? (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 60, textAlign: "center", color: C.textMuted, fontSize: 14 }}>
            {items.length === 0
              ? "No notifications yet. You're all caught up."
              : filter === "unread"
                ? "🎉 All caught up — no unread notifications."
                : `No notifications match "${search.trim()}".`}
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
            gap: 16,
          }}>
            {groups.map(([eventType, rows]) => {
              const unreadInGroup = rows.filter((n) => !n.read_at).length;
              const color = eventColor(eventType);
              return (
                <div
                  key={eventType}
                  style={{
                    background: C.surface,
                    border: `1px solid ${C.border}`,
                    borderRadius: 12,
                    padding: 16,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  {/* Card header */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <span style={{ fontSize: 22, lineHeight: 1 }}>{eventIcon(eventType)}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {prettify(eventType)}
                        </div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                          {unreadInGroup} unread{filter === "all" && unreadInGroup !== rows.length ? ` · ${rows.length} total` : ""}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{
                        minWidth: 26, height: 22, padding: "0 8px", borderRadius: 11,
                        background: color + "22", color,
                        fontSize: 12, fontWeight: 700,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {filter === "unread" ? unreadInGroup : rows.length}
                      </span>
                      {unreadInGroup > 0 && (
                        <button
                          onClick={() => void markGroupRead(eventType)}
                          title="Mark all in this group as read"
                          style={{
                            padding: "3px 8px", borderRadius: 5,
                            border: `1px solid ${C.borderLt}`, background: "transparent",
                            color: C.textSub, cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit",
                          }}
                        >Clear</button>
                      )}
                    </div>
                  </div>

                  <div style={{ height: 1, background: C.surfaceHi }} />

                  {/* Rows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {rows.slice(0, 12).map((n) => {
                      const unread = !n.read_at;
                      const clickable = !!n.link;
                      return (
                        <div
                          key={n.id}
                          onClick={() => onRowClick(n)}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 8,
                            background: unread ? C.surfaceAlt : "transparent",
                            border: `1px solid ${unread ? color + "55" : C.surfaceHi}`,
                            cursor: clickable ? "pointer" : "default",
                            display: "grid",
                            gridTemplateColumns: "1fr auto",
                            gap: 10,
                            alignItems: "start",
                            transition: "background 0.12s, transform 0.12s",
                          }}
                          onMouseEnter={(e) => { if (clickable) { (e.currentTarget as HTMLDivElement).style.background = C.surfaceHi; } }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = unread ? C.surfaceAlt : "transparent"; }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: unread ? 700 : 500, color: unread ? C.text : C.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {n.title}
                            </div>
                            {n.body && (
                              <div style={{
                                fontSize: 12, color: C.textMuted, marginTop: 3, lineHeight: 1.4,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                                overflow: "hidden",
                              }}>
                                {n.body}
                              </div>
                            )}
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, fontSize: 10, color: C.textMuted, whiteSpace: "nowrap" }}>
                            <span>{timeAgo(n.created_at)}</span>
                            {unread && (
                              <button
                                onClick={(e) => { e.stopPropagation(); void markRead(n.id); }}
                                style={{
                                  padding: "2px 8px", borderRadius: 4,
                                  border: `1px solid ${C.borderLt}`, background: "transparent",
                                  color: C.textSub, cursor: "pointer", fontSize: 10, fontWeight: 600, fontFamily: "inherit",
                                }}
                              >Mark read</button>
                            )}
                            {clickable && !unread && (
                              <span style={{ fontSize: 10, color: C.textMuted }}>→</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {rows.length > 12 && (
                      <div style={{ fontSize: 11, color: C.textMuted, padding: "4px 12px" }}>
                        + {rows.length - 12} more · refine with search
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  border: `1px solid ${C.borderLt}`, background: C.surface, color: C.textSub,
  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
};
