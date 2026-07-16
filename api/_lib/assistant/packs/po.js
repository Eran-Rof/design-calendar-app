// P28 capability pack — Purchase Orders / Procurement.
//
// Spans BOTH PO data models (arch §12 risk 5): native purchase_orders AND
// mirrored tanda_pos. Where a union view already exists we use it —
// ip_open_purchase_orders carries both models' open lines with a `source`
// column, so due/overdue receipt counts cover the whole book by default.
//
// Provider contract: { key, module_key, run(admin, ctx) => item[] }.

async function headCount(q) {
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

// Vendor replies nobody internal has read yet (PO WIP messages thread).
const portalRepliesUnread = {
  key: "po.portal_replies_unread",
  module_key: "procurement",
  async run(admin) {
    const n = await headCount(
      admin.from("po_messages").select("id", { count: "exact", head: true })
        .eq("sender_type", "vendor").eq("read_by_internal", false),
    );
    if (n === 0) return [];
    return [{
      key: "po.portal_replies_unread",
      title: "Vendor replies unread",
      detail: "Vendor messages on POs with no internal read",
      count: n,
      severity: "action",
      href: "/tanda",
      panel: null,
    }];
  },
};

// 3-way-match drafts needing a human decision (variance / exception).
const threeWayExceptions = {
  key: "po.three_way_exceptions",
  module_key: "ap_invoices",
  async run(admin) {
    const n = await headCount(
      admin.from("vendor_invoice_drafts").select("id", { count: "exact", head: true })
        .in("three_way_match_status", ["variance", "exception"]),
    );
    if (n === 0) return [];
    return [{
      key: "po.three_way_exceptions",
      title: "3-way match exceptions",
      detail: "Vendor invoices out of tolerance vs PO/receipt",
      count: n,
      severity: "action",
      panel: "three_way_match",
    }];
  },
};

// Open PO lines due to receive within 7 days — both PO models via the
// union table (source column distinguishes tangerine vs xoro).
const receiptsDue7d = {
  key: "po.receipts_due_7d",
  module_key: "procurement",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const plus7 = new Date(new Date(today).getTime() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const n = await headCount(
      admin.from("ip_open_purchase_orders").select("id", { count: "exact", head: true })
        .gt("qty_open", 0).gte("expected_date", today).lte("expected_date", plus7),
    );
    if (n === 0) return [];
    return [{
      key: "po.receipts_due_7d",
      title: "PO lines due to receive this week",
      detail: "Open PO lines with expected date in the next 7 days",
      count: n,
      severity: "info",
      panel: "receiving",
    }];
  },
};

// Open PO lines already past their expected date — the aging problem.
const receiptsOverdue = {
  key: "po.receipts_overdue",
  module_key: "procurement",
  async run(admin, ctx) {
    const today = ctx.todayISO || new Date().toISOString().slice(0, 10);
    const n = await headCount(
      admin.from("ip_open_purchase_orders").select("id", { count: "exact", head: true })
        .gt("qty_open", 0).lt("expected_date", today),
    );
    if (n === 0) return [];
    return [{
      key: "po.receipts_overdue",
      title: "PO lines past expected receipt",
      detail: "Open quantity with an expected date already behind us",
      count: n,
      severity: "warn",
      panel: "receiving",
    }];
  },
};

// QC inspections that failed and still need a disposition decision.
const qcFailedOpen = {
  key: "po.qc_failed_open",
  module_key: "procurement",
  async run(admin) {
    // Status vocabulary is CHECK (pending|passed|failed|partial) — 'failed',
    // not 'fail' (the old value never matched, so this to-do never fired).
    const n = await headCount(
      admin.from("tanda_po_qc_inspections").select("id", { count: "exact", head: true })
        .eq("status", "failed"),
    );
    if (n === 0) return [];
    return [{
      key: "po.qc_failed_open",
      title: "Failed QC inspections",
      detail: "Failures awaiting a disposition (write-off / vendor credit / RMA / rework)",
      count: n,
      severity: "warn",
      panel: "qc_inspections",
      // QC Inspections reads a status filter — land it on the failed ones.
      drill: { status: "failed" },
    }];
  },
};

// EDI outbox health (#1742): queued = normal; repeated attempts = stuck.
const ediOutbox = {
  key: "po.edi_outbox",
  module_key: "procurement",
  async run(admin) {
    const queued = await headCount(
      admin.from("edi_messages").select("id", { count: "exact", head: true })
        .eq("direction", "outbound").eq("transmitted", false),
    );
    if (queued === 0) {
      return [{ key: "po.edi_outbox", label: "EDI outbox", state: "ok", detail: "No messages waiting", panel: "edi" }];
    }
    const stuck = await headCount(
      admin.from("edi_messages").select("id", { count: "exact", head: true })
        .eq("direction", "outbound").eq("transmitted", false).gte("attempts", 3),
    );
    return [{
      key: "po.edi_outbox",
      label: "EDI outbox",
      state: stuck > 0 ? "error" : "running",
      detail: stuck > 0 ? `${stuck} of ${queued} queued messages stuck after 3+ attempts` : `${queued} queued for transmission`,
      panel: "edi",
    }];
  },
};

const suggestChaseOverdue = {
  key: "po.suggest_chase_overdue",
  module_key: "procurement",
  derive(aggregate) {
    const overdue = aggregate.todos.find((t) => t.key === "po.receipts_overdue");
    if (!overdue || (overdue.count || 0) === 0) return [];
    return [{
      key: "po.suggest_chase_overdue",
      text: "Overdue PO lines usually mean a stale expected date or a vendor slip — update dates from the vendor portal thread before they distort planning supply.",
      panel: "receiving",
    }];
  },
};

export default {
  key: "po",
  label: "Purchase Orders",
  module_keys: ["procurement", "ap_invoices"],
  todos: [portalRepliesUnread, threeWayExceptions, receiptsDue7d, receiptsOverdue, qcFailedOpen],
  processes: [ediOutbox],
  suggestions: [suggestChaseOverdue],
  panels: {
    three_way_match: {}, receiving: {}, qc_inspections: {}, edi: {}, purchase_orders: {},
  },
};
