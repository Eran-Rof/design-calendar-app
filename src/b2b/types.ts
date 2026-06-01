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
