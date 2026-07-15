// src/tanda/arAgingHelpers.ts
//
// Pure helpers for the AR Aging panel — pivoting the two API row shapes, the
// per-account summary strip, the Shopify-D2C exclude filter, and bucket totals.
// Extracted so vitest can exercise the account-filter / exclude math without a
// browser or DB.

export type ApiRow = {
  customer_id: string;
  customer_name?: string | null;
  customer_code?: string | null;
  // view ("current") mode — long shape:
  age_bucket?: string;
  outstanding_cents?: number | string;
  invoice_count?: number | string;
  // RPC ("as_of") mode — wide shape:
  current_cents?: number | string;
  bucket_1_30_cents?: number | string;
  bucket_31_60_cents?: number | string;
  bucket_61_90_cents?: number | string;
  bucket_91_120_cents?: number | string;
  bucket_120_plus_cents?: number | string;
  total_outstanding_cents?: number | string;
};

export type PivotRow = {
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  current: number; b1_30: number; b31_60: number; b61_90: number;
  b91_120: number; b120plus: number; total: number;
};

export type BucketTotals = {
  current: number; b1_30: number; b31_60: number; b61_90: number;
  b91_120: number; b120plus: number; total: number;
};

export type AccountSummary = {
  ar_account_id: string | null;
  code: string | null;
  name: string | null;
  open_count: number;
  open_cents: number;
};

// View-mode rows arrive one per (customer, bucket) — pivot to one row per customer.
export function pivotViewRows(rows: ApiRow[]): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const r of rows) {
    const id = r.customer_id;
    if (!map.has(id)) {
      map.set(id, {
        customer_id: id,
        customer_name: r.customer_name ?? null,
        customer_code: r.customer_code ?? null,
        current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0, total: 0,
      });
    }
    const acc = map.get(id)!;
    const out = Number(r.outstanding_cents || 0);
    acc.total += out;
    switch (r.age_bucket) {
      case "current": acc.current += out;  break;
      case "1-30":    acc.b1_30 += out;    break;
      case "31-60":   acc.b31_60 += out;   break;
      case "61-90":   acc.b61_90 += out;   break;
      case "91-120":  acc.b91_120 += out;  break;
      case "120+":    acc.b120plus += out; break;
      default: break;
    }
  }
  return Array.from(map.values());
}

// RPC-mode rows are already pivoted — rename to the local shape.
export function rpcRowsToPivot(rows: ApiRow[]): PivotRow[] {
  return rows.map((r) => ({
    customer_id: r.customer_id,
    customer_name: r.customer_name ?? null,
    customer_code: r.customer_code ?? null,
    current:  Number(r.current_cents || 0),
    b1_30:    Number(r.bucket_1_30_cents || 0),
    b31_60:   Number(r.bucket_31_60_cents || 0),
    b61_90:   Number(r.bucket_61_90_cents || 0),
    b91_120:  Number(r.bucket_91_120_cents || 0),
    b120plus: Number(r.bucket_120_plus_cents || 0),
    total:    Number(r.total_outstanding_cents || 0),
  }));
}

// Sum every bucket across the given rows (the tfoot TOTAL line + exports).
export function sumBuckets(rows: PivotRow[]): BucketTotals {
  return rows.reduce(
    (acc, r) => {
      acc.current += r.current;
      acc.b1_30 += r.b1_30;
      acc.b31_60 += r.b31_60;
      acc.b61_90 += r.b61_90;
      acc.b91_120 += r.b91_120;
      acc.b120plus += r.b120plus;
      acc.total += r.total;
      return acc;
    },
    { current: 0, b1_30: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0, total: 0 },
  );
}

// Apply the free-text customer filter + the optional Shopify-D2C exclude.
// excludeIds is the set of "Shopify …" pseudo-customer ids (the unreconciled
// ecom artifact) — dropping them gives clean house-wholesale AR.
export function filterAgingRows(
  rows: PivotRow[],
  opts: { customerText?: string; excludeIds?: Set<string> },
): PivotRow[] {
  const text = (opts.customerText || "").trim().toLowerCase();
  const excl = opts.excludeIds;
  return rows.filter((r) => {
    if (excl && excl.has(r.customer_id)) return false;
    if (!text) return true;
    return (
      (r.customer_name || "").toLowerCase().includes(text) ||
      (r.customer_code || "").toLowerCase().includes(text)
    );
  });
}

// A friendly label for an AR control account card. Codes are stable; names are
// long — show "1108 · House".
const ACCOUNT_SHORT: Record<string, string> = {
  "1105": "Credit-card",
  "1107": "Factored",
  "1108": "House",
};
export function accountShortLabel(code: string | null, name: string | null): string {
  if (code && ACCOUNT_SHORT[code]) return `${code} · ${ACCOUNT_SHORT[code]}`;
  if (code) return code;
  return name || "(unmapped)";
}
