// api/internal/global-search
//
// Always-visible top-bar universal search. Searches the WHOLE database across
// the major business entities with substring (ILIKE) matching and returns
// results grouped by entity for the <TopbarGlobalSearch> dropdown.
//
// GET /api/internal/global-search?q=<term>&limit=<perGroup>
//   → { q, groups: [ { key, label, items: [ { entity_type, code, label,
//         sublabel, nav: { module?, params?, href? } } ] } ], total }
//
// Distinct from /api/internal/search (the ⌘K full-text palette): this endpoint
// does cheap indexed substring ILIKE (backed by the pg_trgm GIN indexes in
// migration 20261300000000) so partial "any term" matches work, and returns a
// grouped shape with Tangerine navigation targets (?m=<module>&q=<code>, or a
// full href for entities that live in the PO WIP app).
//
// Auth: a Bearer JWT must be present (injected by installInternalApiAuth on the
// client) — 401 otherwise. The actual reads use the service-role client so the
// operator sees matches across every entity without per-table RLS SELECT grants
// (single-tenant internal ERP; the segment is intentionally RBAC-unmapped, like
// /api/internal/search and /api/internal/brands).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const Q_MIN = 2;
const Q_MAX = 100;
const PER_GROUP_DEFAULT = 6;
const PER_GROUP_MAX = 10;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function hasBearer(authHeader) {
  return typeof authHeader === "string" && authHeader.startsWith("Bearer ") && authHeader.slice(7).trim().length > 0;
}

// Strip characters that would break a PostgREST or()/ilike pattern
// (`,` separates or-terms, `()` group, `*`/`%` are wildcards, `\` escape).
export function sanitizeTerm(raw) {
  return String(raw == null ? "" : raw)
    .trim()
    .replace(/[,()*%\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build a PostgREST or() string: any of `columns` ILIKE %term% (wildcard is `*`
// inside an or() clause).
function orIlike(columns, term) {
  return columns.map((c) => `${c}.ilike.*${term}*`).join(",");
}

// First non-empty string among args (for choosing a display code / q-seed).
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function validate(params) {
  const qRaw = params.get("q");
  if (qRaw == null) return { error: "q is required" };
  const q = sanitizeTerm(qRaw);
  if (q.length < Q_MIN) return { error: `q must be at least ${Q_MIN} characters` };
  if (q.length > Q_MAX) return { error: `q must be at most ${Q_MAX} characters` };

  let limit = PER_GROUP_DEFAULT;
  const limitRaw = params.get("limit");
  if (limitRaw != null && limitRaw !== "") {
    const parsed = parseInt(limitRaw, 10);
    if (Number.isFinite(parsed)) limit = parsed;
  }
  limit = Math.min(Math.max(limit, 1), PER_GROUP_MAX);
  return { data: { q, limit } };
}

async function resolveEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}

// Group definitions. Each returns { key, label, items } and is run in parallel.
// `q` is the sanitized term, `limit` the per-group cap, `eid` the ROF entity id.
function buildGroupRunners(admin, q, limit, eid) {
  const scoped = (query, hasEntity) => (hasEntity && eid ? query.eq("entity_id", eid) : query);

  return [
    // Customers — code (CUST-NNNNN), Xoro customer_code, name.
    async () => {
      const { data } = await scoped(
        admin.from("customers").select("id, code, customer_code, name").or(orIlike(["code", "customer_code", "name"], q)).limit(limit),
        true,
      );
      return {
        key: "customers",
        label: "Customers",
        items: (data || []).map((r) => ({
          entity_type: "customer",
          code: firstNonEmpty(r.code, r.customer_code),
          label: r.name,
          sublabel: r.code && r.customer_code ? r.customer_code : null,
          nav: { module: "customer_master", params: { q: firstNonEmpty(r.code, r.name) || "" } },
        })),
      };
    },
    // Vendors — no entity scoping (single global table).
    async () => {
      const { data } = await admin
        .from("vendors").select("id, code, name, legal_name").or(orIlike(["code", "name", "legal_name"], q)).limit(limit);
      return {
        key: "vendors",
        label: "Vendors",
        items: (data || []).map((r) => ({
          entity_type: "vendor",
          code: r.code || null,
          label: firstNonEmpty(r.name, r.legal_name),
          sublabel: null,
          nav: { module: "vendor_master", params: { q: firstNonEmpty(r.code, r.name) || "" } },
        })),
      };
    },
    // Styles.
    async () => {
      const { data } = await scoped(
        admin.from("style_master").select("id, style_code, style_name, description").is("deleted_at", null).or(orIlike(["style_code", "style_name", "description"], q)).limit(limit),
        true,
      );
      return {
        key: "styles",
        label: "Styles",
        items: (data || []).map((r) => ({
          entity_type: "style",
          code: r.style_code || null,
          label: firstNonEmpty(r.style_name, r.description),
          sublabel: null,
          nav: { module: "style_master", params: { q: r.style_code || "" } },
        })),
      };
    },
    // Items / SKUs — route to the parent style (style_master filters on style_code).
    async () => {
      const { data } = await admin
        .from("ip_item_master").select("id, sku_code, style_code, description").or(orIlike(["sku_code", "style_code", "description"], q)).limit(limit);
      return {
        key: "skus",
        label: "Items / SKUs",
        items: (data || []).map((r) => ({
          entity_type: "sku",
          code: r.sku_code || null,
          label: firstNonEmpty(r.description, r.style_code),
          sublabel: r.style_code || null,
          nav: { module: "style_master", params: { q: r.style_code || "" } },
        })),
      };
    },
    // Sales orders.
    async () => {
      const { data } = await scoped(
        admin.from("sales_orders").select("id, so_number, status").not("so_number", "is", null).ilike("so_number", `%${q}%`).limit(limit),
        true,
      );
      return {
        key: "sales_orders",
        label: "Sales Orders",
        items: (data || []).map((r) => ({
          entity_type: "sales_order",
          code: r.so_number || null,
          label: r.status || null,
          sublabel: null,
          nav: { module: "sales_orders", params: { q: r.so_number || "" } },
        })),
      };
    },
    // Purchase orders — native + Xoro (tanda_pos) merged into one group.
    async () => {
      const [nativeRes, xoroRes] = await Promise.all([
        scoped(
          admin.from("purchase_orders").select("id, po_number, status").ilike("po_number", `%${q}%`).limit(limit),
          true,
        ),
        scoped(
          admin.from("tanda_pos").select("id, po_number, vendor").or(orIlike(["po_number", "vendor"], q)).limit(limit),
          true,
        ),
      ]);
      const items = [];
      for (const r of nativeRes.data || []) {
        items.push({
          entity_type: "po",
          code: r.po_number || null,
          label: r.status || "Purchase order",
          sublabel: "native",
          nav: { module: "purchase_orders", params: { q: r.po_number || "" } },
        });
      }
      for (const r of xoroRes.data || []) {
        items.push({
          entity_type: "po",
          code: r.po_number || null,
          label: r.vendor || "Purchase order",
          sublabel: "Xoro",
          nav: { href: `/tanda?po=${encodeURIComponent(r.po_number || "")}` },
        });
      }
      return { key: "purchase_orders", label: "Purchase Orders", items: items.slice(0, limit * 2) };
    },
    // AR invoices.
    async () => {
      const { data } = await scoped(
        admin.from("ar_invoices").select("id, invoice_number, description").or(orIlike(["invoice_number", "description"], q)).limit(limit),
        true,
      );
      return {
        key: "ar_invoices",
        label: "AR Invoices",
        items: (data || []).map((r) => ({
          entity_type: "ar_invoice",
          code: r.invoice_number || null,
          label: r.description || null,
          sublabel: null,
          nav: { module: "ar_invoices", params: { q: r.invoice_number || "" } },
        })),
      };
    },
    // AP bills (table `invoices`).
    async () => {
      const { data } = await scoped(
        admin.from("invoices").select("id, invoice_number, notes").or(orIlike(["invoice_number", "notes"], q)).limit(limit),
        true,
      );
      return {
        key: "ap_bills",
        label: "AP Bills",
        items: (data || []).map((r) => ({
          entity_type: "ap_invoice",
          code: r.invoice_number || null,
          label: r.notes || null,
          sublabel: null,
          nav: { module: "ap_invoices", params: { q: r.invoice_number || "" } },
        })),
      };
    },
    // Journal entries.
    async () => {
      const { data } = await scoped(
        admin.from("journal_entries").select("id, je_number, description").not("je_number", "is", null).or(orIlike(["je_number", "description"], q)).limit(limit),
        true,
      );
      return {
        key: "journal_entries",
        label: "Journal Entries",
        items: (data || []).map((r) => ({
          entity_type: "journal_entry",
          code: r.je_number || null,
          label: r.description || null,
          sublabel: null,
          nav: { module: "journal_entries", params: { q: r.je_number || "" } },
        })),
      };
    },
    // Parts.
    async () => {
      const { data } = await scoped(
        admin.from("part_master").select("id, code, name").or(orIlike(["code", "name"], q)).limit(limit),
        true,
      );
      return {
        key: "parts",
        label: "Parts",
        items: (data || []).map((r) => ({
          entity_type: "part",
          code: r.code || null,
          label: r.name || null,
          sublabel: null,
          nav: { module: "part_master", params: { q: r.code || "" } },
        })),
      };
    },
    // Services.
    async () => {
      const { data } = await scoped(
        admin.from("service_item_master").select("id, code, name").or(orIlike(["code", "name"], q)).limit(limit),
        true,
      );
      return {
        key: "services",
        label: "Services",
        items: (data || []).map((r) => ({
          entity_type: "service",
          code: r.code || null,
          label: r.name || null,
          sublabel: null,
          nav: { module: "service_item_master", params: { q: r.code || "" } },
        })),
      };
    },
    // Build orders (panel has no top-level q filter → land on the list).
    async () => {
      const { data } = await scoped(
        admin.from("mfg_build_orders").select("id, build_number, notes").or(orIlike(["build_number", "notes"], q)).limit(limit),
        true,
      );
      return {
        key: "build_orders",
        label: "Build Orders",
        items: (data || []).map((r) => ({
          entity_type: "build_order",
          code: r.build_number || null,
          label: r.notes || null,
          sublabel: null,
          nav: { module: "mfg_build_orders" },
        })),
      };
    },
    // Fabric codes.
    async () => {
      const { data } = await scoped(
        admin.from("fabric_codes").select("id, code, name, composition_text").or(orIlike(["code", "name", "composition_text"], q)).limit(limit),
        true,
      );
      return {
        key: "fabric_codes",
        label: "Fabric Codes",
        items: (data || []).map((r) => ({
          entity_type: "fabric",
          code: r.code || null,
          label: firstNonEmpty(r.name, r.composition_text),
          sublabel: null,
          nav: { module: "fabric_codes", params: { q: r.code || "" } },
        })),
      };
    },
    // Employees.
    async () => {
      const { data } = await scoped(
        admin.from("employees").select("id, code, display_name, email").or(orIlike(["code", "display_name", "email"], q)).limit(limit),
        true,
      );
      return {
        key: "employees",
        label: "Employees",
        items: (data || []).map((r) => ({
          entity_type: "employee",
          code: r.code || null,
          label: firstNonEmpty(r.display_name, r.email),
          sublabel: r.email && r.display_name ? r.email : null,
          nav: { module: "employees", params: { q: firstNonEmpty(r.code, r.display_name) || "" } },
        })),
      };
    },
  ];
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!hasBearer(req.headers && req.headers.authorization)) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validate(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });
  const { q, limit } = v.data;

  const eid = await resolveEntityId(admin);

  const runners = buildGroupRunners(admin, q, limit, eid);
  const settled = await Promise.allSettled(runners.map((fn) => fn()));

  const groups = [];
  let total = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value) continue;
    const g = s.value;
    if (g.items && g.items.length > 0) {
      groups.push(g);
      total += g.items.length;
    }
  }

  return res.status(200).json({ q, groups, total });
}
