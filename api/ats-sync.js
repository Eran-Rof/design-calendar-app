// api/ats-sync.js — Vercel Serverless Function
// Fetches inventory + sales orders from Xoro and returns ExcelData-shaped JSON.
// Uses the ATS-specific API credentials (separate from PO WIP).
//
// Query params:
//   type=inventory  — fetch inventory with min_on_hand=1
//   type=salesorders — fetch open sales orders (QtyRemaining > 0)
//   type=full        — fetch both and return merged ExcelData blob
//   store=ROF Main   — optional store filter
//
// The function paginates internally (parallel batches of 10) and
// aggregates before returning, so the client gets one response.

export const config = { maxDuration: 60 };

const BASE = "https://res.xorosoft.io/api/xerp";

function getCredentials() {
  const key = (process.env.VITE_XORO_ATS_KEY || "").trim();
  const secret = (process.env.VITE_XORO_ATS_SECRET || "").trim();
  return { key, secret };
}

function authHeader() {
  const { key, secret } = getCredentials();
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

async function xoroGet(path, params = {}) {
  const p = new URLSearchParams(params);
  const url = `${BASE}/${path}?${p}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { Result: false, Message: "Non-JSON", raw: text.slice(0, 300) }; }
  } catch (e) {
    clearTimeout(t);
    return { Result: false, Message: e.name === "AbortError" ? "Xoro timeout (8s)" : e.message };
  }
}

async function fetchAllPages(path, baseParams, maxPages = 100) {
  // First page to get TotalPages
  const page1 = await xoroGet(path, { ...baseParams, page: "1" });
  if (!page1.Result || !Array.isArray(page1.Data)) return page1.Data || [];
  const totalPages = Math.min(page1.TotalPages || 1, maxPages);
  let allData = [...page1.Data];

  // Fetch remaining pages in parallel batches of 15 (Xoro rate-limits
  // if we fire all 80+ at once). 15 matches the proven xoro-proxy pattern.
  console.log(`[ats-sync] ${path}: ${totalPages} pages, fetching ${totalPages - 1} remaining`);
  const BATCH = 15;
  for (let batch = 2; batch <= totalPages; batch += BATCH) {
    const pageNums = [];
    for (let p = batch; p < batch + BATCH && p <= totalPages; p++) pageNums.push(p);
    const results = await Promise.allSettled(
      pageNums.map(p => xoroGet(path, { ...baseParams, page: String(p) }))
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.Result && Array.isArray(r.value.Data)) {
        allData.push(...r.value.Data);
      }
    }
  }
  return allData;
}

// ── SKU normalization (matches helpers.ts normalizeSku) ──
function normalizeSku(sku) {
  let s = sku.replace(/\s+/g, " ").trim();
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
      if (lower === "w" || lower === "of") return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    s = base + " - " + titleCased;
  }
  return s;
}

// ── Store name normalization (matches ATS.tsx / parse-excel.js logic) ──
function normalizeStore(storeName) {
  if (!storeName) return "ROF";
  const s = storeName.toUpperCase();
  if (s.includes("ECOM")) return "ROF ECOM";
  if (s.includes("PSYCHO") || s.includes("PTUNA") || s.includes("P TUNA") || s === "PT" || s.startsWith("PREBOOK")) return "PT";
  if (s.includes("ROF") || s.includes("RING")) return "ROF";
  return storeName;
}

// ── SKU normalization (matches xoroSkuToExcel in helpers.ts) ──
function xoroSkuToExcel(raw) {
  const parts = raw.split("-");
  if (parts.length >= 3) return parts[0] + " - " + parts.slice(1, -1).join(" - ");
  if (parts.length === 2) return parts[0] + " - " + parts[1];
  return raw;
}

// ── Inventory → skus[] ──
async function fetchInventory(storeFilter) {
  const params = { min_on_hand: "1" };
  if (storeFilter) params.store = storeFilter;
  const items = await fetchAllPages("inventory/getinventorybyitem", params);

  // Aggregate by SKU + normalized store (same item appears per-store)
  const skuMap = {};
  for (const item of items) {
    const rawSku = item.ItemNumber || "";
    if (!rawSku) continue;
    const sku = normalizeSku(xoroSkuToExcel(rawSku));
    const store = normalizeStore(item.StoreName);
    const key = `${sku}::${store}`;
    if (!skuMap[key]) {
      skuMap[key] = {
        sku,
        description: item.ItemDescription || "",
        store,
        onHand: 0,
        onOrder: 0,
        onCommitted: 0,
      };
    }
    skuMap[key].onHand      += item.OnHandQty || 0;
    skuMap[key].onOrder     += item.QtyOnPO   || 0;
    skuMap[key].onCommitted += item.QtyOnSO   || 0;
  }
  return { skus: Object.values(skuMap), totalItems: items.length };
}

// ── Sales Orders → sos[] ──
async function fetchSalesOrders(storeFilter) {
  // Pull SOs from the last 12 months
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const params = { created_at_min: since.toISOString() };
  if (storeFilter) params.sale_store_name = storeFilter;
  const orders = await fetchAllPages("salesorder/getsalesorder", params, 30);

  const sos = [];
  for (const so of orders) {
    const h = so.SoEstimateHeader || {};
    // Skip cancelled / fully shipped
    const status = h.StatusName || "";
    if (status === "Cancelled") continue;

    const orderNumber  = h.OrderNumber || "";
    const customerName = h.CustomerFullName || h.CustomerName || "";
    const soStore      = normalizeStore(h.SaleStoreName || h.StoreName || "");
    const cancelDate   = h.DateToBeCancelled || h.DateToBeShipped || "";

    const lines = so.SoEstimateItemLineArr || [];
    for (const line of lines) {
      const qtyOrdered = line.QtyOrdered || 0;
      const qtyShipped = line.QtyShipped || 0;
      const qtyRemaining = qtyOrdered - qtyShipped;
      if (qtyRemaining <= 0) continue; // fully shipped

      const rawSku = line.ItemNumber || "";
      if (!rawSku) continue;
      const sku = normalizeSku(xoroSkuToExcel(rawSku));

      // Parse cancel/ship date
      let date = "";
      const rawDate = cancelDate || line.DateToBeShipped || "";
      if (rawDate) {
        try {
          const d = new Date(rawDate);
          if (!isNaN(d.getTime())) date = d.toISOString().split("T")[0];
        } catch {}
      }

      const unitPrice  = line.UnitPrice || line.EffectiveUnitPrice || 0;
      const totalPrice = line.TotalAmount || (unitPrice * qtyRemaining);
      const store = normalizeStore(line.ShipStoreName || soStore);

      sos.push({
        sku,
        date,
        qty: qtyRemaining,
        orderNumber,
        customerName,
        unitPrice,
        totalPrice,
        store,
      });
    }
  }
  return { sos, totalOrders: orders.length };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { key: ATS_KEY, secret: ATS_SECRET } = getCredentials();
  if (!ATS_KEY || !ATS_SECRET) {
    return res.status(500).json({ error: "ATS Xoro credentials not configured. Set VITE_XORO_ATS_KEY and VITE_XORO_ATS_SECRET in Vercel." });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const type = url.searchParams.get("type") || "full";
  const storeFilter = url.searchParams.get("store") || "";

  try {
    if (type === "debug") {
      // Return raw page-1 response from Xoro for debugging
      const raw = await xoroGet("inventory/getinventorybyitem", { min_on_hand: "1", page: "1" });
      return res.status(200).json({
        keyPresent: !!ATS_KEY,
        secretPresent: !!ATS_SECRET,
        keyFirst8: ATS_KEY?.slice(0, 8),
        keyLen: ATS_KEY?.length,
        secretLen: ATS_SECRET?.length,
        authHeaderPreview: authHeader().slice(0, 30) + "...",
        xoroResult: raw.Result,
        xoroMessage: raw.Message,
        totalPages: raw.TotalPages,
        dataCount: Array.isArray(raw.Data) ? raw.Data.length : 0,
        firstItem: Array.isArray(raw.Data) && raw.Data[0] ? { ItemNumber: raw.Data[0].ItemNumber, OnHandQty: raw.Data[0].OnHandQty, StoreName: raw.Data[0].StoreName } : null,
      });
    }

    if (type === "inventory") {
      const inv = await fetchInventory(storeFilter);
      return res.status(200).json({ Result: true, ...inv });
    }

    if (type === "salesorders") {
      const so = await fetchSalesOrders(storeFilter);
      return res.status(200).json({ Result: true, ...so });
    }

    // full — fetch both and return ExcelData-shaped blob
    const [inv, so] = await Promise.all([
      fetchInventory(storeFilter),
      fetchSalesOrders(storeFilter),
    ]);

    const data = {
      syncedAt: new Date().toISOString(),
      skus: inv.skus,
      pos: [], // PO events still come from PO WIP (tanda_pos)
      sos: so.sos,
      _meta: {
        inventoryItems: inv.totalItems,
        skusWithStock: inv.skus.length,
        salesOrders: so.totalOrders,
        soLinesOpen: so.sos.length,
      },
    };

    return res.status(200).json({ Result: true, Data: data });
  } catch (err) {
    return res.status(500).json({ error: "Sync failed: " + err.message });
  }
}
