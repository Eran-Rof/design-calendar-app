// Data freshness: computes per-entity "age since last update" and
// compares to thresholds in ip_data_freshness_thresholds. Produces
// IpFreshnessSignal rows the UI banners / admin dashboard render.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type { IpFreshnessSignal, IpFreshnessThreshold } from "../types/admin";
import { ageHours } from "./integrationHealthService";

async function sbMaxTimestamp(path: string, column: string): Promise<string | null> {
  if (!SB_URL) return null;
  // Supabase PostgREST: order desc + limit 1 is the idiom for max().
  const r = await fetch(`${SB_URL}/rest/v1/${path}&select=${column}&order=${column}.desc&limit=1`, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (rows[0] as Record<string, string | null>)[column] ?? null;
}

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) return [];
  return r.json();
}

export async function listThresholds(): Promise<IpFreshnessThreshold[]> {
  return sbGet<IpFreshnessThreshold>("ip_data_freshness_thresholds?select=*&order=entity_type.asc&limit=200");
}

// Returns a Map so callers can read threshold by entity_type quickly.
export async function thresholdsByEntity(): Promise<Map<string, IpFreshnessThreshold>> {
  const list = await listThresholds();
  return new Map(list.map((t) => [t.entity_type, t]));
}

// Compute a single freshness signal given a threshold + observed timestamp.
export function toSignal(
  entity_type: string,
  threshold: IpFreshnessThreshold,
  last_updated_at: string | null,
): IpFreshnessSignal {
  const age = ageHours(last_updated_at);
  const severity = age == null
    ? "warning"
    : age <= threshold.max_age_hours
      ? "fresh"
      : threshold.severity;
  return {
    entity_type,
    last_updated_at,
    age_hours: age == null ? null : Math.round(age),
    threshold_hours: threshold.max_age_hours,
    severity,
    note: threshold.note,
  };
}

// Build all signals the admin dashboard cares about.
export async function loadFreshnessSignals(): Promise<IpFreshnessSignal[]> {
  const map = await thresholdsByEntity();
  const sources: Array<{ entity: string; path: string; column: string }> = [
    { entity: "xoro_sales_history", path: "raw_xoro_payloads?endpoint=eq.sales-history",      column: "ingested_at" },
    { entity: "xoro_inventory",     path: "raw_xoro_payloads?endpoint=eq.inventory-snapshot", column: "ingested_at" },
    { entity: "xoro_open_pos",      path: "raw_xoro_payloads?endpoint=eq.open-pos",           column: "ingested_at" },
    { entity: "shopify_orders",     path: "raw_shopify_payloads?endpoint=eq.orders",          column: "ingested_at" },
    { entity: "shopify_products",   path: "raw_shopify_payloads?endpoint=eq.products",        column: "ingested_at" },
    { entity: "planning_run",       path: "ip_planning_runs?select=updated_at",               column: "updated_at" },
    { entity: "wholesale_forecast", path: "ip_wholesale_forecast?select=updated_at",          column: "updated_at" },
    { entity: "ecom_forecast",      path: "ip_ecom_forecast?select=updated_at",               column: "updated_at" },
  ];

  const signals: IpFreshnessSignal[] = [];
  for (const s of sources) {
    const threshold = map.get(s.entity);
    if (!threshold) continue;
    const ts = await sbMaxTimestamp(s.path, s.column);
    signals.push(toSignal(s.entity, threshold, ts));
  }
  return signals;
}

// UI helper — find the signal for a specific entity.
export function signalFor(signals: IpFreshnessSignal[], entity_type: string): IpFreshnessSignal | null {
  return signals.find((s) => s.entity_type === entity_type) ?? null;
}
