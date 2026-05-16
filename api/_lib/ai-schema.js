// AI query allowlist — declares every table the Ask AI panel can read,
// across four app domains: po_wip, vendor_portal, planning, design_calendar.
//
// Per-column gating: any column marked { pii: true } is silently stripped
// from describe_table responses AND rejected as a filter/group_by/agg
// target. Whole-table exclusions (banking_details, payments, raw card
// data, AES-encrypted config blobs) are simply absent from this registry
// — the executor never touches a table that isn't declared here.
//
// Safe column flags:
//   filterable  — usable in `query_table` filters (eq, neq, gt, gte, lt, lte, in, ilike, is_null)
//   groupable   — usable as a group_by axis
//   aggregatable — usable as a sum / avg / min / max target (numeric only)
//   date        — usable in date_range filter
//   pii         — excluded from EVERY response and rejected in inputs
//
// When in doubt, leave flags off — opt-in beats opt-out.

const STRING_OPS = ["eq", "neq", "in", "ilike", "is_null", "not_is_null"];
const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "is_null", "not_is_null"];
const DATE_OPS   = ["eq", "neq", "gt", "gte", "lt", "lte", "is_null", "not_is_null"];

// ── PO WIP (PO lifecycle: ack → in production → shipped → received) ───
const PO_WIP = {
  domain: "po_wip",
  description: "Purchase Order lifecycle tracking — vendor acknowledgments, line items, shipments, invoices, receipts, and the 3-way match.",
  tables: {
    tanda_pos: {
      description: "PO master (Xoro-synced). One row per PO.",
      columns: {
        uuid_id:    { type: "uuid", filterable: true, groupable: true },
        po_number:  { type: "text", filterable: true, groupable: true },
        vendor_id:  { type: "uuid", filterable: true, groupable: true },
        buyer_po:   { type: "text", filterable: true },
      },
    },
    po_line_items: {
      description: "PO line detail. Quantities, prices, expected delivery per line.",
      columns: {
        id:                     { type: "uuid", filterable: true },
        po_id:                  { type: "uuid", filterable: true, groupable: true },
        line_index:             { type: "int",  filterable: true },
        item_number:            { type: "text", filterable: true, groupable: true },
        description:            { type: "text", filterable: true },
        qty_ordered:            { type: "numeric", aggregatable: true },
        qty_received:           { type: "numeric", aggregatable: true },
        qty_remaining:          { type: "numeric", aggregatable: true },
        unit_price:             { type: "numeric", aggregatable: true },
        line_total:             { type: "numeric", aggregatable: true },
        date_expected_delivery: { type: "text", filterable: true },
      },
    },
    po_acknowledgments: {
      description: "When each vendor user acknowledged receipt of a PO.",
      columns: {
        po_number:       { type: "text", filterable: true, groupable: true },
        vendor_user_id:  { type: "uuid", filterable: true },
        acknowledged_at: { type: "date", filterable: true, date: true, groupable: true },
        note:            { type: "text" },
      },
    },
    shipments: {
      description: "Inbound shipments (BL / container tracking + ASN workflow).",
      columns: {
        id:              { type: "uuid", filterable: true },
        vendor_id:       { type: "uuid", filterable: true, groupable: true },
        po_id:           { type: "uuid", filterable: true, groupable: true },
        po_number:       { type: "text", filterable: true, groupable: true },
        number:          { type: "text", filterable: true },
        number_type:     { type: "text", filterable: true, groupable: true },
        sealine_name:    { type: "text", filterable: true, groupable: true },
        pol_locode:      { type: "text", filterable: true, groupable: true },
        pod_locode:      { type: "text", filterable: true, groupable: true },
        eta:             { type: "date", filterable: true, date: true },
        ata:             { type: "date", filterable: true, date: true },
        current_status:  { type: "text", filterable: true, groupable: true },
        workflow_status: { type: "text", filterable: true, groupable: true },
        invoice_id:      { type: "uuid", filterable: true },
      },
    },
    shipment_events: {
      description: "Tracking event log per shipment (Searates milestones).",
      columns: {
        shipment_id:     { type: "uuid", filterable: true, groupable: true },
        event_date:      { type: "date", filterable: true, date: true },
        event_type:      { type: "text", filterable: true, groupable: true },
        status:          { type: "text", filterable: true, groupable: true },
        description:     { type: "text" },
        location_locode: { type: "text", filterable: true, groupable: true },
        is_actual:       { type: "bool", filterable: true },
      },
    },
    po_messages: {
      description: "PO-scoped messaging between vendor and internal.",
      columns: {
        po_id:              { type: "uuid", filterable: true, groupable: true },
        sender_type:        { type: "text", filterable: true, groupable: true },
        sender_name:        { type: "text", filterable: true },
        body:               { type: "text" },
        read_by_vendor:     { type: "bool", filterable: true },
        read_by_internal:   { type: "bool", filterable: true },
        created_at:         { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    invoices: {
      description: "Vendor-submitted invoices. Status tracks the 3-way match outcome.",
      columns: {
        id:                { type: "uuid", filterable: true },
        vendor_id:         { type: "uuid", filterable: true, groupable: true },
        po_id:             { type: "uuid", filterable: true, groupable: true },
        invoice_number:    { type: "text", filterable: true },
        invoice_date:      { type: "date", filterable: true, date: true, groupable: true },
        due_date:          { type: "date", filterable: true, date: true },
        subtotal:          { type: "numeric", aggregatable: true },
        tax:               { type: "numeric", aggregatable: true },
        total:             { type: "numeric", aggregatable: true },
        currency:          { type: "text", filterable: true, groupable: true },
        status:            { type: "text", filterable: true, groupable: true },
        submitted_at:      { type: "date", filterable: true, date: true },
        approved_at:       { type: "date", filterable: true, date: true },
        paid_at:           { type: "date", filterable: true, date: true },
        payment_method:    { type: "text", filterable: true, groupable: true },
      },
    },
    receipts: {
      description: "Warehouse-received goods (3PL via Xoro EDI).",
      columns: {
        id:               { type: "uuid", filterable: true },
        vendor_id:        { type: "uuid", filterable: true, groupable: true },
        po_id:            { type: "uuid", filterable: true, groupable: true },
        shipment_id:      { type: "uuid", filterable: true },
        receipt_number:   { type: "text", filterable: true },
        received_date:    { type: "date", filterable: true, date: true, groupable: true },
        warehouse_locode: { type: "text", filterable: true, groupable: true },
        status:           { type: "text", filterable: true, groupable: true },
      },
    },
  },
};

// ── Vendor Portal ─────────────────────────────────────────────────────
// Banking, virtual_cards card data, payments.metadata, erp_integrations.config,
// edi_messages.raw_content are intentionally excluded per PII policy.
const VENDOR_PORTAL = {
  domain: "vendor_portal",
  description: "External vendor relationships — vendor profiles, invoices, compliance docs, contracts, disputes, RFQs, health scores. Banking and card data are not exposed.",
  tables: {
    vendors: {
      description: "Vendor master.",
      columns: {
        id:           { type: "uuid", filterable: true, groupable: true },
        name:         { type: "text", filterable: true, groupable: true },
        country:      { type: "text", filterable: true, groupable: true },
        transit_days: { type: "int",  filterable: true, aggregatable: true },
        categories:   { type: "text[]" },
        contact:      { type: "text", filterable: true },
        email:        { type: "text", filterable: true },
        moq:          { type: "int",  aggregatable: true },
        deleted_at:   { type: "date", filterable: true, date: true },
        created_at:   { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    compliance_documents: {
      description: "Compliance docs (insurance, certs) per vendor with expiry.",
      columns: {
        vendor_id:         { type: "uuid", filterable: true, groupable: true },
        document_type_id:  { type: "uuid", filterable: true, groupable: true },
        file_name:         { type: "text" },
        issued_at:         { type: "date", filterable: true, date: true },
        expiry_date:       { type: "date", filterable: true, date: true, groupable: true },
        status:            { type: "text", filterable: true, groupable: true },
        rejection_reason:  { type: "text" },
        reviewed_at:       { type: "date", filterable: true, date: true },
        uploaded_at:       { type: "date", filterable: true, date: true },
      },
    },
    contracts: {
      description: "Vendor contracts with expiry tracking.",
      columns: {
        id:            { type: "uuid", filterable: true },
        vendor_id:     { type: "uuid", filterable: true, groupable: true },
        title:         { type: "text", filterable: true },
        status:        { type: "text", filterable: true, groupable: true },
        contract_type: { type: "text", filterable: true, groupable: true },
        start_date:    { type: "date", filterable: true, date: true },
        end_date:      { type: "date", filterable: true, date: true, groupable: true },
        value:         { type: "numeric", aggregatable: true },
        currency:      { type: "text", filterable: true, groupable: true },
        signed_at:     { type: "date", filterable: true, date: true },
      },
    },
    disputes: {
      description: "Invoice / shipment / payment disputes.",
      columns: {
        vendor_id:   { type: "uuid", filterable: true, groupable: true },
        invoice_id:  { type: "uuid", filterable: true },
        po_id:       { type: "uuid", filterable: true },
        type:        { type: "text", filterable: true, groupable: true },
        status:      { type: "text", filterable: true, groupable: true },
        priority:    { type: "text", filterable: true, groupable: true },
        subject:     { type: "text", filterable: true },
        resolved_at: { type: "date", filterable: true, date: true },
        created_at:  { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    rfqs: {
      description: "RFQs (request for quote) issued to vendors.",
      columns: {
        id:                       { type: "uuid", filterable: true },
        entity_id:                { type: "uuid", filterable: true, groupable: true },
        title:                    { type: "text", filterable: true },
        category:                 { type: "text", filterable: true, groupable: true },
        status:                   { type: "text", filterable: true, groupable: true },
        submission_deadline:      { type: "date", filterable: true, date: true },
        delivery_required_by:     { type: "date", filterable: true, date: true },
        estimated_quantity:       { type: "int", aggregatable: true },
        estimated_budget:         { type: "numeric", aggregatable: true },
        currency:                 { type: "text", filterable: true, groupable: true },
        awarded_to_vendor_id:     { type: "uuid", filterable: true, groupable: true },
        awarded_at:               { type: "date", filterable: true, date: true },
        created_at:               { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    rfq_quotes: {
      description: "Vendor quotes against an RFQ.",
      columns: {
        rfq_id:         { type: "uuid", filterable: true, groupable: true },
        vendor_id:      { type: "uuid", filterable: true, groupable: true },
        status:         { type: "text", filterable: true, groupable: true },
        total_price:    { type: "numeric", aggregatable: true },
        lead_time_days: { type: "int", aggregatable: true },
        valid_until:    { type: "date", filterable: true, date: true },
        submitted_at:   { type: "date", filterable: true, date: true },
      },
    },
    dynamic_discount_offers: {
      description: "Early-pay discount offers (annualised return shown to vendor).",
      columns: {
        invoice_id:          { type: "uuid", filterable: true },
        vendor_id:           { type: "uuid", filterable: true, groupable: true },
        original_due_date:   { type: "date", filterable: true, date: true },
        early_payment_date:  { type: "date", filterable: true, date: true },
        discount_pct:        { type: "numeric", aggregatable: true },
        discount_amount:     { type: "numeric", aggregatable: true },
        net_payment_amount:  { type: "numeric", aggregatable: true },
        status:              { type: "text", filterable: true, groupable: true },
        offered_at:          { type: "date", filterable: true, date: true },
        expires_at:          { type: "date", filterable: true, date: true },
        accepted_at:         { type: "date", filterable: true, date: true },
      },
    },
    finance_requests: {
      description: "Supply chain financing requests.",
      columns: {
        program_id:         { type: "uuid", filterable: true, groupable: true },
        invoice_id:         { type: "uuid", filterable: true },
        vendor_id:          { type: "uuid", filterable: true, groupable: true },
        requested_amount:   { type: "numeric", aggregatable: true },
        approved_amount:    { type: "numeric", aggregatable: true },
        fee_pct:            { type: "numeric", aggregatable: true },
        fee_amount:         { type: "numeric", aggregatable: true },
        net_disbursement:   { type: "numeric", aggregatable: true },
        status:             { type: "text", filterable: true, groupable: true },
        requested_at:       { type: "date", filterable: true, date: true },
        funded_at:          { type: "date", filterable: true, date: true },
        repayment_due_date: { type: "date", filterable: true, date: true },
      },
    },
    onboarding_workflows: {
      description: "Vendor onboarding progress.",
      columns: {
        vendor_id:       { type: "uuid", filterable: true, groupable: true },
        status:          { type: "text", filterable: true, groupable: true },
        current_step:    { type: "int",  filterable: true, aggregatable: true },
        started_at:      { type: "date", filterable: true, date: true },
        completed_at:    { type: "date", filterable: true, date: true },
        rejection_reason:{ type: "text" },
      },
    },
    anomaly_flags: {
      description: "Anomaly detection flags (duplicate invoices, price variance, etc.).",
      columns: {
        vendor_id:   { type: "uuid", filterable: true, groupable: true },
        entity_type: { type: "text", filterable: true, groupable: true },
        entity_id:   { type: "uuid", filterable: true },
        type:        { type: "text", filterable: true, groupable: true },
        severity:    { type: "text", filterable: true, groupable: true },
        description: { type: "text" },
        status:      { type: "text", filterable: true, groupable: true },
        detected_at: { type: "date", filterable: true, date: true, groupable: true },
        reviewed_at: { type: "date", filterable: true, date: true },
      },
    },
    vendor_health_scores: {
      description: "Computed per-vendor health scores per period.",
      columns: {
        vendor_id:            { type: "uuid", filterable: true, groupable: true },
        overall_score:        { type: "numeric", aggregatable: true },
        delivery_score:       { type: "numeric", aggregatable: true },
        quality_score:        { type: "numeric", aggregatable: true },
        compliance_score:     { type: "numeric", aggregatable: true },
        financial_score:      { type: "numeric", aggregatable: true },
        responsiveness_score: { type: "numeric", aggregatable: true },
        period_start:         { type: "date", filterable: true, date: true, groupable: true },
        period_end:           { type: "date", filterable: true, date: true },
        generated_at:         { type: "date", filterable: true, date: true },
      },
    },
    esg_scores: {
      description: "ESG (environmental / social / governance) scores per vendor period.",
      columns: {
        vendor_id:             { type: "uuid", filterable: true, groupable: true },
        period_start:          { type: "date", filterable: true, date: true, groupable: true },
        period_end:            { type: "date", filterable: true, date: true },
        environmental_score:   { type: "numeric", aggregatable: true },
        social_score:          { type: "numeric", aggregatable: true },
        governance_score:      { type: "numeric", aggregatable: true },
        overall_score:         { type: "numeric", aggregatable: true },
      },
    },
    notifications: {
      description: "Notification feed.",
      columns: {
        event_type:    { type: "text", filterable: true, groupable: true },
        title:         { type: "text", filterable: true },
        read_at:       { type: "date", filterable: true, date: true },
        email_status:  { type: "text", filterable: true, groupable: true },
        created_at:    { type: "date", filterable: true, date: true, groupable: true },
      },
    },
  },
};

// ── Inventory Planning (beyond phase 2's ip_sales_history_wholesale etc.) ──
const PLANNING = {
  domain: "planning",
  description: "Inventory planning — forecasts, allocations, recommendations, execution batches, scenarios, accuracy metrics. Phase-2 tools already cover ip_sales_history_wholesale, ip_open_sales_orders, ip_open_purchase_orders, ip_item_master, ip_customer_master.",
  tables: {
    ip_wholesale_forecast: {
      description: "Wholesale forecast per customer + SKU + period (monthly or weekly).",
      columns: {
        planning_run_id:      { type: "uuid", filterable: true, groupable: true },
        customer_id:          { type: "uuid", filterable: true, groupable: true },
        sku_id:               { type: "uuid", filterable: true, groupable: true },
        period_code:          { type: "text", filterable: true, groupable: true },
        system_forecast_qty:  { type: "numeric", aggregatable: true },
        override_qty:         { type: "numeric", aggregatable: true },
        final_forecast_qty:   { type: "numeric", aggregatable: true },
        buyer_request_qty:    { type: "numeric", aggregatable: true },
        forecast_method:      { type: "text", filterable: true, groupable: true },
        trailing_4w_qty:      { type: "numeric", aggregatable: true },
        trailing_13w_qty:     { type: "numeric", aggregatable: true },
      },
    },
    ip_ecom_forecast: {
      description: "Ecom forecast per channel + SKU + week.",
      columns: {
        planning_run_id:      { type: "uuid", filterable: true, groupable: true },
        channel_id:           { type: "uuid", filterable: true, groupable: true },
        sku_id:               { type: "uuid", filterable: true, groupable: true },
        week_start:           { type: "date", filterable: true, date: true, groupable: true },
        period_code:          { type: "text", filterable: true, groupable: true },
        system_forecast_qty:  { type: "numeric", aggregatable: true },
        final_forecast_qty:   { type: "numeric", aggregatable: true },
        protected_ecom_qty:   { type: "numeric", aggregatable: true },
        promo_flag:           { type: "bool", filterable: true },
        launch_flag:          { type: "bool", filterable: true },
        markdown_flag:        { type: "bool", filterable: true },
        forecast_method:      { type: "text", filterable: true, groupable: true },
        return_rate:          { type: "numeric", aggregatable: true },
      },
    },
    ip_projected_inventory: {
      description: "Projected end-of-period inventory + shortage/excess per SKU per period.",
      columns: {
        planning_run_id:           { type: "uuid", filterable: true, groupable: true },
        sku_id:                    { type: "uuid", filterable: true, groupable: true },
        category_id:               { type: "uuid", filterable: true, groupable: true },
        period_code:               { type: "text", filterable: true, groupable: true },
        beginning_on_hand_qty:     { type: "numeric", aggregatable: true },
        inbound_receipts_qty:      { type: "numeric", aggregatable: true },
        inbound_po_qty:            { type: "numeric", aggregatable: true },
        wip_qty:                   { type: "numeric", aggregatable: true },
        total_available_supply_qty:{ type: "numeric", aggregatable: true },
        wholesale_demand_qty:      { type: "numeric", aggregatable: true },
        ecom_demand_qty:           { type: "numeric", aggregatable: true },
        protected_ecom_qty:        { type: "numeric", aggregatable: true },
        allocated_total_qty:       { type: "numeric", aggregatable: true },
        ending_inventory_qty:      { type: "numeric", aggregatable: true },
        shortage_qty:              { type: "numeric", aggregatable: true },
        excess_qty:                { type: "numeric", aggregatable: true },
        projected_stockout_flag:   { type: "bool", filterable: true, groupable: true },
      },
    },
    ip_inventory_recommendations: {
      description: "Recommended actions (buy / expedite / hold / cancel) per SKU per period.",
      columns: {
        planning_run_id:     { type: "uuid", filterable: true, groupable: true },
        sku_id:              { type: "uuid", filterable: true, groupable: true },
        category_id:         { type: "uuid", filterable: true, groupable: true },
        period_code:         { type: "text", filterable: true, groupable: true },
        recommendation_type: { type: "text", filterable: true, groupable: true },
        recommendation_qty:  { type: "numeric", aggregatable: true },
        action_reason:       { type: "text" },
        priority_level:      { type: "text", filterable: true, groupable: true },
        shortage_qty:        { type: "numeric", aggregatable: true },
        excess_qty:          { type: "numeric", aggregatable: true },
        service_risk_flag:   { type: "bool", filterable: true },
      },
    },
    ip_supply_exceptions: {
      description: "Planning exceptions log (stockouts, late POs, excess, etc.).",
      columns: {
        planning_run_id: { type: "uuid", filterable: true, groupable: true },
        sku_id:          { type: "uuid", filterable: true, groupable: true },
        category_id:     { type: "uuid", filterable: true, groupable: true },
        period_code:     { type: "text", filterable: true, groupable: true },
        exception_type:  { type: "text", filterable: true, groupable: true },
        severity:        { type: "text", filterable: true, groupable: true },
        created_at:      { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    ip_execution_batches: {
      description: "Execution batches (group of recommended actions sent for approval).",
      columns: {
        planning_run_id: { type: "uuid", filterable: true, groupable: true },
        scenario_id:     { type: "uuid", filterable: true },
        batch_name:      { type: "text", filterable: true },
        batch_type:      { type: "text", filterable: true, groupable: true },
        status:          { type: "text", filterable: true, groupable: true },
        approved_at:     { type: "date", filterable: true, date: true },
        created_at:      { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    ip_execution_actions: {
      description: "Individual actions within an execution batch.",
      columns: {
        execution_batch_id:  { type: "uuid", filterable: true, groupable: true },
        action_type:         { type: "text", filterable: true, groupable: true },
        sku_id:              { type: "uuid", filterable: true, groupable: true },
        vendor_id:           { type: "uuid", filterable: true, groupable: true },
        customer_id:         { type: "uuid", filterable: true, groupable: true },
        channel_id:          { type: "uuid", filterable: true, groupable: true },
        po_number:           { type: "text", filterable: true },
        suggested_qty:       { type: "numeric", aggregatable: true },
        approved_qty:        { type: "numeric", aggregatable: true },
        execution_status:    { type: "text", filterable: true, groupable: true },
        execution_method:    { type: "text", filterable: true, groupable: true },
        error_message:       { type: "text" },
        created_at:          { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    ip_forecast_accuracy: {
      description: "Retrospective forecast vs actual.",
      columns: {
        planning_run_id: { type: "uuid", filterable: true, groupable: true },
        sku_id:          { type: "uuid", filterable: true, groupable: true },
        period_code:     { type: "text", filterable: true, groupable: true },
        forecast_qty:    { type: "numeric", aggregatable: true },
        actual_qty:      { type: "numeric", aggregatable: true },
        variance_qty:    { type: "numeric", aggregatable: true },
        variance_pct:    { type: "numeric", aggregatable: true },
        mape:            { type: "numeric", aggregatable: true },
        rmse:            { type: "numeric", aggregatable: true },
        forecast_method: { type: "text", filterable: true, groupable: true },
      },
    },
    ip_vendor_timing_signals: {
      description: "Supply timing per SKU + vendor (avg lead time, delay risk).",
      columns: {
        sku_id:                  { type: "uuid", filterable: true, groupable: true },
        vendor_id:               { type: "uuid", filterable: true, groupable: true },
        avg_lead_time_days:      { type: "int", aggregatable: true },
        receipt_variability_days:{ type: "numeric", aggregatable: true },
        delay_risk_score:        { type: "numeric", aggregatable: true },
      },
    },
    ip_channel_master: {
      description: "Channel master (wholesale / ecom / retail / marketplace).",
      columns: {
        channel_code: { type: "text", filterable: true, groupable: true },
        channel_name: { type: "text", filterable: true, groupable: true },
        type:         { type: "text", filterable: true, groupable: true },
        active:       { type: "bool", filterable: true },
      },
    },
    ip_category_master: {
      description: "Category master (with parent_category_id for hierarchy).",
      columns: {
        category_code:      { type: "text", filterable: true, groupable: true },
        category_name:      { type: "text", filterable: true, groupable: true },
        parent_category_id: { type: "uuid", filterable: true },
        active:             { type: "bool", filterable: true },
      },
    },
  },
};

// ── Design Calendar (design pipeline + trend briefs) ──────────────────
const DESIGN_CALENDAR = {
  domain: "design_calendar",
  description: "Design lifecycle — AI-synthesized trend briefs, design concepts, color palettes, tech packs, and the design task calendar.",
  tables: {
    ip_trend_briefs: {
      description: "Monthly AI-synthesized trend brief.",
      columns: {
        brief_month:  { type: "date", filterable: true, date: true, groupable: true },
        status:       { type: "text", filterable: true, groupable: true },
        title:        { type: "text", filterable: true },
        model:        { type: "text", filterable: true, groupable: true },
        created_at:   { type: "date", filterable: true, date: true },
        updated_at:   { type: "date", filterable: true, date: true },
      },
    },
    ip_design_concepts: {
      description: "Design concepts derived from a trend brief.",
      columns: {
        trend_brief_id:        { type: "uuid", filterable: true, groupable: true },
        name:                  { type: "text", filterable: true },
        ai_fit_estimate:       { type: "numeric", aggregatable: true },
        ai_fit_estimate_label: { type: "text", filterable: true, groupable: true },
        status:                { type: "text", filterable: true, groupable: true },
        model:                 { type: "text", filterable: true, groupable: true },
        created_at:            { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    ip_design_palettes: {
      description: "Color palettes per concept.",
      columns: {
        concept_id: { type: "uuid", filterable: true, groupable: true },
        name:       { type: "text", filterable: true },
        model:      { type: "text", filterable: true, groupable: true },
        created_at: { type: "date", filterable: true, date: true },
      },
    },
    tech_packs: {
      description: "Tech pack drafts (AI-drafted; status moves to human_approved before production use).",
      columns: {
        concept_id:         { type: "uuid", filterable: true, groupable: true },
        version:            { type: "int", filterable: true, aggregatable: true },
        status:             { type: "text", filterable: true, groupable: true },
        shipped_sku_id:     { type: "uuid", filterable: true, groupable: true },
        model:              { type: "text", filterable: true, groupable: true },
        human_approved_at:  { type: "date", filterable: true, date: true },
        created_at:         { type: "date", filterable: true, date: true, groupable: true },
      },
    },
    ip_ai_call_log: {
      description: "Every AI call (handler + model + token usage + cost).",
      columns: {
        handler_name:  { type: "text", filterable: true, groupable: true },
        model:         { type: "text", filterable: true, groupable: true },
        input_tokens:  { type: "int", aggregatable: true },
        output_tokens: { type: "int", aggregatable: true },
        cost_usd:      { type: "numeric", aggregatable: true },
        related_table: { type: "text", filterable: true, groupable: true },
        called_at:     { type: "date", filterable: true, date: true, groupable: true },
        error:         { type: "text", filterable: true },
      },
    },
  },
};

export const DOMAINS = {
  po_wip:          PO_WIP,
  vendor_portal:   VENDOR_PORTAL,
  planning:        PLANNING,
  design_calendar: DESIGN_CALENDAR,
};

export const ALLOWED_FILTER_OPS = {
  text:    STRING_OPS,
  "text[]": STRING_OPS,
  uuid:    STRING_OPS,
  int:     NUMBER_OPS,
  numeric: NUMBER_OPS,
  date:    DATE_OPS,
  bool:    ["eq", "neq", "is_null", "not_is_null"],
};

export const ALLOWED_AGGS = ["sum", "count", "avg", "min", "max"];

// Return the full table descriptor for a (domain, table) pair, or null
// if either is unknown or the table isn't in the registry (i.e. not
// AI-readable). The executor uses this as a gate before issuing any
// PostgREST call.
export function lookupTable(domainName, tableName) {
  const domain = DOMAINS[domainName];
  if (!domain) return null;
  const table = domain.tables[tableName];
  if (!table) return null;
  return { domain, table, tableName, domainName };
}

// Same but only by table name — slower (linear scan over 4 domains) but
// convenient for clients that only know the table.
export function findTable(tableName) {
  for (const [domainName, domain] of Object.entries(DOMAINS)) {
    if (domain.tables[tableName]) {
      return { domain, table: domain.tables[tableName], tableName, domainName };
    }
  }
  return null;
}

// Returns ALL columns visible to the AI for a given table (PII stripped).
export function publicColumns(table) {
  const out = {};
  for (const [name, meta] of Object.entries(table.columns)) {
    if (meta?.pii) continue;
    out[name] = meta;
  }
  return out;
}
