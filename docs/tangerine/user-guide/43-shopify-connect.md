# 43 — Connect a Shopify Store

**Where:** Tangerine → **Sales** section → **Shopify** group → **🛍️ Connect Store**.

Connecting a Shopify store is the **prerequisite** for everything Shopify in
Tangerine: order sync, refunds, and pulling product images onto styles. Until a
store is connected, those features are dormant.

## What you need first
A **Shopify Admin API access token** (starts with `shpat_…`):

1. Shopify admin → **Settings → Apps and sales channels → Develop apps**.
2. Open (or create) your custom app → **API credentials** tab.
3. Under **Admin API access token**, click **Reveal token once** and copy it.
   - Scopes needed: **`read_products`** (for images), plus **`read_orders`**,
     **`read_inventory`** if you also want order sync.
   - ⚠️ Shopify shows the token only once — if you miss it, **Uninstall** then
     **Install** the app again to get a fresh one.
4. Note your **`*.myshopify.com`** domain (Settings → Domains — *not* your public
   storefront domain like `www.…`).

## Connect it
1. Click **+ Connect store**.
2. Fill in:
   - **Store name** — a label (e.g. "Ring of Fire DTC").
   - **Shopify domain** — `your-store.myshopify.com`.
   - **API version** — defaults to `2025-01`.
   - **Admin API access token** — paste the `shpat_…` value.
   - **Webhook signing secret** — optional (for webhook signature checks).
3. Click **Connect**, then **Test** on the row — a green confirmation means the
   token + domain + scopes are good.

## Security
The token is **encrypted at rest** (AES‑256‑GCM) the moment you save it and is
**never shown again** — the list only shows whether a token is *set*. To replace
it, click **Edit** and paste a new token (leave blank to keep the current one).
Requires the `SHOPIFY_TOKEN_ENC_KEY` server key to be set.

## After connecting
- **Order/refund sync** runs via the existing webhooks + backfill cron.
- **One style's images:** open a style in **PIM → Images**, link it to a Shopify
  product, and click **Pull from Shopify** (see ch42 / the PIM guide).
- **All styles at once (🖼️ Bulk pull product images** on this panel): matches
  Shopify products to styles by **SKU prefix = style code** (denim inseam
  handled automatically). Three steps:
  1. **Dry-run match** — shows how many products matched + lists any unmatched
     (e.g. a gift card) without changing anything.
  2. **Link matched** — links every matched product to its style.
  3. **Pull all images** — re-hosts each linked product's images onto the style
     (runs in batches; safe to re-run — it skips images already pulled).

See also: [42 — Costing & RFQ](42-costing-module.md).
