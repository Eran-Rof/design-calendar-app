# Plaid setup — step-by-step

Permanent reference for wiring Plaid into the Tangerine bank reconciliation flow (P6). Run through this once per environment (Sandbox first, then Production).

> **Coexistence with the Xoro register mirror (#1671, 2026-07-09):** until Plaid goes live, the bank tables are fed by the Xoro Payments-register mirror (`source='xoro_mirror'` — see user-guide ch17). Plaid needs **no schema or code change** to go live: link each Plaid account to the SAME `gl_account_id` its mirror account uses and the existing `bank_accounts` row is reused (`plaid_*` columns fill in via the exchange handler); Plaid rows land beside mirror rows keyed by their own `external_txn_id`, and the P9 cash recon engine treats `plaid` as the Tangerine side vs `xoro_mirror` as the Xoro side — which is exactly the parallel-run comparison the cutover gate wants. The normalized ingestion contract for any future feed is `api/_lib/bank-feeds/ingest.js`.

---

## 1. Generate the at-rest encryption key

In a terminal:

```
openssl rand -hex 32
```

You'll get a 64-character hex string. Save it as `PLAID_TOKEN_ENC_KEY` in Vercel **and** in your password manager. This encrypts `bank_accounts.plaid_access_token_ciphertext` — if you lose it, every linked bank account becomes unrecoverable.

---

## 2. In the Plaid Dashboard (plaid.com)

### a. Pick an environment

Top-left dropdown: start with **Sandbox** (free, fake bank credentials). Flip to **Production** later when you want real accounts. Each environment has its own secret.

### b. Get your keys

Left sidebar → **Team Settings → Keys**:
- **`client_id`** — single value, same across environments. Save as `PLAID_CLIENT_ID`.
- **Secret for the active environment** — save as `PLAID_SECRET`. Get the Sandbox secret first, then swap to Production secret when you flip.

### c. Configure the webhook URL

Left sidebar → **Webhooks** (or **Team Settings → Webhooks**):
- Add: `https://<your-vercel-deploy>/api/webhooks/plaid`
- For Sandbox testing, use whatever your Vercel preview URL is.
- For Production, your production domain.

The webhook delivers `DEFAULT_UPDATE` (new transactions available) and `TRANSACTIONS_REMOVED` events — the handler fires `bank-feed-sync` cron logic for the affected account.

### d. Pick products

Left sidebar → **Products**. Enable **Transactions** (the only one P6 uses). Skip Identity, Income, Assets, Liabilities, Investments — they're unrelated.

### e. Country: United States

Should be the default; confirm.

### f. (Optional) Allowed redirect URIs

Only needed if you plan to link banks that use OAuth (Chase, Capital One, Citi). If so, add your domain. Most banks don't need this.

---

## 3. Vercel environment variables

Settings → **Environment Variables** on the design-calendar-app project. Add each as **Production + Preview + Development** unless noted:

| Var | Value | Notes |
|---|---|---|
| `PLAID_CLIENT_ID` | from §2b | same across environments |
| `PLAID_SECRET` | from §2b — Sandbox secret first | swap to Production secret when you flip |
| `PLAID_ENV` | `sandbox` | flip to `production` later |
| `PLAID_TOKEN_ENC_KEY` | from §1 | 64 hex chars exactly |
| `PLAID_WEBHOOK_SKIP_VERIFY` | `true` | **temporary workaround** — the dispatcher pre-parses the request body, which breaks Plaid's JWS signature verification. Set to `true` until the raw-body fix ships. |

After adding, hit **Save** then **Redeploy** the latest production deployment so the new vars take effect.

---

## 4. Smoke-test the sync

Once redeployed, open Tangerine → 🏦 Bank → Accounts tab. Click **Link Plaid account**:

- **Sandbox**: use `user_good` / `pass_good` to link a fake bank (or any of Plaid's test credentials). The exchange handler stores the encrypted access token + Plaid item_id + Plaid account_id.
- The 4-hour sync cron pulls transactions automatically. You can also fire it on demand:
  ```
  curl -X POST https://<your-deploy>/api/cron/bank-feed-sync
  ```

Transactions appear in the **🔁 Transactions** tab as `unmatched`. From there, P6 takes over — match candidates, Create JE, auto-post fee rules.

---

## 5. Flipping to Production later

1. Edit `PLAID_SECRET` in Vercel — replace Sandbox secret with Production secret.
2. Edit `PLAID_ENV` — change `sandbox` to `production`.
3. Update the webhook URL in the Plaid Dashboard if your production domain is different.
4. Redeploy.
5. Plaid bills ~$0.30/account/month from this point.

**Re-linking required:** Sandbox access tokens don't work in Production. After the flip, operator re-links each bank account through the same Plaid Link flow. Existing `bank_accounts` rows can be re-used (just update the access token columns) or fresh rows created.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cron/bank-feed-sync` returns `Plaid not configured` | `PLAID_CLIENT_ID` or `PLAID_SECRET` missing | Add to Vercel + redeploy |
| Webhook returns 401 with valid Plaid signature | Raw-body verification failing | Set `PLAID_WEBHOOK_SKIP_VERIFY=true` until the raw-body dispatcher fix lands |
| `decrypt failed` in sync logs | `PLAID_TOKEN_ENC_KEY` changed since the token was stored | Restore the original key — Plaid access tokens encrypted under a lost key are unrecoverable; re-link the account |
| Transactions stop syncing after a few days | Plaid `ITEM_LOGIN_REQUIRED` event — bank requires re-auth | Re-link via Plaid Link to refresh the access token |
| Plaid `RATE_LIMIT_EXCEEDED` | Too many parallel `/transactions/sync` calls (>30 rps to Plaid) | Reduce cron frequency or batch accounts in batches |

---

## 7. Code map

- Plaid REST wrapper: `api/_lib/plaid/client.js`
- Encryption helpers: `api/_lib/plaid/encryption.js` (AES-256-GCM, IV+tag+ciphertext format)
- Link-token + exchange handlers: `api/_handlers/internal/bank-feeds/link-token.js`, `exchange.js`
- Sync cron: `api/cron/bank-feed-sync.js`
- Webhook: `api/webhooks/plaid.js`
- Match engine that consumes the synced transactions: see [17-bank-reconciliation.md](user-guide/17-bank-reconciliation.md).
