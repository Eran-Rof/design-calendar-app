import { useEffect, useState, useCallback } from "react";
import { TH } from "../utils/theme";
import { supabaseVendor } from "./supabaseVendor";

interface FeedItem {
  type: string;
  title: string;
  subtitle: string;
  timestamp: string;
  deep_link: string;
}

async function token() {
  const { data: { session } } = await supabaseVendor.auth.getSession();
  return session?.access_token || "";
}

function mapDeepLink(link: string): string | null {
  if (!link.startsWith("vendor://")) return null;
  const path = link.slice("vendor://".length);
  if (path === "home") return "/vendor";
  return `/vendor/${path}`;
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

function iconFor(type: string): string {
  if (type.includes("po")) return "📦";
  if (type.includes("invoice")) return "🧾";
  if (type.includes("payment")) return "💰";
  if (type.includes("rfq")) return "📨";
  if (type.includes("message")) return "💬";
  if (type.includes("compliance")) return "📋";
  if (type.includes("dispute")) return "⚠️";
  if (type.includes("onboarding")) return "🚀";
  return "🔔";
}

export default function VendorMobileFeed() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pullStart, setPullStart] = useState<number | null>(null);
  const [pullY, setPullY] = useState(0);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setErr(null);
    try {
      const t = await token();
      const r = await fetch("/api/vendor/mobile/feed", { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) throw new Error(await r.text());
      setFeed(await r.json() as FeedItem[]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function onTouchStart(e: React.TouchEvent) {
    if (window.scrollY <= 0) setPullStart(e.touches[0].clientY);
  }
  function onTouchMove(e: React.TouchEvent) {
    if (pullStart == null) return;
    const dy = Math.max(0, Math.min(120, e.touches[0].clientY - pullStart));
    setPullY(dy);
  }
  function onTouchEnd() {
    if (pullY > 70) {
      setRefreshing(true);
      void load(true);
    }
    setPullStart(null);
    setPullY(0);
  }

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ paddingTop: pullY }}
    >
      <div style={{ textAlign: "center", color: "rgba(255,255,255,0.7)", fontSize: 12, marginBottom: 8, opacity: pullY > 0 ? 1 : 0, transition: "opacity 0.2s", minHeight: 18 }}>
        {refreshing ? "Refreshing…" : pullY > 70 ? "Release to refresh" : pullY > 0 ? "Pull to refresh" : ""}
      </div>

      <h2 style={{ color: "#FFFFFF", fontSize: 18, margin: "0 0 12px" }}>Activity</h2>

      {loading ? (
        <div style={{ color: "rgba(255,255,255,0.85)" }}>Loading…</div>
      ) : err ? (
        <div style={{ color: TH.primary, padding: 12, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6 }}>Error: {err}</div>
      ) : feed.length === 0 ? (
        <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 10, padding: 30, textAlign: "center", color: TH.textMuted }}>
          No recent activity.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {feed.map((item, i) => {
            const internalPath = mapDeepLink(item.deep_link);
            const Wrap: React.ElementType = internalPath ? "a" : "div";
            return (
              <Wrap
                key={i}
                href={internalPath || undefined}
                style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, padding: "12px 14px", display: "flex", gap: 12, alignItems: "center", textDecoration: "none", color: "inherit", cursor: internalPath ? "pointer" : "default" }}
              >
                <div style={{ fontSize: 24 }}>{iconFor(item.type)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: TH.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: TH.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.subtitle}</div>
                </div>
                <div style={{ fontSize: 11, color: TH.textMuted, whiteSpace: "nowrap" }}>{timeAgo(item.timestamp)}</div>
              </Wrap>
            );
          })}
        </div>
      )}
    </div>
  );
}
