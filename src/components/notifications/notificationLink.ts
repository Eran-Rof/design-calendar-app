// notificationLink — shared resolver that turns a notification row into the
// deep-link URL of the actual task/record it refers to.
//
// Background: notifications live in the single `notifications` table and are
// surfaced by the vendor bell (src/vendor/NotificationBell.tsx) and the shared
// cross-app NotificationsPage (src/components/notifications/*). A producer may
// store an explicit `link`, but historically many stored only a weak link (the
// app home `/`, or a list page like `/tangerine?m=sales_orders`) while putting
// the real record reference in `metadata` (po_id, so_number, rfq_id, …). Those
// rows were effectively inert — clicking went nowhere useful.
//
// This resolver gives every notification a best-effort deep link:
//   1. If the producer's `link` already points at a specific record, keep it.
//   2. Otherwise derive a deep link from `metadata` + `event_type`.
//   3. Otherwise fall back to the relevant app/list (vendor) or null (internal,
//      so the row just marks-read without navigating).
//
// Two recipient worlds share the table:
//   - kind="vendor"   → vendor-portal routes (/vendor/...). react-router nav.
//   - kind="internal" → Tangerine deep links (/tangerine?m=...&q=...) consumed
//                       by Tangerine's `?m=` + drill-param contract.
//
// We never surface a raw UUID to the user: the link uses a human reference
// (so_number, po_number, invoice_number) for the `q=` drill param when one is
// in metadata, falling back to the record id only where the target route
// itself addresses records by id (e.g. /vendor/pos/:id).

import type { NotificationRow } from "./types";

type Meta = Record<string, unknown>;

function s(v: unknown): string | null {
  if (v == null) return null;
  const str = String(v).trim();
  return str ? str : null;
}

// A producer link is "specific" (already points at a record) when it is not the
// bare app home and not a plain list page. List pages we want to UPGRADE to a
// filtered deep link when metadata lets us.
function isWeakLink(link: string | null | undefined): boolean {
  if (!link) return true;
  const l = link.trim();
  if (l === "" || l === "/" || l === "#") return true;
  // A query-string already present means the producer filtered the list — keep.
  if (l.includes("?") || l.includes("/")) {
    // /tangerine?m=sales_orders (no further filter) is still a bare list — treat
    // as weak so we can append a ?q= drill param from metadata.
    const m = l.match(/^\/tangerine\?m=([a-z_]+)$/);
    if (m) return true;
    // /vendor/<list> with no id is a list page — weak (upgrade if we can).
    if (/^\/vendor\/[a-z-]+$/.test(l)) return true;
    return false; // already specific (has id or extra params)
  }
  return false;
}

// Vendor portal: map an event + metadata to a record route.
function vendorLink(eventType: string, meta: Meta): string | null {
  const poId = s(meta.po_id);
  const poNumber = s(meta.po_number);
  const rfqId = s(meta.rfq_id);
  const invoiceId = s(meta.invoice_id) || s(meta.ar_invoice_id) || s(meta.ap_invoice_id);
  const disputeId = s(meta.dispute_id);
  const contractId = s(meta.contract_id);

  if (poId) return `/vendor/pos/${poId}`;
  if (poNumber) return `/vendor/pos?q=${encodeURIComponent(poNumber)}`;
  if (rfqId) return `/vendor/rfqs/${rfqId}`;
  if (invoiceId) return `/vendor/invoices/${invoiceId}`;
  if (disputeId) return `/vendor/disputes/${disputeId}`;
  if (contractId) return `/vendor/contracts/${contractId}`;

  // Event-type fallbacks to the relevant list when no id is present.
  if (eventType.startsWith("onboarding")) return "/vendor/onboarding";
  if (eventType.startsWith("compliance")) return "/vendor/compliance";
  if (eventType.startsWith("scf")) return "/vendor/scf";
  if (eventType.startsWith("discount_offer")) return "/vendor/discount-offers";
  if (eventType.startsWith("contract")) return "/vendor/contracts";
  if (eventType.startsWith("dispute")) return "/vendor/disputes";
  if (eventType.startsWith("rfq")) return "/vendor/rfqs";
  if (eventType.startsWith("po_")) return "/vendor/pos/" + (poId || "");
  if (eventType.startsWith("invoice") || eventType.startsWith("payment")) return "/vendor/invoices";
  if (eventType.startsWith("shipment")) return "/vendor/shipments";
  return null;
}

// Internal (Tangerine): map an event + metadata to a `?m=<module>` deep link,
// seeding a `q=` drill param from a human reference where available so the
// target list filters to (and the panel can highlight) the specific record.
function internalLink(eventType: string, meta: Meta): string | null {
  const soNumber = s(meta.so_number);
  const soId = s(meta.sales_order_id);
  const poNumber = s(meta.po_number);
  const invoiceNumber = s(meta.invoice_number);
  const arInvoiceId = s(meta.ar_invoice_id);
  const apInvoiceId = s(meta.ap_invoice_id);
  const vendorId = s(meta.vendor_id);
  const customerId = s(meta.customer_id);
  const rfqId = s(meta.rfq_id);

  // Sales orders
  if (soNumber) return `/tangerine?m=sales_orders&q=${encodeURIComponent(soNumber)}`;
  if (soId) return `/tangerine?m=sales_orders&so=${encodeURIComponent(soId)}`;

  // Purchase orders
  if (poNumber) return `/tangerine?m=purchase_orders&q=${encodeURIComponent(poNumber)}`;

  // AR / AP invoices (q matches invoice_number ilike)
  if (eventType.startsWith("ar_invoice") || arInvoiceId) {
    return invoiceNumber
      ? `/tangerine?m=ar_invoices&q=${encodeURIComponent(invoiceNumber)}`
      : customerId
        ? `/tangerine?m=ar_invoices&customer=${encodeURIComponent(customerId)}`
        : `/tangerine?m=ar_invoices`;
  }
  if (eventType.startsWith("ap_invoice") || apInvoiceId || eventType.startsWith("invoice")) {
    return invoiceNumber
      ? `/tangerine?m=ap_invoices&q=${encodeURIComponent(invoiceNumber)}`
      : vendorId
        ? `/tangerine?m=ap_invoices&vendor=${encodeURIComponent(vendorId)}`
        : `/tangerine?m=ap_invoices`;
  }

  // RFQs
  if (rfqId || eventType.startsWith("rfq")) return `/tangerine?m=rfqs`;

  // Party masters (nudge-to-complete etc.)
  if (eventType.startsWith("party") || eventType.startsWith("customer")) {
    return customerId
      ? `/tangerine?m=customer_master&open=${encodeURIComponent(customerId)}`
      : `/tangerine?m=customer_master`;
  }
  if (eventType.startsWith("vendor")) {
    return vendorId
      ? `/tangerine?m=vendor_master&open=${encodeURIComponent(vendorId)}`
      : `/tangerine?m=vendor_master`;
  }

  return null;
}

/**
 * Resolve the navigation target for a notification row.
 *
 * @param row   the notification (link + event_type + metadata)
 * @param kind  recipient world — "vendor" (portal routes) or "internal"
 *              (Tangerine ?m= deep links). Defaults to "internal".
 * @returns a URL string to navigate to, or null when nothing can be resolved
 *          (caller should just mark-read without navigating).
 */
export function notificationLink(
  row: Pick<NotificationRow, "link" | "event_type" | "metadata">,
  kind: "vendor" | "internal" = "internal",
): string | null {
  // 1. Keep an already-specific producer link.
  if (!isWeakLink(row.link)) return row.link as string;

  // 2. Derive from metadata + event_type.
  const meta = (row.metadata || {}) as Meta;
  const eventType = row.event_type || "";
  const derived = kind === "vendor"
    ? vendorLink(eventType, meta)
    : internalLink(eventType, meta);
  if (derived) return derived;

  // 3. Fall back to the producer's weak link (a list page is better than
  //    nothing); null only if there was none at all.
  return s(row.link);
}
