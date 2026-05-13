#!/usr/bin/env node
// Scrapes celebpink.com (a Shopify storefront) via the public /products.json
// endpoint. Output: scripts/demo-data/celebpink-products.json — a normalized
// JSON file consumed by scripts/seed-demo-celebpink.mjs to populate the demo
// Supabase project.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const LIMIT = Number(arg("limit-per-page", 50));
const MAX_PAGES = Number(arg("max-pages", 50));
const DELAY_MS = Number(arg("delay-ms", 1500));
const OUT = resolve(ROOT, arg("out", "scripts/demo-data/celebpink-products.json"));

const BASE = "https://www.celebpink.com";
const UA = "DesignCalendarDemoSeeder/1.0 (one-time scrape for internal demo seeding)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeProduct(p) {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: Array.isArray(p.tags) ? p.tags : (typeof p.tags === "string" ? p.tags.split(",").map(s => s.trim()) : []),
    published_at: p.published_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    options: (p.options || []).map(o => ({ name: o.name, values: o.values })),
    variants: (p.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || null,
      title: v.title,
      option1: v.option1,
      option2: v.option2,
      option3: v.option3,
      price: v.price,
      compare_at_price: v.compare_at_price,
      available: v.available,
      grams: v.grams,
      position: v.position,
    })),
    images: (p.images || []).map(img => ({
      id: img.id,
      src: img.src,
      width: img.width,
      height: img.height,
      position: img.position,
      variant_ids: img.variant_ids || [],
    })),
    body_html_length: typeof p.body_html === "string" ? p.body_html.length : 0,
  };
}

async function fetchPage(page) {
  const url = `${BASE}/products.json?limit=${LIMIT}&page=${page}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on page ${page}: ${await r.text()}`);
  const body = await r.json();
  if (!body || !Array.isArray(body.products)) throw new Error(`Unexpected shape on page ${page}`);
  return body.products;
}

async function main() {
  console.log(`Scraping ${BASE}/products.json — limit=${LIMIT}, max-pages=${MAX_PAGES}, delay=${DELAY_MS}ms`);
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchPage(page);
    if (products.length === 0) {
      console.log(`  page ${page}: empty — done.`);
      break;
    }
    const normalized = products.map(normalizeProduct);
    all.push(...normalized);
    console.log(`  page ${page}: +${products.length} (total ${all.length})`);
    if (products.length < LIMIT) {
      console.log(`  page ${page}: short page (last) — done.`);
      break;
    }
    if (page < MAX_PAGES) await sleep(DELAY_MS);
  }

  const outDir = dirname(OUT);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const out = {
    source: BASE,
    scraped_at: new Date().toISOString(),
    count: all.length,
    products: all,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2), "utf-8");

  const totalVariants = all.reduce((n, p) => n + p.variants.length, 0);
  const totalImages = all.reduce((n, p) => n + p.images.length, 0);
  const types = [...new Set(all.map(p => p.product_type).filter(Boolean))];

  console.log(`\n✓ Wrote ${OUT}`);
  console.log(`  products: ${all.length}`);
  console.log(`  variants: ${totalVariants}`);
  console.log(`  images:   ${totalImages}`);
  console.log(`  product_types (${types.length}): ${types.slice(0, 20).join(", ")}${types.length > 20 ? ", …" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
