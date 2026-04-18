import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SB_URL, SB_KEY } from "../utils/supabase";

// Dedicated Supabase client for the vendor portal. Uses the same anon key as
// the internal apps, but keeps its auth session under a separate storage key so
// a logged-in vendor never collides with internal-app session state running in
// another tab of the same origin.
export const supabaseVendor: SupabaseClient = (SB_URL && SB_KEY)
  ? createClient(SB_URL, SB_KEY, {
      auth: {
        storageKey: "sb-vendor-auth",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : (null as unknown as SupabaseClient);
