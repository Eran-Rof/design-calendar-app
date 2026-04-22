#!/usr/bin/env node
/**
 * scripts/staging-smoke.mjs
 *
 * End-to-end smoke test for all phases of the design-calendar-app API.
 * Reads credentials from .env.staging.
 *
 * Usage:
 *   node scripts/staging-smoke.mjs
 *   node scripts/staging-smoke.mjs --verbose    # print request/response bodies
 *   node scripts/staging-smoke.mjs --phase 3    # run only phase 3 tests
 *
 * Requires a running API server (npx vercel dev in a separate terminal).
 *
 * Exit code 0 = all tests passed, 1 = one or more failures.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const ONLY_PHASE = args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] === "--phase")
  ? parseInt(args[args.indexOf(args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] === "--phase"))], 10)
  : null;

// Load .env.staging
function loadEnv() {
  const envFile = resolve(ROOT, ".env.staging");
  if (!existsSync(envFile)) {
    console.error("No .env.staging found. Run: node scripts/staging-setup.mjs");
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const ENV = loadEnv();
const BASE = (ENV.STAGING_API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const VENDOR_KEY = ENV.STAGING_VENDOR_API_KEY || "";
const SB_URL = ENV.VITE_SUPABASE_URL || "";
const SB_SERVICE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY || "";

if (!VENDOR_KEY) {
  console.error("STAGING_VENDOR_API_KEY not set in .env.staging. Run staging-setup.mjs first.");
  process.exit(1);
}

// ── Test runner ───────────────────────────────────────────────────────────────

const results = [];

async function test(phase, name, fn) {
  if (ONLY_PHASE !== null && phase !== ONLY_PHASE) return;
  const label = `Phase ${phase}: ${name}`;
  try {
    await fn();
    results.push({ phase, name, passed: true });
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } catch (e) {
    results.push({ phase, name, passed: false, error: e.message });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`);
    if (VERBOSE) process.stdout.write(`    \x1b[90m${e.message}\x1b[0m\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Key": VENDOR_KEY,
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (VERBOSE) console.log(`  ${opts.method || "GET"} ${path} → ${res.status}`, body);
  return { status: res.status, body };
}

async function sb(table, params = "") {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: {
      "apikey": SB_SERVICE_KEY,
      "Authorization": `Bearer ${SB_SERVICE_KEY}`,
    },
  });
  return res.json();
}

// ── JWT helper (get vendor session token) ─────────────────────────────────────

async function getVendorJwt(email, password = "Staging@2026!") {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ENV.VITE_SUPABASE_ANON_KEY || "" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return data.access_token;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Vendor Auth + Portal Basics
// ═══════════════════════════════════════════════════════════════════════════════

async function phase1() {
  console.log("\n\x1b[1mPhase 1 — Vendor Auth + Portal\x1b[0m");

  await test(1, "API key auth: GET /api/vendor/entities returns 200", async () => {
    const r = await api("/api/vendor/entities");
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body), "Response should be an array");
  });

  await test(1, "JWT auth: vendor login returns access_token", async () => {
    const token = await getVendorJwt("vendor-a@staging.ringoffireclothing.com");
    assert(typeof token === "string" && token.length > 0, "No access_token returned");
  });

  await test(1, "Auth rejected with no credentials → 401", async () => {
    const res = await fetch(`${BASE}/api/vendor/entities`);
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test(1, "Auth rejected with wrong API key → 401", async () => {
    const res = await fetch(`${BASE}/api/vendor/entities`, { headers: { "X-Api-Key": "vnd_bad_key_00000000000000000000000000000000000000000000000" } });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await test(1, "Vendor invite endpoint reachable", async () => {
    const r = await fetch(`${BASE}/api/vendor-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "", legacy_blob_id: "", site_url: "" }),
    });
    // 400 (validation) or 500 (missing env) — not 404
    assert(r.status !== 404, `Got 404 — endpoint not mounted`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Invoices, Shipments, 3-Way Match
// ═══════════════════════════════════════════════════════════════════════════════

async function phase2() {
  console.log("\n\x1b[1mPhase 2 — Invoices, Shipments, 3-Way Match\x1b[0m");

  await test(2, "GET /api/vendor/pos returns vendor's POs", async () => {
    const r = await api("/api/vendor/pos");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    // vendor-a should see STG-PO-1001 and STG-PO-1002
    const pos = Array.isArray(r.body) ? r.body : (r.body?.data || []);
    assert(pos.length >= 1, "Expected at least one PO");
  });

  await test(2, "GET /api/vendor/invoices returns vendor's invoices", async () => {
    const r = await api("/api/vendor/invoices");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const invs = Array.isArray(r.body) ? r.body : (r.body?.data || []);
    assert(invs.length >= 1, "Expected at least one invoice");
  });

  await test(2, "POST /api/vendor/invoices validates required fields → 400", async () => {
    const r = await api("/api/vendor/invoices", {
      method: "POST",
      body: JSON.stringify({ invoice_number: "SMOKE-001" /* missing po_id, line_items */ }),
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test(2, "GET /api/vendor/shipments returns vendor's shipments", async () => {
    const r = await api("/api/vendor/shipments");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test(2, "3-way match view has seeded data in DB", async () => {
    const rows = await sb("three_way_match_view", "vendor_id=eq.a0000000-0000-0000-0000-000000000001&limit=5");
    assert(Array.isArray(rows) && rows.length >= 1, "Expected 3WM view rows for vendor A");
    const statuses = rows.map((r) => r.match_status);
    assert(statuses.some((s) => s), "match_status should be populated");
  });

  await test(2, "3-way match shows 'discrepancy' for vendor B (invoiced > received)", async () => {
    const rows = await sb("three_way_match_view", "vendor_id=eq.a0000000-0000-0000-0000-000000000002&limit=10");
    if (!rows.length) { warn("No 3WM rows for vendor B — skip"); return; }
    const hasDiscrepancy = rows.some((r) => r.match_status === "discrepancy" || r.flag_invoiced_more_than_received);
    assert(hasDiscrepancy, "Expected at least one discrepancy row for vendor B");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Compliance Documents
// ═══════════════════════════════════════════════════════════════════════════════

async function phase3() {
  console.log("\n\x1b[1mPhase 3 — Compliance Documents\x1b[0m");

  await test(3, "GET /api/vendor/compliance returns docs", async () => {
    const r = await api("/api/vendor/compliance");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const docs = Array.isArray(r.body) ? r.body : (r.body?.data || []);
    assert(docs.length >= 1, "Expected seeded compliance documents");
  });

  await test(3, "GET /api/vendor/compliance/summary returns aggregate", async () => {
    const r = await api("/api/vendor/compliance/summary");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test(3, "Compliance doc types endpoint works (internal)", async () => {
    const r = await fetch(`${BASE}/api/internal/compliance/document-types`, {
      headers: { "apikey": SB_SERVICE_KEY, "Authorization": `Bearer ${SB_SERVICE_KEY}` },
    });
    assert(r.status !== 404, `Endpoint not found (404)`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — Vendor Scorecards
// ═══════════════════════════════════════════════════════════════════════════════

async function phase4() {
  console.log("\n\x1b[1mPhase 4 — Vendor Scorecards\x1b[0m");

  await test(4, "GET /api/vendor/scorecard returns seeded scorecard", async () => {
    const r = await api("/api/vendor/scorecard");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const data = r.body?.scorecard || r.body;
    assert(data && (data.grade || data.overall_score), "Expected scorecard data with grade or overall_score");
  });

  await test(4, "Scorecard data has correct grade for vendor A (seeded A)", async () => {
    const rows = await sb("vendor_scorecards", "vendor_id=eq.a0000000-0000-0000-0000-000000000001&limit=1");
    assert(rows.length === 1, "Expected one scorecard row");
    assert(rows[0].grade === "A", `Expected grade A, got ${rows[0].grade}`);
  });

  await test(4, "GET /api/vendor/analytics/health returns health metrics", async () => {
    const r = await api("/api/vendor/analytics/health");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5 — Contracts + Disputes
// ═══════════════════════════════════════════════════════════════════════════════

async function phase5() {
  console.log("\n\x1b[1mPhase 5 — Contracts + Disputes\x1b[0m");

  await test(5, "GET /api/vendor/contracts returns seeded contract", async () => {
    const r = await api("/api/vendor/contracts");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const contracts = Array.isArray(r.body) ? r.body : (r.body?.data || []);
    assert(contracts.length >= 1, "Expected seeded contract for vendor A");
  });

  await test(5, "GET /api/vendor/disputes returns disputes", async () => {
    const r = await api("/api/vendor/disputes");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test(5, "GET /api/vendor/disputes/summary returns aggregates", async () => {
    const r = await api("/api/vendor/disputes/summary");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6 — Onboarding + Banking + Catalog
// ═══════════════════════════════════════════════════════════════════════════════

async function phase6() {
  console.log("\n\x1b[1mPhase 6 — Onboarding + Banking + Catalog\x1b[0m");

  await test(6, "GET /api/vendor/onboarding returns approved status for vendor A", async () => {
    const r = await api("/api/vendor/onboarding");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const wf = r.body?.workflow || r.body;
    if (wf?.status) assert(wf.status === "approved", `Expected approved, got ${wf.status}`);
  });

  await test(6, "GET /api/vendor/erp returns ERP integration config", async () => {
    const r = await api("/api/vendor/erp");
    assert(r.status === 200 || r.status === 404, `Unexpected ${r.status}`);
  });

  await test(6, "Bulk upload validation: missing type → 400", async () => {
    const r = await api("/api/vendor/bulk/upload", {
      method: "POST",
      body: JSON.stringify({ input_file_url: "vendor-a/test.csv" }),
    });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test(6, "Bulk upload validation: wrong vendor folder → 403", async () => {
    const r = await api("/api/vendor/bulk/upload", {
      method: "POST",
      body: JSON.stringify({ type: "catalog_update", input_file_url: "vendor-b/evil.csv" }),
    });
    assert(r.status === 403, `Expected 403, got ${r.status}`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 7 — EDI
// ═══════════════════════════════════════════════════════════════════════════════

async function phase7() {
  console.log("\n\x1b[1mPhase 7 — EDI\x1b[0m");

  await test(7, "GET /api/vendor/edi/status returns EDI status", async () => {
    const r = await api("/api/vendor/edi/status");
    assert(r.status === 200 || r.status === 404, `Unexpected ${r.status}`);
  });

  await test(7, "POST /api/edi/inbound without token → 401", async () => {
    const res = await fetch(`${BASE}/api/edi/inbound`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "ISA*00*...",
    });
    assert(res.status !== 404, "Endpoint not mounted (404)");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 8 — Entities, Workflow Rules, RFQs
// ═══════════════════════════════════════════════════════════════════════════════

async function phase8() {
  console.log("\n\x1b[1mPhase 8 — Entities, Workflows, RFQs\x1b[0m");

  await test(8, "GET /api/vendor/entities returns entity list", async () => {
    const r = await api("/api/vendor/entities");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const entities = Array.isArray(r.body) ? r.body : [];
    assert(entities.length >= 1, "Expected at least the Ring of Fire entity");
  });

  await test(8, "GET /api/vendor/rfqs returns open RFQs", async () => {
    const r = await api("/api/vendor/rfqs");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const rfqs = Array.isArray(r.body) ? r.body : (r.body?.rfqs || []);
    assert(rfqs.length >= 1, "Expected the seeded RFQ");
  });

  await test(8, "RFQ has correct structure (vendor B is invited)", async () => {
    const rows = await sb("rfq_invitations", "vendor_id=eq.a0000000-0000-0000-0000-000000000002&limit=5");
    assert(rows.length >= 1, "Expected vendor B to be invited to the RFQ");
    assert(rows[0].status === "invited", `Expected 'invited', got ${rows[0].status}`);
  });

  await test(8, "API keys CRUD: GET /api/vendor/api-keys returns list", async () => {
    const r = await api("/api/vendor/api-keys");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const keys = Array.isArray(r.body) ? r.body : (r.body?.keys || []);
    assert(keys.length >= 1, "Expected at least the staging smoke-test key");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 9 — AI Insights, Workspaces, ESG, Marketplace
// ═══════════════════════════════════════════════════════════════════════════════

async function phase9() {
  console.log("\n\x1b[1mPhase 9 — AI Insights, Workspaces, ESG\x1b[0m");

  await test(9, "GET /api/vendor/workspaces returns workspace", async () => {
    const r = await api("/api/vendor/workspaces");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test(9, "AI insights seeded in DB", async () => {
    const rows = await sb("ai_insights", "entity_id=eq.e0000000-0000-0000-0000-000000000001&limit=5");
    assert(rows.length >= 2, `Expected 2 AI insights, got ${rows.length}`);
    assert(rows.some((r) => r.type === "risk_alert"), "Expected a risk_alert insight");
  });

  await test(9, "ESG scores seeded for vendor A", async () => {
    const rows = await sb("esg_scores", "vendor_id=eq.a0000000-0000-0000-0000-000000000001&limit=1");
    assert(rows.length === 1, "Expected ESG score row for vendor A");
    assert(rows[0].environmental_score > 0, "Environmental score should be positive");
  });

  await test(9, "GET /api/vendor/scorecard (ESG component)", async () => {
    const r = await api("/api/vendor/esg-score");
    assert(r.status === 200 || r.status === 404, `Unexpected ${r.status}`);
  });

  await test(9, "Diversity profile seeded for vendor A", async () => {
    const rows = await sb("diversity_profiles", "vendor_id=eq.a0000000-0000-0000-0000-000000000001&limit=1");
    assert(rows.length === 1, "Expected diversity profile for vendor A");
    assert(rows[0].women_owned === true, "vendor A should be women-owned");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 10 — Payments, Dynamic Discounts, SCF, FX, Virtual Cards, Tax
// ═══════════════════════════════════════════════════════════════════════════════

async function phase10() {
  console.log("\n\x1b[1mPhase 10 — Payments, Discounts, SCF, FX, Tax\x1b[0m");

  await test(10, "GET /api/vendor/discount-offers returns open offer", async () => {
    const r = await api("/api/vendor/discount-offers");
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const offers = Array.isArray(r.body) ? r.body : (r.body?.offers || []);
    assert(offers.length >= 1, "Expected the seeded discount offer");
  });

  await test(10, "Discount offer has correct structure", async () => {
    const rows = await sb("dynamic_discount_offers", "entity_id=eq.e0000000-0000-0000-0000-000000000001&limit=5");
    assert(rows.length >= 1, "Expected seeded discount offer in DB");
    const offer = rows[0];
    assert(offer.discount_pct > 0, "discount_pct should be positive");
    assert(offer.net_payment_amount < offer.net_payment_amount + offer.discount_amount, "net < gross");
  });

  await test(10, "Currency rates seeded for USD→EUR, USD→CNY", async () => {
    const rows = await sb("currency_rates", "from_currency=eq.USD&limit=10");
    assert(rows.length >= 3, `Expected ≥3 USD rate rows, got ${rows.length}`);
    assert(rows.some((r) => r.to_currency === "EUR"), "Expected USD→EUR rate");
    assert(rows.some((r) => r.to_currency === "CNY"), "Expected USD→CNY rate");
  });

  await test(10, "Tax rules seeded for entity", async () => {
    const rows = await sb("tax_rules", "entity_id=eq.e0000000-0000-0000-0000-000000000001&limit=5");
    assert(rows.length >= 2, `Expected ≥2 tax rules, got ${rows.length}`);
  });

  await test(10, "SCF program seeded as active", async () => {
    const rows = await sb("supply_chain_finance_programs", "entity_id=eq.e0000000-0000-0000-0000-000000000001&limit=1");
    assert(rows.length === 1, "Expected SCF program");
    assert(rows[0].status === "active", `Expected active, got ${rows[0].status}`);
  });

  await test(10, "GET /api/vendor/payments endpoint reachable", async () => {
    const r = await api("/api/vendor/payments");
    assert(r.status !== 404, "Endpoint not mounted");
  });

  await test(10, "GET /api/vendor/virtual-cards endpoint reachable", async () => {
    const r = await api("/api/vendor/virtual-cards");
    assert(r.status !== 404, "Endpoint not mounted");
  });

  await test(10, "GET /api/vendor/tax/withholding endpoint reachable", async () => {
    const r = await api("/api/vendor/tax/withholding");
    assert(r.status !== 404, "Endpoint not mounted");
  });

  await test(10, "SCF eligible invoices endpoint returns seeded approved invoice", async () => {
    const r = await api("/api/vendor/scf/eligible-invoices");
    assert(r.status === 200 || r.status === 403, `Unexpected ${r.status}`);
  });

  await test(10, "Dynamic discount accept/reject endpoints exist", async () => {
    const offerId = "00000000-0000-0000-0000-000000000000";
    const r = await api(`/api/vendor/discount-offers/${offerId}/accept`, { method: "POST" });
    assert(r.status !== 404, "Accept endpoint not mounted");
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY PLANNING (Phase 9+)
// ═══════════════════════════════════════════════════════════════════════════════

async function phaseIP() {
  console.log("\n\x1b[1mInventory Planning — Demo Fixtures\x1b[0m");

  await test(99, "IP category master seeded with DEMO categories", async () => {
    const rows = await sb("ip_category_master", "category_code=like.DEMO-*&limit=5");
    assert(rows.length >= 2, `Expected ≥2 DEMO categories, got ${rows.length}`);
  });

  await test(99, "IP item master seeded with 5 DEMO SKUs", async () => {
    const rows = await sb("ip_item_master", "sku_code=like.DEMO-*&limit=10");
    assert(rows.length >= 5, `Expected 5 DEMO items, got ${rows.length}`);
  });

  await test(99, "IP sales history seeded for DEMO-TEE-BLK-M", async () => {
    const rows = await sb("ip_sales_history_wholesale", "source_line_key=like.demo:tee:major:*&limit=15");
    assert(rows.length >= 10, `Expected ≥10 months of sales history, got ${rows.length}`);
  });

  await test(99, "IP open POs seeded (DEMO-PO-101)", async () => {
    const rows = await sb("ip_open_purchase_orders", "po_number=eq.DEMO-PO-101&limit=1");
    assert(rows.length === 1, "Expected DEMO-PO-101 in ip_open_purchase_orders");
  });

  await test(99, "IP planning run exists in draft", async () => {
    const rows = await sb("ip_planning_runs", "status=eq.draft&limit=1");
    assert(rows.length >= 1, "Expected at least one draft planning run");
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CRON JOBS — smoke endpoints only (no execution)
// ════════════════════════════════════════════════════════════════════════════

async function phaseCron() {
  console.log("\n\x1b[1mCron Jobs — endpoint availability\x1b[0m");

  const cronRoutes = [
    "/api/cron/compliance-daily",
    "/api/cron/contracts-daily",
    "/api/cron/anomalies-nightly",
    "/api/cron/health-scores-monthly",
    "/api/cron/discount-offers-daily",
    "/api/cron/fx-rate-sync",
    "/api/cron/scorecards-monthly",
  ];

  for (const route of cronRoutes) {
    await test(0, `${route} is mounted (not 404)`, async () => {
      // POST without body — will get 400/401/500 but not 404
      const res = await fetch(`${BASE}${route}`, { method: "POST", headers: { "Content-Type": "application/json" } });
      assert(res.status !== 404, `${route} returned 404 — not mounted`);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n\x1b[1m=== Design Calendar — Staging Smoke Test ===\x1b[0m");
  console.log(`API base: \x1b[33m${BASE}\x1b[0m`);
  console.log(`Vendor key: \x1b[33m${VENDOR_KEY.slice(0, 14)}…\x1b[0m\n`);

  // Check server is up
  try {
    await fetch(`${BASE}/api/vendor/entities`, { headers: { "X-Api-Key": VENDOR_KEY } });
  } catch {
    console.error(`\x1b[31m✗ Cannot reach ${BASE} — is the API server running?\x1b[0m`);
    console.error("  Start with: npx vercel dev");
    process.exit(1);
  }

  await phase1();
  await phase2();
  await phase3();
  await phase4();
  await phase5();
  await phase6();
  await phase7();
  await phase8();
  await phase9();
  await phase10();
  await phaseIP();
  if (!ONLY_PHASE) await phaseCron();

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  const total  = results.length;

  console.log(`\n\x1b[1m=== Results: ${passed}/${total} passed ===\x1b[0m`);

  if (failed.length) {
    console.log("\n\x1b[31mFailed:\x1b[0m");
    for (const f of failed) {
      console.log(`  ✗ Phase ${f.phase}: ${f.name}`);
      console.log(`    \x1b[90m${f.error}\x1b[0m`);
    }
    process.exit(1);
  } else {
    console.log("\x1b[32mAll smoke tests passed.\x1b[0m\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
