// Shape returned by GET /api/b2b/session — the server-trusted identity the
// portal shell renders. customer_id is resolved server-side from b2b_accounts;
// it is never supplied by the client.
export interface B2BSession {
  b2b_account_id: string;
  customer_id: string;
  customer_name: string | null;
  display_name: string | null;
  role: "buyer" | "approver" | "admin" | string;
  can_place_orders: boolean;
}

// GET /api/b2b/catalog — one catalog style with its resolved wholesale price.
export interface CatalogItem {
  style_id: string;
  style_code: string;
  style_name: string | null;
  description: string | null;
  brand_id: string | null;
  brand_name: string | null;
  gender_code: string | null;
  gender_label: string | null;
  group_name: string | null;
  category_name: string | null;
  sub_category_name: string | null;
  price_cents: number | null;   // null = "Call for price"
  currency: string | null;
  min_qty: number | null;
  image_url?: string | null;    // primary product image (when available); null → placeholder
}

// Client-side cart line (persisted in localStorage). Price is shown for the
// buyer's convenience but is ALWAYS re-resolved server-side on submit.
export interface CartLine {
  style_id: string;
  style_code: string;
  style_name: string | null;
  qty: number;
  price_cents: number;
  currency: string;
}

// GET /api/b2b/orders — one order summary row.
export interface OrderSummary {
  id: string;
  so_number: string | null;
  status: string;
  origin: string;
  order_date: string | null;
  requested_ship_date: string | null;
  currency: string;
  subtotal_cents: number;
  total_cents: number;
  notes: string | null;
  created_at: string;
  ship_to_location_id: string | null;
}

export interface OrderLine {
  id: string;
  line_number: number;
  description: string | null;
  style_id: string | null;   // parsed from the line's [sid:…] tag (portal orders)
  qty_ordered: number;
  unit_price_cents: number;
  line_total_cents: number;
  status: string;
}

// GET /api/b2b/orders/:id
export interface OrderDetail extends OrderSummary {
  lines: OrderLine[];
}

// GET /api/b2b/account
export interface AccountInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  gl_status: string;
  total_amount_cents: number;
  paid_amount_cents: number;
  balance_cents: number;
}

export interface ShipToLocation {
  id: string;
  name: string;
  code: string | null;
  is_default: boolean;
}

export interface AccountView {
  customer: { id: string; name: string | null };
  open_balance_cents: number;
  currency: string;
  invoices: AccountInvoice[];
  locations: ShipToLocation[];
}
