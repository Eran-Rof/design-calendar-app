# 6. Troubleshooting

Common errors, what they mean, and how to fix them. Errors usually appear as a red banner inside the modal, or as a browser alert toast after an action.

## Authentication / navigation

| You see… | Likely cause | Fix |
|---|---|---|
| `/tanda` won't load | Not logged in, or wrong user role | Sign in via the design-calendar-app login. Confirm your email has the right role assignment in `entity_users`. |
| Refreshing inside Style Master / etc. drops you back to dashboard | Expected — the panels use state-based navigation, not URL routes | Re-click the menu entry |
| Menu group "Analytics & Admin" doesn't show the 6 new entries | Stale browser cache after deploy | Hard refresh (Ctrl+Shift+R / Cmd+Shift+R) |

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

| Error message | Cause | Fix |
|---|---|---|
| "Cannot transition from closed to open" — wait, that's not an error, all transitions are valid | n/a | All 9 transitions (3×3 status pairs) are allowed in Tangerine. Same-status is a no-op. |
| "Unknown current status: X" | Manual API call with bad input | Pass `open`, `soft_close`, or `closed` |
| "Periods are bootstrapped by migration; user-create is not supported." (405) | You hit POST /api/internal/gl-periods | Only GET + PATCH are supported. Periods are generated at migration time, not user-created. |
| "Periods are immutable; deletion is not supported." (405) | You hit DELETE | Same — periods don't get deleted, only their status changes |

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
