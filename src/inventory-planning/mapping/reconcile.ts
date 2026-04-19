// Reconciliation: given a normalized row with upstream strings/ids and
// the list of masters from Supabase, resolve to internal uuids.
//
// Strategy, in priority order:
//   1) external_refs exact match (preferred — authoritative)
//   2) canonical-key match on *_code
//   3) canonical-key match on name
//
// Step 3 is the "best-effort" tier: it returns a candidate but always
// produces a data-quality note so a human can confirm the binding.

import type {
  IpCategory,
  IpChannel,
  IpCustomer,
  IpItem,
  IpVendor,
} from "../types/entities";
import {
  canonicalizeCategory,
  canonicalizeChannelCode,
  canonicalizeCustomerName,
  canonicalizeSku,
  canonicalizeVendorName,
} from "./canonicalKeys";

export type IpReconcileTier = "external_ref" | "code" | "name" | "none";

export interface IpReconcileResult<T> {
  match: T | null;
  tier: IpReconcileTier;
  candidates_considered: number;
}

function fromExternalRef<T extends { external_refs: Record<string, string | undefined> }>(
  rows: T[],
  refKey: string,
  refValue: string | null,
): T | null {
  if (!refValue) return null;
  for (const r of rows) {
    if (r.external_refs?.[refKey] === refValue) return r;
  }
  return null;
}

// ── Item / SKU ─────────────────────────────────────────────────────────────
export interface ReconcileItemInput {
  sku?: string | null;
  xoro_item_id?: string | null;
  xoro_item_number?: string | null;
  shopify_variant_id?: string | null;
  shopify_sku?: string | null;
}

export function reconcileItem(input: ReconcileItemInput, items: IpItem[]): IpReconcileResult<IpItem> {
  const ext =
    fromExternalRef(items, "xoro_item_id", input.xoro_item_id ?? null) ||
    fromExternalRef(items, "xoro_item_number", input.xoro_item_number ?? null) ||
    fromExternalRef(items, "shopify_variant_id", input.shopify_variant_id ?? null) ||
    fromExternalRef(items, "shopify_sku", input.shopify_sku ?? null);
  if (ext) return { match: ext, tier: "external_ref", candidates_considered: items.length };

  const sku = canonicalizeSku(input.sku ?? input.shopify_sku ?? input.xoro_item_number);
  if (sku) {
    const byCode = items.find((i) => i.sku_code === sku);
    if (byCode) return { match: byCode, tier: "code", candidates_considered: items.length };
  }
  return { match: null, tier: "none", candidates_considered: items.length };
}

// ── Customer ───────────────────────────────────────────────────────────────
export interface ReconcileCustomerInput {
  customer_code?: string | null;
  name?: string | null;
  xoro_customer_id?: string | null;
  shopify_customer_id?: string | null;
}

export function reconcileCustomer(
  input: ReconcileCustomerInput,
  customers: IpCustomer[],
): IpReconcileResult<IpCustomer> {
  const ext =
    fromExternalRef(customers, "xoro_customer_id", input.xoro_customer_id ?? null) ||
    fromExternalRef(customers, "shopify_customer_id", input.shopify_customer_id ?? null);
  if (ext) return { match: ext, tier: "external_ref", candidates_considered: customers.length };

  if (input.customer_code) {
    const code = input.customer_code.trim();
    const byCode = customers.find((c) => c.customer_code === code);
    if (byCode) return { match: byCode, tier: "code", candidates_considered: customers.length };
  }
  const canonName = canonicalizeCustomerName(input.name);
  if (canonName) {
    const byName = customers.find((c) => canonicalizeCustomerName(c.name) === canonName);
    if (byName) return { match: byName, tier: "name", candidates_considered: customers.length };
  }
  return { match: null, tier: "none", candidates_considered: customers.length };
}

// ── Category ───────────────────────────────────────────────────────────────
export function reconcileCategory(name: string | null, categories: IpCategory[]): IpReconcileResult<IpCategory> {
  const canon = canonicalizeCategory(name);
  if (!canon) return { match: null, tier: "none", candidates_considered: categories.length };
  const byCode = categories.find((c) => c.category_code.toUpperCase() === canon);
  if (byCode) return { match: byCode, tier: "code", candidates_considered: categories.length };
  const byName = categories.find((c) => canonicalizeCategory(c.name) === canon);
  if (byName) return { match: byName, tier: "name", candidates_considered: categories.length };
  return { match: null, tier: "none", candidates_considered: categories.length };
}

// ── Channel ────────────────────────────────────────────────────────────────
export interface ReconcileChannelInput {
  channel_code?: string | null;
  storefront_key?: string | null;
  channel_name?: string | null;
}

export function reconcileChannel(input: ReconcileChannelInput, channels: IpChannel[]): IpReconcileResult<IpChannel> {
  if (input.storefront_key) {
    const byStore = channels.find((c) => c.storefront_key === input.storefront_key);
    if (byStore) return { match: byStore, tier: "external_ref", candidates_considered: channels.length };
  }
  const canon = canonicalizeChannelCode(input.channel_code ?? input.channel_name);
  if (!canon) return { match: null, tier: "none", candidates_considered: channels.length };
  const byCode = channels.find((c) => c.channel_code.toUpperCase() === canon);
  if (byCode) return { match: byCode, tier: "code", candidates_considered: channels.length };
  const byName = channels.find((c) => canonicalizeChannelCode(c.name) === canon);
  if (byName) return { match: byName, tier: "name", candidates_considered: channels.length };
  return { match: null, tier: "none", candidates_considered: channels.length };
}

// ── Vendor ─────────────────────────────────────────────────────────────────
export interface ReconcileVendorInput {
  vendor_code?: string | null;
  name?: string | null;
  xoro_vendor_id?: string | null;
}

export function reconcileVendor(input: ReconcileVendorInput, vendors: IpVendor[]): IpReconcileResult<IpVendor> {
  const ext = fromExternalRef(vendors, "xoro_vendor_id", input.xoro_vendor_id ?? null);
  if (ext) return { match: ext, tier: "external_ref", candidates_considered: vendors.length };
  if (input.vendor_code) {
    const byCode = vendors.find((v) => v.vendor_code === input.vendor_code);
    if (byCode) return { match: byCode, tier: "code", candidates_considered: vendors.length };
  }
  const canon = canonicalizeVendorName(input.name);
  if (canon) {
    const byName = vendors.find((v) => canonicalizeVendorName(v.name) === canon);
    if (byName) return { match: byName, tier: "name", candidates_considered: vendors.length };
  }
  return { match: null, tier: "none", candidates_considered: vendors.length };
}
