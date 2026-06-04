import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SB_URL, SB_KEY } from "../utils/supabase";

// Dedicated Supabase browser client for the B2B customer portal. Uses ONLY the
// public anon key (never the service-role key) + the buyer's own passwordless
// Supabase Auth session. A distinct storageKey keeps a logged-in buyer's session
// isolated from the internal-app and vendor-portal sessions so they can coexist
// across tabs of the same origin without clobbering each other.
//
// detectSessionInUrl:true is what completes the magic-link round trip — when the
// buyer returns to /b2b via the emailed link, supabase-js reads the token from
// the URL hash and establishes the session, then fires onAuthStateChange.
export const supabaseB2B: SupabaseClient = (SB_URL && SB_KEY)
  ? createClient(SB_URL, SB_KEY, {
      auth: {
        storageKey: "sb-b2b-auth",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : (null as unknown as SupabaseClient);
