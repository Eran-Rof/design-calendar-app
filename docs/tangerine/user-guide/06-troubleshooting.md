# 6. Troubleshooting

Common errors, what they mean, and how to fix them. Errors usually appear as a red banner inside the modal, or as a browser alert toast after an action.

## Authentication / navigation

| You see… | Likely cause | Fix |
|---|---|---|
| `/tangerine` won't load | Not logged in, or wrong user role | Click "Sign in with Microsoft" on the branded login screen. Confirm your email has the right role assignment in `entity_users` (auto-provisioned on first sign-in — see [01-getting-started.md § Auto-provisioning](01-getting-started.md#auto-provisioning-chunk-t3-2026-05-27)). |
| Bookmarks to `/tanda/...` for the admin panels 404 | Tangerine moved to its own app at `/tangerine` (Chunk T1) | Update bookmarks. The 6 admin panels no longer live inside the Tanda PO WIP app. |
| Refreshing inside Style Master / etc. drops you back to dashboard | Expected — the panels use state-based navigation, not URL routes | Re-click the module entry from the top-nav group dropdown |
| Top nav group dropdown doesn't show a module you expect | Stale browser cache after deploy | Hard refresh (Ctrl+Shift+R / Cmd+Shift+R) |
| "Sign in with Microsoft" popup is blocked | Browser popup blocker | Allow popups for your `<your-domain>` then click the sign-in button again |
| **Audit Trail** panel (on an AR/AP invoice, JE, etc.) shows **"Invalid or expired token"** | Fixed (2026-06-30). The read-only audit-trail endpoints (`/api/internal/audit/row-history`, `/audit/log`) used to require a live **per-user** token, so they 401'd whenever your per-user JWT was absent or expired (e.g. you opened an app from the launcher via the shared session, or 12h had passed) — even though the rest of the app worked. They now use the standard internal-token gate like every other internal panel. | If you still see it, **hard refresh** (Ctrl/Cmd+Shift+R) to pick up the fix; otherwise re-sign-in. |

## Master Data errors

| Error message | Cause | Fix |
|---|---|---|
| "style_code is required" / "name is required" / "code is required" | Missing required field | Fill the highlighted field |
| "style_code 'X' already exists for this entity" (409) | You're trying to add a code that's already in the table (possibly soft-deleted) | Toggle "Show deleted" to find the existing row; either restore it via direct UPDATE or pick a different code |
| "gender_code must be one of M, WMS, B, C, G, U" | Free-typed gender outside enum | Pick from the dropdown |
| "design_year must be between 1990 and 2100" | Out-of-range year | Use 4-digit year in range |
| "A vendor with that name or code already exists" (409) | Vendor uniqueness violation (name OR code) | Use Show inactive to find existing soft-deleted vendor and restore, or pick different name/code |
| "tax_id cannot be set via this endpoint (PII)" | You tried to write a PII field via the admin endpoint | Use the dedicated PII workflow (not yet built) or write via direct SQL with audit logging |

## Chart of Accounts errors

| Error message | Cause | Fix |
|---|---|---|
| List is empty | COA not seeded yet | The accountant needs to supply the canonical list, OR add accounts manually via + Add account |
| "Account code '1100' already exists for this entity" (409) | Code uniqueness violation | Codes are case-insensitive; `1100` and `1100` collide. Use Show inactive to find the existing one. |
| "account_type must be one of asset, liability, …" | Invalid type | Use the dropdown |
| "normal_balance must be one of DEBIT, CREDIT" | Invalid balance side | The dropdown auto-fills correctly based on account_type — override only if you really mean to |
| "parent_account_id not found in this entity" | Parent FK doesn't exist or is in a different entity | Verify the parent account exists and matches the current entity |
| "code is locked post-creation and cannot be updated" (400) | You tried to change `code` / `account_type` / `normal_balance` / `entity_id` via PATCH | These are immutable. Either keep the existing value, or soft-delete and recreate (but historical JEs already use the old account's `id`, so almost never the right move) |
| "Account has posted journal entry lines; mark it inactive via PATCH status='inactive' instead of deleting." (409) | You tried to DELETE an account that has JE history | Use Edit → status: inactive instead |

## Periods errors

The Periods panel exposes three dedicated actions per period — **Run checks**, **Close** (Soft / Hard), and **Reopen** — backed by the P5-1/P5-7 endpoints. Each surfaces its own error shape.

### From the Close action (POST /api/internal/gl-periods/:id/close)

| Error message | Cause | Fix |
|---|---|---|
| "target_status must be 'soft_close' or 'closed'" | Bad payload | Pick Soft close or Hard close from the panel buttons (don't hand-call the API with arbitrary status) |
| "Cannot transition '<from>' → '<target>'. Allowed: open→soft_close, soft_close→closed." (409) | You tried to skip a step (e.g. open → closed) | Soft-close first, then hard-close. The dedicated Close endpoint enforces the step order; the legacy PATCH endpoint is more permissive but not what the panel buttons call. |
| "Period is closed_with_closing_jes (terminal, set by year-end close). Cannot transition." (409) | The period was finalised by Year-End Close (P5-6) | This is by design. File correcting entries as adjustment JEs in the next FY's opening period — see [05-workflows.md § Posting against a soft-closed period](05-workflows.md#posting-against-a-soft-closed-period). |
| "Pre-flight checks failed (blocking)" (409) with `blocking_failures` array | One of the P5-7 blocking checks failed (unbalanced trial balance, draft JE in the period, negative FIFO layer) | Open the Run checks modal, inspect the red rows, fix the underlying issue, then retry. See [03-accounting.md § Close Pre-flight Checks](03-accounting.md#close-pre-flight-checks-p5-7). |
| 202 response with `requires_approval: true` | An active `approval_rules` row with `kind='gl_period_close'` routed the close through M27 | The close is parked. An approver must approve it in the Approval Inbox — see chapter 7. |

### From the Reopen action (POST /api/internal/gl-periods/:id/reopen)

| Error message | Cause | Fix |
|---|---|---|
| "Sign in with Microsoft (admin role) to reopen a period." | The reopen action couldn't find your cached sign-in identity | Sign out and back in to refresh `localStorage.tangerine.auth_user_id`, then retry. The UI no longer accepts a manually-typed uuid. |
| "reason is required (operator note explaining the reopen)" (400) | You left the reason box blank | Reopens are audited — fill the textarea with why you're reopening. |
| 403 Forbidden | Caller doesn't hold `role='admin'` on the entity | Only admins can reopen. Ask an admin to do it, or have your role bumped via `entity_users`. |
| Reopen button disabled / period is in `closed_with_closing_jes` | Terminal status set by year-end close | Cannot be reopened. File correcting JEs in the next FY instead. |

### From the legacy PATCH endpoint (advanced — not surfaced by the panel)

| Error message | Cause | Fix |
|---|---|---|
| "Unknown current status: X" | Manual API call with bad input | Pass `open`, `soft_close`, or `closed` |
| "Periods are bootstrapped by migration; user-create is not supported." (405) | You hit POST /api/internal/gl-periods | Only GET + PATCH are supported. Periods are generated at migration time, not user-created. |
| "Periods are immutable; deletion is not supported." (405) | You hit DELETE | Same — periods don't get deleted, only their status changes |

> The legacy PATCH endpoint accepts ANY of the 9 status-pair transitions (open ↔ soft_close ↔ closed). It exists for backward compatibility but bypasses pre-flight checks, the approvals gate, and the audit log. The panel buttons all route through the dedicated Close / Reopen endpoints. Prefer those.

## Journal Entry errors

### In the post modal (client-side balance check)

| Footer state | Cause | Fix |
|---|---|---|
| 🔴 "Out of balance by X.XX" | Sum of debits ≠ sum of credits | Adjust line amounts until the difference is zero |
| Post button disabled | Either out-of-balance, OR description is empty | Fill description, fix balance |

### After clicking Post (server-side)

| Error | Cause | Fix |
|---|---|---|
| "basis is required (ACCRUAL \| CASH \| BOTH)" / "posting_date must be YYYY-MM-DD" / "description is required" | Header field missing or malformed | Fill the field |
| "lines must be an array of at least 2 entries" | Fewer than 2 lines | Add a second line — every JE is at least 2-sided |
| "line N: cannot have both debit and credit nonzero" | Both amounts set on one line | Clear one — the UI now auto-clears the other when you type in either, but this error can appear if you bypass the UI |
| "line N: at least one of debit/credit must be nonzero" | Both zero | Enter an amount on one side |
| "line N: account_id must be a uuid" | Account picker not used (raw paste) | Use the dropdown picker |
| "line N: subledger_type and subledger_id must be both set or both empty" | Mismatched pair | Either fill both, or clear both |
| "Unbalanced: debits=X.XX credits=Y.YY" | Server-side balance check failed | Same as the modal's red footer — re-check line totals |
| "Total debits/credits cannot be zero" | All zeros | Enter amounts |
| "Posting failed on basis=X: …" | RPC failed on the second of a BOTH-basis pair (after the first succeeded) | The response includes a `partial` field with the JE ID that did post. Reverse it manually, fix the issue, retry. |
| "no gl_periods row covers YYYY-MM-DD for entity …" | Posting date falls outside the bootstrapped FY 2021–2030 range | Pick a date inside the range; for older entries, extend `gl_periods` via migration |
| "Period containing YYYY-MM-DD is closed" | Period status is `closed` | Either reopen the period (Periods panel), pick a date in an open period, or use `journal_type=adjustment` (only if status is `soft_close`, not full close) |
| "Period is soft-closed; only adjustment/close journal types allowed" | Trying `manual` in a soft-closed period | Switch the journal_type dropdown to `adjustment` |
| "Account has posted lines; mark inactive instead" — wait that's COA, not JE | n/a | See COA section above |
| "Unbalanced journal_entry …" from the DB trigger | The handler's balance check disagrees with the DB's (rare — usually a hand-written API call) | Re-check; the UI's balance check uses BigInt-cents math, so penny precision is exact |
| "JE line N references account in wrong entity" | Account FK belongs to a different entity than the JE's entity | Re-pick an account from your entity |
| "JE line N targets non-postable account X" | Account has `is_postable=false` (it's a roll-up parent) | Pick a postable child account |
| "JE line N targets control account X without subledger" | Control account line is missing `subledger_type` / `subledger_id` | Fill both — control accounts always need a counterparty |

### Reversal errors

| Error | Cause | Fix |
|---|---|---|
| "JE X is in status 'draft', not 'posted'" | Reversing a non-posted entry | Only `posted` entries can be reversed |
| "JE X not found" (404) | ID doesn't exist | Refresh the list; the row may have been reversed by another session |

## When you suspect something's actually broken

If the error doesn't match any of the above and the action keeps failing:

1. **Open browser DevTools (F12) → Network tab.** Reproduce the action. Look at the failing request's response body — the JSON `error` field usually has the precise reason.
2. **Check the deploy.** A recent merge may have introduced the bug; check the latest commits on the `tangerine-p1-*` branches in GitHub.
3. **Check `journal_entries` and `gl_accounts` directly via Supabase SQL.** The DB is the source of truth — if the UI says one thing and the table says another, the UI is the bug.
4. **Memory: `project_tangerine_progress.md`** lists every chunk merged with date + scope. If a behavior changed, it's there.

## Going further

- The concepts behind each error: [04-concepts.md](04-concepts.md)
- How the flows should work end-to-end: [05-workflows.md](05-workflows.md)
- The architecture doc explains every guard at the schema + handler + UI layer: [`../P1-foundation-architecture.md`](../P1-foundation-architecture.md)
