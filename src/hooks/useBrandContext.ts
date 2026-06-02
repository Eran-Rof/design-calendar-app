// src/hooks/useBrandContext.ts
//
// P15 Brand Master — Chunk 2: global brand + channel selection, backing the
// <BrandChannelSwitcher>. Singleton module cache + pub/sub (same pattern as
// useEntities), but simpler: there's no per-user membership — every internal
// user sees every brand/channel. The selection is a PER-TAB choice stored in
// sessionStorage and attached as X-Brand-ID / X-Channel-ID by
// installInternalApiAuth on every /api/internal call.
//
// "All" (null selection) = no filter. In chunk 2 nothing filters regardless
// (silent-log); chunk 3 turns on WHERE brand_id = <selected> per report. We do
// NOT reload on select (unlike entity-switch) — selection just updates the
// header for subsequent fetches; chunk 3 can add a re-fetch when it wires
// filtering.

import { useEffect, useState, useCallback } from "react";

export interface Brand { id: string; code: string; name: string; is_default: boolean; sort_order: number; }
export interface Channel { id: string; code: string; name: string; sort_order: number; }

// MUST stay in lockstep with the keys read by src/utils/internalApiAuth.ts.
export const BRAND_SESSION_KEY = "x-tangerine-brand-id";
export const CHANNEL_SESSION_KEY = "x-tangerine-channel-id";

interface CacheShape {
  brands: Brand[];
  channels: Channel[];
  currentBrandId: string | null;   // null = All brands
  currentChannelId: string | null; // null = All channels
  status: "unloaded" | "loading" | "ready" | "error";
  error: string | null;
}

const cache: CacheShape = {
  brands: [], channels: [],
  currentBrandId: null, currentChannelId: null,
  status: "unloaded", error: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();
function notify() { for (const l of listeners) { try { l(); } catch { /* keep going */ } } }

function readSession(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { const v = window.sessionStorage.getItem(key); return v && v.trim() ? v.trim() : null; }
  catch { return null; }
}
function writeSession(key: string, val: string | null) {
  if (typeof window === "undefined") return;
  try { if (val) window.sessionStorage.setItem(key, val); else window.sessionStorage.removeItem(key); }
  catch { /* ignore */ }
}

let inFlight: Promise<void> | null = null;
async function load(): Promise<void> {
  if (inFlight) return inFlight;
  cache.status = "loading"; cache.error = null; notify();
  inFlight = (async () => {
    try {
      const [br, ch] = await Promise.all([
        fetch("/api/internal/brands", { method: "GET" }),
        fetch("/api/internal/channels", { method: "GET" }),
      ]);
      if (!br.ok) throw new Error(`GET /brands ${br.status}`);
      if (!ch.ok) throw new Error(`GET /channels ${ch.status}`);
      const brJson = await br.json(); const chJson = await ch.json();
      cache.brands = Array.isArray(brJson.brands) ? brJson.brands : [];
      cache.channels = Array.isArray(chJson.channels) ? chJson.channels : [];
      // Restore the per-tab selection, but only if it still matches a known row.
      const b = readSession(BRAND_SESSION_KEY);
      cache.currentBrandId = b && cache.brands.some((x) => x.id === b) ? b : null;
      const c = readSession(CHANNEL_SESSION_KEY);
      cache.currentChannelId = c && cache.channels.some((x) => x.id === c) ? c : null;
      cache.status = "ready"; cache.error = null;
    } catch (e) {
      cache.status = "error"; cache.error = e instanceof Error ? e.message : String(e);
    } finally { inFlight = null; notify(); }
  })();
  return inFlight;
}

export interface UseBrandContext {
  brands: Brand[];
  channels: Channel[];
  currentBrandId: string | null;
  currentChannelId: string | null;
  loading: boolean;
  error: string | null;
  selectBrand: (id: string | null) => void;   // null = All brands
  selectChannel: (id: string | null) => void; // null = All channels
}

export function useBrandContext(): UseBrandContext {
  const [, force] = useState(0);
  useEffect(() => {
    const l: Listener = () => force((n) => n + 1);
    listeners.add(l);
    if (cache.status === "unloaded") void load();
    return () => { listeners.delete(l); };
  }, []);

  const selectBrand = useCallback((id: string | null) => {
    cache.currentBrandId = id; writeSession(BRAND_SESSION_KEY, id); notify();
  }, []);
  const selectChannel = useCallback((id: string | null) => {
    cache.currentChannelId = id; writeSession(CHANNEL_SESSION_KEY, id); notify();
  }, []);

  return {
    brands: cache.brands, channels: cache.channels,
    currentBrandId: cache.currentBrandId, currentChannelId: cache.currentChannelId,
    loading: cache.status === "loading" || cache.status === "unloaded",
    error: cache.error,
    selectBrand, selectChannel,
  };
}

// Test-only.
export function __resetBrandContextForTests() {
  cache.brands = []; cache.channels = [];
  cache.currentBrandId = null; cache.currentChannelId = null;
  cache.status = "unloaded"; cache.error = null; inFlight = null; listeners.clear();
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem(BRAND_SESSION_KEY); window.sessionStorage.removeItem(CHANNEL_SESSION_KEY); } catch { /* ignore */ }
  }
}
