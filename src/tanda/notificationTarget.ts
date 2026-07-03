// notificationTarget — shared resolver for the Tangerine internal notification
// inbox (InternalNotificationCenter), which reads notification_events /
// notification_dispatches (NOT the `notifications` table that the vendor bell +
// cross-app NotificationsPage use).
//
// A notification_event carries (context_table, context_id, payload). Tangerine
// drives the active module from `?m=<moduleKey>` and panels seed list filters
// from drill params (?q / ?so / ?vendor / ?customer / ?open …). This resolver
// maps a context_table to the module that owns those records, and seeds the
// best available human-readable filter from `payload` so the click lands on (or
// filters to) the specific record — never exposing a raw UUID to the user.
//
// When an exact record can't be addressed (e.g. a CRM task list with no drill
// param, or a payload missing a human reference) it falls back gracefully to
// opening the relevant module/list. Returns null only when there is genuinely
// nowhere to go (e.g. a system/run event with no UI home), in which case the
// row simply marks-read without navigating.

type Payload = Record<string, unknown>;

export interface NotificationTargetEvent {
  context_table: string | null;
  context_id: string | null;
  payload?: Payload | null;
  kind?: string;
}

function s(v: unknown): string | null {
  if (v == null) return null;
  const str = String(v).trim();
  return str ? str : null;
}

/**
 * Resolve a Tangerine module + drill params for a notification event.
 *
 * @returns { module, params } when navigable, or null when there's no UI home.
 *          `module` is a Tangerine moduleKey (the `?m=` value); `params` are
 *          drill query params the target panel reads on mount.
 */
export function notificationTarget(
  ev: NotificationTargetEvent,
): { module: string; params: Record<string, string> } | null {
  const table = (ev.context_table || "").trim();
  const id = s(ev.context_id);
  const p = (ev.payload || {}) as Payload;

  // Human references producers commonly stash in payload — used for `q=` so we
  // filter by a readable number rather than a UUID.
  const invoiceNumber = s(p.invoice_number);
  const soNumber = s(p.so_number);
  const poNumber = s(p.po_number);

  switch (table) {
    // ── Sales / orders ─────────────────────────────────────────────────────
    case "sales_orders":
      if (soNumber) return { module: "sales_orders", params: { q: soNumber } };
      if (id) return { module: "sales_orders", params: { so: id } };
      return { module: "sales_orders", params: {} };

    case "tanda_pos":
    case "purchase_orders":
      if (poNumber) return { module: "purchase_orders", params: { q: poNumber } };
      return { module: "purchase_orders", params: {} };

    // ── AR ─────────────────────────────────────────────────────────────────
    case "ar_invoices":
      return invoiceNumber
        ? { module: "ar_invoices", params: { q: invoiceNumber } }
        : { module: "ar_invoices", params: {} };
    case "ar_receipts":
      return { module: "ar_receipts", params: {} };

    // ── AP (producers tag AP invoices as "invoices") ──────────────────────────
    case "invoices":
    case "ap_invoices":
      return invoiceNumber
        ? { module: "ap_invoices", params: { q: invoiceNumber } }
        : { module: "ap_invoices", params: {} };

    // ── Parties ─────────────────────────────────────────────────────────────
    case "customers": {
      const params: Record<string, string> = {};
      if (id) params.open = id;
      const contactId = s(p.contact_id);
      const noteId = s(p.note_id);
      if (contactId) params.contact = contactId;
      if (noteId) params.note = noteId;
      return { module: "customer_master", params };
    }
    case "vendors":
      return id
        ? { module: "vendor_master", params: { open: id } }
        : { module: "vendor_master", params: {} };

    // ── GL / accounting ───────────────────────────────────────────────────
    case "gl_periods":
      return { module: "gl_periods", params: {} };
    case "journal_entries":
      return { module: "journal_entries", params: id ? { open: id } : {} };

    // ── Inventory ─────────────────────────────────────────────────────────
    case "inventory_adjustments":
      return { module: "inventory_adjustments", params: {} };
    case "inventory_cycle_counts":
      return { module: "cycle_counts", params: {} };

    // ── CRM ───────────────────────────────────────────────────────────────
    case "crm_tasks":
      return { module: "crm_tasks", params: {} };

    // ── RFQs ──────────────────────────────────────────────────────────────
    case "rfqs":
      return { module: "rfqs", params: {} };

    // Year-end close targets the entity → trial balance / periods overview.
    case "entities":
      return { module: "gl_periods", params: {} };

    // System/run events (e.g. xoro_mirror_runs) have no per-record UI home.
    default:
      return null;
  }
}

/**
 * Build the in-app URL for a notification event, or null when not navigable.
 * Tangerine reads `?m=` + drill params; we render a same-app relative URL so
 * the existing `?m=` deep-link contract opens the panel.
 */
export function notificationTargetUrl(ev: NotificationTargetEvent): string | null {
  const t = notificationTarget(ev);
  if (!t) return null;
  const sp = new URLSearchParams();
  sp.set("m", t.module);
  for (const [k, v] of Object.entries(t.params)) if (v) sp.set(k, v);
  return `?${sp.toString()}`;
}
