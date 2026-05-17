// Tiny Supabase REST helper for the TechPack app. Wraps the three
// operations TechPack actually uses (select, upsert, delete) so the
// main component stops carrying the fetch boilerplate inline.
//
// Originally inline at the top of TechPack.tsx — keeping it focused
// here makes future panel splits (any of which need DB access) able
// to import the same wrapper without copy-pasting the fetch + header
// + error-shape pattern.

import { SB_URL, SB_HEADERS } from "../utils/supabase";

interface TableClient {
  /** GET ?select=cols (+ optional filter, e.g. "id=eq.123"). */
  select(cols?: string, filter?: string): Promise<{ data: any; error: any }>;
  /** POST + Prefer: resolution=merge-duplicates,return=representation. */
  upsert(rows: any): Promise<{ data: any; error: any }>;
  /** DELETE matching `filter` (e.g. "id=eq.123"). */
  delete(filter: string): Promise<{ error: any }>;
}

export const sb = {
  from(table: string): TableClient {
    return {
      async select(cols = "*", filter = "") {
        const res = await fetch(
          `${SB_URL}/rest/v1/${table}?select=${cols}${filter ? "&" + filter : ""}`,
          { headers: SB_HEADERS },
        );
        const data = await res.json();
        return { data, error: res.ok ? null : data };
      },
      async upsert(rows) {
        const body = Array.isArray(rows) ? rows : [rows];
        const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
          method: "POST",
          headers: {
            ...SB_HEADERS,
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return { data, error: res.ok ? null : data };
      },
      async delete(filter) {
        const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
          method: "DELETE",
          headers: SB_HEADERS,
        });
        return { error: res.ok ? null : await res.json() };
      },
    };
  },
};
