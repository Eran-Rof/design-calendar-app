# Tangerine — Operator Action Items (things only the CEO can do)

> Living list of items **blocked on the operator** — external accounts, credentials, env vars, business decisions, and go-live switches. Agents append here whenever a build hits an operator dependency (same discipline as updating BUILD-PROGRESS). Check items off / strike them as done.

**Last updated:** 2026-05-31

---

## 🔴 Blocking — a build is waiting on these

| Item | Needed for | Detail |
|---|---|---|
| **Paycor access** | M51 Payroll | Confirm your Paycor plan exposes a **GL export** (preferred) **or the API**, and get credentials (API key/OAuth, or SFTP). Usually a plan-tier/partner gate — ask your Paycor rep. Then: the **pay-code→GL mapping**, a **Net-Pay-Clearing vs Cash** choice, and whether to **brand-allocate labor** on day one. *(arch: `payroll-paycor-integration-architecture.md`)* |
| **Plaid credentials** | M7/M8 Bank feeds + reconciliation (live) | Live Plaid API keys / item link so bank + CC feeds pull real transactions (recon engine is built; needs the live connection). |
| **Stock-allocation rule** | P15 inventory stock-pool separation | How existing on-hand maps to the new WS/EC "store" pools. Recommended default: **all current stock → each brand's Wholesale pool**, tag new receipts going forward. (Or "import the Xoro store split.") |
| **Axel entity details** | Axel brand standup | Axel is a separate legal entity. Provide its legal name / tax / fiscal info to stand up the entity + brand, then its 15 unmapped `ip_item_avg_cost` rows get attributed. |

## 🟡 Go-live switches — when you're ready (operator-controlled, not blocking the build)

| Switch | Effect | Pre-req |
|---|---|---|
| `RBAC_MODE` = `log` → `enforce` (Vercel) | Turns on per-user permission enforcement | First configure roles in 🔐 User Access; run `log` a few days to watch telemetry, then `enforce`. |
| `BRAND_SCOPE_MODE` = `log` → `enforce` (Vercel) | Activates ALL brand behavior, currently inert: brand/channel report filtering (C3), **M50 GL allocation auto-splitting** of postings into brand sub-accounts, and **P15 inventory pool separation** (FIFO draws from the brand pool). | **Sizable go-live — do the prereqs first (see the dedicated checklist below).** Run `log` first to watch telemetry, then `enforce`. Verify a brand-filtered report sums back to "All". |
| Xoro cutover gates (P9) | Retire Xoro per area | 2 consecutive months reconciling within tolerance; first gate (Cash) ~2026-07-28. |

### 🟠 Brand-scope enforcement — go-live checklist (`BRAND_SCOPE_MODE=enforce`)

Everything below is **built and inert today**; flipping the flag turns it on. Do these in order:

1. **Configure brand allocations** on the P&L accounts that should split by brand (COA → account edit → Brand Allocation). Parent accounts with >1 brand auto-generate `{code}-{BRAND}` children.
2. **Assign brands to items / styles** (Style Master / item master `brand_id`) — today everything is tagged ROF by default, so all stock/sales would map to ROF pools until real brands are set.
3. **Decide existing on-hand handling** — currently forward-only (legacy stock is "(unpartitioned)"). If you want historical stock attributed to brand pools, do a one-time backfill (e.g. from a Xoro store export) — otherwise leave it.
4. **Build partition-aware FIFO consumption** (the one remaining P15 dev task — agent, ~1 chunk): make a sale draw from its (brand, channel) pool. Deliberately deferred until now so it can be tested against real partitioned stock. *Not an operator task — flag the agent to build it before enforcing.*
5. **Set `BRAND_SCOPE_MODE=log`** on Vercel; watch the silent-log telemetry for a few days; spot-check that a brand-filtered Income Statement / AR aging foots to the "All brands" total.
6. **Flip to `enforce`.** From then on: manual JE + AP postings auto-split by allocation %, reports filter by the brand switcher, and inventory separates by pool.

## ✅ Done

- **`TANGERINE_JWT_SECRET`** set on Vercel (`design-calendar-app` project) → JWT identity bridge live.
- **M50 GL Brand Allocation** design signed off (4 open items resolved).
- **Brand model** finalized (8→10 brands, channels, partitions, allocation engine).

---

## How to use
Agents: when a chunk needs something only the operator can provide (a credential, an external-account setting, a business rule, a flag flip), add a 🔴 row here with what + what-it-unblocks, instead of silently stalling. Move it to ✅ when done. The operator works from this list.
