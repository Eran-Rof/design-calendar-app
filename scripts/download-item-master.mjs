// One-off downloader for the ip_item_master table. Pulls every active
// row from Supabase and writes an .xlsx file in the same column shape
// that ingestItemMasterExcel accepts, so the planner can edit and
// re-upload without manual remapping.
//
// Usage:  node scripts/download-item-master.mjs [--all] [--out path.xlsx]
//
//   --all         include inactive rows too (default: active only)
//   --out PATH    write to PATH (default: ./item-master-<date>.xlsx)
//
// Reads SUPABASE_URL / SUPABASE_ANON_KEY from .env.local — no other
// dependencies beyond the repo's existing xlsx package.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as XLSX from "xlsx";

const ENV_PATH = resolve(process.cwd(), ".env.local");
const PAGE_SIZE = 1000;

async function loadEnv() {
  const raw = await readFile(ENV_PATH, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  // Prefer the anon key — the service role key in .env.local can become
  // stale after a project key rotation, while the anon key is what the
  // app itself uses.
  const key = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE URL / KEY in .env.local");
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function fetchPage(url, key, offset, limit, includeInactive) {
  const filter = includeInactive ? "" : "&active=eq.true";
  const u = `${url}/rest/v1/ip_item_master?select=sku_code,style_code,color,size,description,unit_cost,attributes,active${filter}&order=sku_code.asc&offset=${offset}&limit=${limit}`;
  const r = await fetch(u, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

function rowToExcel(r) {
  const attrs = r.attributes || {};
  return {
    SKU: r.sku_code,
    Style: r.style_code ?? "",
    Color: r.color ?? "",
    Size: r.size ?? "",
    Description: r.description ?? "",
    "Avg Cost": r.unit_cost ?? "",
    "Product Category": attrs.product_category ?? "",
    "Group Name": attrs.group_name ?? "",
    "Category Name": attrs.category_name ?? "",
    Gender: attrs.gender ?? "",
    Active: r.active === false ? "FALSE" : "TRUE",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const includeInactive = args.includes("--all");
  const outIdx = args.indexOf("--out");
  const today = new Date().toISOString().slice(0, 10);
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]
    : `item-master-${today}.xlsx`;

  const { url, key } = await loadEnv();
  process.stdout.write(`Connecting to ${url}…\n`);

  const all = [];
  let offset = 0;
  while (true) {
    const page = await fetchPage(url, key, offset, PAGE_SIZE, includeInactive);
    all.push(...page);
    process.stdout.write(`  fetched ${all.length.toLocaleString()} rows so far\n`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const colorless = all.filter((r) => !r.color || !String(r.color).trim()).length;
  process.stdout.write(`Total: ${all.length.toLocaleString()} rows · ${colorless.toLocaleString()} with no Color set\n`);

  const sheet = XLSX.utils.json_to_sheet(all.map(rowToExcel));
  // Set column widths so the file opens nicely in Excel.
  sheet["!cols"] = [
    { wch: 28 }, { wch: 16 }, { wch: 22 }, { wch: 10 }, { wch: 40 },
    { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 8 }, { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "ItemMaster");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await writeFile(outPath, buf);
  process.stdout.write(`Wrote ${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(1);
});
