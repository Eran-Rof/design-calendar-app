// NotificationsPage — full-screen route, not a modal.
//
// Used by /vendor/notifications and /notifications routes. Theme is
// inherited from CSS body, but component supplies its own neutral
// dark chrome so it looks right on both dark (vendor) and light
// (internal) host pages.

import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationRow } from "./types";

interface Props {
  kind: "vendor" | "internal";
  supabase: SupabaseClient;
  userId: string;
  /** Title shown at the top. Default: "Notifications". */
  title?: string;
  /** Optional back link (href + label). Shown above the page title. */
  backLink?: { href: string; label: string };
}

const C = {
  bg: "#0F172A",
  surface: "#1E293B",
  surfaceHi: "#334155",
  border: "#475569",
  text: "#F1F5F9",
  textSub: "#CBD5E1",
  textMuted: "#94A3B8",
  primary: "#3B82F6",
  primaryLt: "#60A5FA",
  danger: "#EF4444",
  unread: "#1E3A8A33",
};

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
  const [filter, setFilter] = useState<"all" | "unread">("unread");
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
        .limit(200);
      if (error) return;
      setItems((data ?? []) as NotificationRow[]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId, kind]);

  const unreadCount = useMemo(() => items.filter((n) => !n.read_at).length, [items]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((n) => {
      if (filter === "unread" && n.read_at) return false;
      if (!q) return true;
      return [n.title, n.body, n.event_type].filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [items, filter, search]);

  async function markRead(id: string) {
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    if (!error) setItems((xs) => xs.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
  }

  async function markAllRead() {
    const unread = items.filter((n) => !n.read_at).map((n) => n.id);
    if (unread.length === 0) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("notifications").update({ read_at: now }).in("id", unread);
    if (!error) setItems((xs) => xs.map((n) => (n.read_at ? n : { ...n, read_at: now })));
  }

  function onItemClick(n: NotificationRow) {
    if (!n.read_at) void markRead(n.id);
    if (n.link) window.location.href = n.link;
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        {backLink && (
          <div style={{ marginBottom: 8 }}>
            <a href={backLink.href} style={{ color: C.textMuted, fontSize: 13, textDecoration: "none" }}>
              ← {backLink.label}
            </a>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{title}</h1>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
              {unreadCount} unread · {items.length} total
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              style={{
                padding: "7px 10px", borderRadius: 6,
                border: `1px solid ${C.border}`, background: C.surface, color: C.text,
                fontSize: 12, fontFamily: "inherit", width: 220,
              }}
            />
            {(["unread", "all"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  padding: "6px 14px", borderRadius: 6,
                  border: `1px solid ${filter === f ? C.primary : C.border}`,
                  background: filter === f ? C.primary : "transparent",
                  color: filter === f ? "#fff" : C.textSub,
                  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  textTransform: "capitalize",
                }}>
                {f}{f === "unread" && unreadCount > 0 ? ` (${unreadCount})` : ""}
              </button>
            ))}
            <button onClick={() => void load()} title="Refresh" style={smallBtn}>↻</button>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{ ...smallBtn, color: C.primaryLt }}>Mark all read</button>
            )}
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          {loading && items.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 13 }}>Loading…</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 60, textAlign: "center", color: C.textMuted, fontSize: 14 }}>
              {items.length === 0
                ? "No notifications yet. You're all caught up."
                : filter === "unread"
                  ? "No unread notifications."
                  : `No notifications match "${search.trim()}".`}
            </div>
          ) : (
            visible.map((n) => {
              const unread = !n.read_at;
              return (
                <div
                  key={n.id}
                  onClick={() => onItemClick(n)}
                  style={{
                    padding: "16px 20px",
                    borderBottom: `1px solid ${C.surfaceHi}`,
                    background: unread ? C.unread : "transparent",
                    cursor: n.link ? "pointer" : "default",
                    display: "grid", gridTemplateColumns: "1fr auto",
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      {unread && <span style={{ width: 8, height: 8, borderRadius: 999, background: C.primary, flexShrink: 0 }} />}
                      <strong style={{ fontSize: 14 }}>{n.title}</strong>
                      <span style={{ fontSize: 10, color: C.textMuted, padding: "2px 8px", borderRadius: 10, background: C.surfaceHi, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
                        {n.event_type}
                      </span>
                    </div>
                    {n.body && <div style={{ fontSize: 13, color: C.textSub, lineHeight: 1.5 }}>{n.body}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" }}>
                    <span>{timeAgo(n.created_at)}</span>
                    {unread && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void markRead(n.id); }}
                        style={{ ...smallBtn, fontSize: 11, padding: "2px 10px" }}
                      >Mark read</button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  padding: "5px 10px", borderRadius: 5,
  border: `1px solid ${C.border}`, background: "transparent", color: C.textSub,
  cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
};
