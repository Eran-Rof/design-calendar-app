// Server-side mirror of the post-parse pipeline that runs in the browser
// when a user uploads files through the ATS modal. Used by
// api/_handlers/ats/upload.js so the curl-driven flow ends with the same
// Supabase state the modal would have produced.
//
// Mirrors:
//   src/ats/helpers.ts                 → normalizeSku, xoroSkuToExcel
//   src/ats/normalize.ts               → detectNormChanges, partition, apply
//   src/ats/merge.ts                   → dedupeExcelData, mergeExcelDataSkus
//   src/ats/hooks/usePOWIPSync.ts      → applyPOWIPDataToExcel
//   src/utils/tandaTypes.ts            → isLineClosed
//
// Keep these in sync if the client logic changes. The shapes flowing through
// here are intentionally identical so the persisted blob is interchangeable.

// ── SKU normalization ────────────────────────────────────────────────────────

export function normalizeSku(sku) {
  let s = String(sku ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*-\s*/g, " - ");
  const firstDash = s.indexOf(" - ");
  if (firstDash >= 0) {
    const base = s.slice(0, firstDash);
    let rest = s.slice(firstDash + 3);
    rest = rest.replace(/\bmd\b/gi, "Med")
               .replace(/\blt\b/gi, "Lt")
               .replace(/\bdk\b/gi, "Dk");
    const titleCased = rest.replace(/\b\w+/g, (word) => {
      const lower = word.toLowerCase();
      const smallWords = new Set(["w", "of"]);
      if (smallWords.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    s = base + " - " + titleCased;
  }
  return s;
}

export function xoroSkuToExcel(rawSku) {
  const parts = String(rawSku ?? "").split("-");
  if (parts.length < 2) return rawSku;
  const sizeIdx = parts.slice(1).findIndex(p => p.includes("("));
  if (sizeIdx !== -1) {
    const colorParts = parts.slice(1, sizeIdx + 1);
    return colorParts.length > 0 ? parts[0] + " - " + colorParts.join(" - ") : parts[0];
  }
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  return parts[0] + " - " + parts[1];
}

// ── Normalization decisions ──────────────────────────────────────────────────

export function detectNormChanges(data) {
  const map = {};
  const add = (orig, source) => {
    const norm = normalizeSku(orig);
    if (norm === orig) return;
    if (!map[orig]) map[orig] = { original: orig, normalized: norm, sources: [], accepted: true };
    if (!map[orig].sources.includes(source)) map[orig].sources.push(source);
  };
  data.skus.forEach(s => add(s.sku, "inventory"));
  data.pos.forEach(p => add(p.sku, "purchases"));
  data.sos.forEach(s => add(s.sku, "orders"));
  return Object.values(map).sort((a, b) => a.original.localeCompare(b.original));
}

export function partitionNormChanges(changes, decisions) {
  const known = [];
  const unknown = [];
  for (const c of changes) {
    const d = decisions[c.original];
    if (d === "accept") known.push({ ...c, accepted: true });
    else if (d === "reject") known.push({ ...c, accepted: false });
    else unknown.push(c);
  }
  return { known, unknown };
}

export function applyNormChanges(data, changes) {
  const acceptedMap = {};
  for (const c of changes) {
    if (c.accepted) acceptedMap[c.original] = c.normalized;
  }
  const apply = (sku) => acceptedMap[sku] ?? sku;
  return {
    ...data,
    skus: data.skus.map(s => ({ ...s, sku: apply(s.sku) })),
    pos:  data.pos.map(p => ({ ...p, sku: apply(p.sku) })),
    sos:  data.sos.map(s => ({ ...s, sku: apply(s.sku) })),
  };
}

// ── Dedupe + merge ───────────────────────────────────────────────────────────

function dedupeSkuEntries(skus) {
  const out = [];
  const seen = new Map();
  for (const s of skus) {
    const key = `${s.sku}::${s.store ?? "ROF"}`;
    const idx = seen.get(key);
    if (idx === undefined) {
      seen.set(key, out.length);
      out.push({ ...s });
      continue;
    }
    const prev = out[idx];
    const totalOnHand = (prev.onHand || 0) + (s.onHand || 0);
    const anyCost = prev.avgCost != null || s.avgCost != null;
    const costSum =
      (prev.avgCost ?? 0) * (prev.onHand || 0) +
      (s.avgCost   ?? 0) * (s.onHand   || 0);
    out[idx] = {
      ...prev,
      onHand:      totalOnHand,
      onPO:        (prev.onPO     || 0) + (s.onPO     || 0),
      onOrder:     (prev.onOrder || 0) + (s.onOrder || 0),
      totalAmount: (prev.totalAmount || 0) + (s.totalAmount || 0),
      avgCost: anyCost && totalOnHand > 0 ? costSum / totalOnHand : (prev.avgCost ?? s.avgCost ?? undefined),
    };
  }
  return out;
}

export function dedupeExcelData(data) {
  const skus = dedupeSkuEntries(data.skus);
  if (skus.length === data.skus.length) return data;
  return { ...data, skus };
}

export function mergeExcelDataSkus(data, fromSku, toSku) {
  if (fromSku === toSku) return data;
  const pos = (data.pos || []).map(p => p.sku === fromSku ? { ...p, sku: toSku } : p);
  const sos = (data.sos || []).map(s => s.sku === fromSku ? { ...s, sku: toSku } : s);

  const fromEntries = data.skus.filter(s => s.sku === fromSku);
  const toEntries   = data.skus.filter(s => s.sku === toSku);
  const others      = data.skus.filter(s => s.sku !== fromSku && s.sku !== toSku);

  if (fromEntries.length === 0 && toEntries.length === 0) {
    return { ...data, skus: others, pos, sos };
  }

  const all = [...toEntries, ...fromEntries];
  const base = toEntries[0] ?? fromEntries[0];
  const totalOnHand = all.reduce((a, s) => a + (s.onHand || 0), 0);
  const costSum = all.reduce((a, s) => a + ((s.avgCost ?? 0) * (s.onHand || 0)), 0);
  const anyCost = all.some(s => s.avgCost != null);
  const merged = {
    ...base,
    sku:         toSku,
    onHand:      totalOnHand,
    onPO:        all.reduce((a, s) => a + (s.onPO     || 0), 0),
    onOrder:     all.reduce((a, s) => a + (s.onOrder || 0), 0),
    totalAmount: all.reduce((a, s) => a + (s.totalAmount || 0), 0),
    avgCost: anyCost && totalOnHand > 0 ? costSum / totalOnHand : (base.avgCost ?? undefined),
  };

  return { ...data, skus: [...others, merged], pos, sos };
}

// ── PO WIP fold (mirror of applyPOWIPDataToExcel in usePOWIPSync.ts) ─────────

function isLineClosed(item) {
  const s = String(item?.StatusName ?? item?.Status ?? "").toLowerCase();
  return s === "closed" || s === "cancelled" || s === "canceled";
}

function inferPoStore(poNum, brandName) {
  const pn = String(poNum || "").toUpperCase();
  const bn = String(brandName || "").toUpperCase();
  if (pn.includes("ECOM")) return "ROF ECOM";
  if (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) return "PT";
  return "ROF";
}

export async function applyPOWIPData(data, sbUrl, sbKey) {
  const res = await fetch(`${sbUrl}/rest/v1/tanda_pos?select=data`, {
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`tanda_pos fetch failed: ${res.status} ${res.statusText}`);
  }
  const rows = await res.json();

  const nextSkus = data.skus.map(s => ({ ...s }));
  const nextPos  = [...data.pos];
  const keyOf = (sku, store) => `${sku}::${store || "ROF"}`;
  const skuIndex = new Map();
  nextSkus.forEach((s, i) => skuIndex.set(keyOf(s.sku, s.store ?? "ROF"), i));

  for (const row of rows) {
    const po = row.data;
    if (!po || po._archived) continue;
    const poNum = po.PoNumber ?? "";
    const vendor = po.VendorName ?? "";
    const expDate = po.DateExpectedDelivery ?? "";
    const brandName = po.BrandName ?? "";
    const items = po.Items ?? po.PoLineArr ?? [];
    for (const item of items) {
      const rawItemSku = item.ItemNumber ?? "";
      if (!rawItemSku) continue;
      if (isLineClosed(item)) continue;
      const sku = normalizeSku(xoroSkuToExcel(rawItemSku));
      const qty = item.QtyRemaining != null
        ? item.QtyRemaining
        : (item.QtyOrder ?? 0) - (item.QtyReceived ?? 0);
      const unitCost = item.UnitPrice ?? 0;
      if (qty <= 0) continue;
      let date = "";
      if (expDate) {
        const d = new Date(expDate);
        if (!isNaN(d.getTime())) date = d.toISOString().split("T")[0];
      }
      const store = inferPoStore(poNum, brandName);
      const itemDesc = item.Description ?? item.ItemDescription ?? item.ProductName ?? item.ItemName ?? "";

      const key = keyOf(sku, store);
      const existingIdx = skuIndex.get(key);
      if (existingIdx === undefined) {
        skuIndex.set(key, nextSkus.length);
        nextSkus.push({
          sku,
          description: itemDesc,
          category: brandName || undefined,
          store,
          onHand: 0,
          onPO: qty,
          onOrder: 0,
        });
      } else {
        const prev = nextSkus[existingIdx];
        const nextDesc = prev.description || itemDesc;
        nextSkus[existingIdx] = { ...prev, onPO: (prev.onPO || 0) + qty, description: nextDesc };
      }
      if (date) nextPos.push({ sku, date, qty, poNumber: poNum, vendor, store, unitCost });
    }
  }

  return { ...data, skus: nextSkus, pos: nextPos };
}

// ── Supabase persistence helpers ─────────────────────────────────────────────

function sbHeaders(sbKey, prefer) {
  return {
    apikey: sbKey,
    Authorization: `Bearer ${sbKey}`,
    "Content-Type": "application/json",
    Prefer: prefer || "return=representation",
  };
}

async function loadAppDataValue(sbUrl, sbKey, key) {
  const res = await fetch(`${sbUrl}/rest/v1/app_data?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: sbHeaders(sbKey),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows[0]?.value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

async function saveAppDataValue(sbUrl, sbKey, key, value) {
  const res = await fetch(`${sbUrl}/rest/v1/app_data`, {
    method: "POST",
    headers: sbHeaders(sbKey, "resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`app_data write '${key}' failed: ${res.status} ${detail}`);
  }
}

export async function loadNormDecisions(sbUrl, sbKey) {
  const v = await loadAppDataValue(sbUrl, sbKey, "ats_norm_decisions");
  return (v && typeof v === "object") ? v : {};
}

export async function loadMergeHistory(sbUrl, sbKey) {
  const v = await loadAppDataValue(sbUrl, sbKey, "ats_merge_history");
  return Array.isArray(v) ? v : [];
}

export async function saveExcelData(sbUrl, sbKey, data) {
  await saveAppDataValue(sbUrl, sbKey, "ats_excel_data", data);
}

export async function saveBaseData(sbUrl, sbKey, data) {
  await saveAppDataValue(sbUrl, sbKey, "ats_base_data", data);
}
