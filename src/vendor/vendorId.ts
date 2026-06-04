// Resolve the logged-in vendor's vendor_id for explicit query scoping.
//
// SECURITY: the vendor portal must NOT rely on RLS to scope reads to a single
// vendor. The browser uses the shared anon key and the current RLS policies are
// permissive (per-tenant isolation is deferred), so a naked
// `supabaseVendor.from("tanda_pos").select(...)` returns EVERY vendor's rows.
// Every vendor-facing list/detail query must add `.eq("vendor_id", <id>)`
// using the value resolved here.

import { supabaseVendor } from "./supabaseVendor";

// Cache keyed by auth user id so switching accounts (or logout→login) never
// reuses a stale vendor_id.
let cache: { uid: string; vendorId: string | null } | null = null;

export async function resolveVendorId(): Promise<string | null> {
  const { data: userRes } = await supabaseVendor.auth.getUser();
  const uid = userRes.user?.id;
  if (!uid) { cache = null; return null; }
  if (cache && cache.uid === uid) return cache.vendorId;

  const { data: vu } = await supabaseVendor
    .from("vendor_users")
    .select("vendor_id")
    .eq("auth_id", uid)
    .maybeSingle();
  const vendorId = (vu?.vendor_id as string | undefined) ?? null;
  cache = { uid, vendorId };
  return vendorId;
}
