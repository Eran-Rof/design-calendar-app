# 47. Assistant draft actions (the assistant does things for you)

> **Status (2026-07-14):** P28-4 Phase 4 — the assistant graduates from *reading and routing* (chapters 24-25, 46) to **drafting an action you confirm**. Arch: `P28-4-draft-actions-architecture.md`. P28-4-2 shipped the plumbing plus a chargeback-match suggestion and copyable email drafts; **P28-4-3 adds drafting a journal entry** — the first action that can move money through the ledger.

Phases 1-3 let the assistant read your queues, write your morning brief, and open panels for you. Phase 4 lets it **prepare an action** — but never perform one on its own. The rule is simple and never bends:

> **The assistant proposes; you dispose; and when money moves, a second person still approves.** The assistant has no identity of its own, so it can never be the one who confirms or approves anything.

## 47.1 How a draft action works

When you ask the assistant to do something that changes data, it does **not** change it. Instead:

1. It **previews** the change — read-only — and shows you exactly what it would do.
2. For anything that writes, it shows a **Confirm card**: a one-line summary and a **Confirm** / **Cancel** choice. Nothing happens until you click **Confirm**.
3. Clicking **Confirm** performs the write **as you** — checked against your access rights at that moment, on a signed, single-use, 5-minute confirmation. The assistant is structurally unable to skip this step.

If a preview turns up nothing safe to do, the assistant says so and offers no Confirm card — there is nothing to confirm.

## 47.2 Suggest a chargeback match

Ask something like *"can you match this chargeback?"* while looking at an open chargeback, or *"find the invoice for chargeback ROF-I141259."*

- The assistant looks only at that chargeback's customer and finds the **single, unambiguous** AR invoice its item number points to — the same exact-match logic the nightly auto-match uses.
- If it finds one, the Confirm card reads e.g. *"Match chargeback ROF-I141259 ($412.00) to invoice ROF-I141259 (exact match)."* **Confirm** links them; the link is recorded in the chargeback's history and is fully reversible from the Chargebacks panel.
- If **no single invoice** matches — none found, or two could fit — the assistant proposes **nothing**. A wrong link is worse than no link, so it leaves the item for you to match by hand in the Chargebacks worklist.
- A chargeback that is already dispositioned, already linked, or has no customer on file is left alone (the assistant tells you why).

A chargeback match is only a **link** — no money moves — so it needs your one Confirm and nothing more.

## 47.3 Draft a vendor or customer email

Ask *"draft an email to Acme about the late fabric shipment"* or *"write a note to Nordstrom about the credit memo."*

- The assistant composes a **copyable draft** — a subject line and a short, plain-text body built from the recipient, the topic, and any facts you give it.
- **Nothing is sent and nothing is saved.** The draft appears for you to copy into your own mailbox and send yourself. (This matches the standing rule that the assistant drafts; the CEO sends.)

Because these drafts write nothing, there is no Confirm card — the text simply appears.

## 47.4 Draft a journal entry

Ask something like *"draft a journal entry to reclass $6,000 of ecom revenue from 4005 to 4011"* or *"book a $1,200 accrual: debit 6200, credit 2100, memo month-end."*

- The assistant proposes a **balanced** set of debit and credit lines against **real chart-of-accounts codes**, with your description and a required reason. It shows a Confirm card such as *"Post JE: 2 lines, $6,000.00 — Reclass ecom revenue 4005 to 4011. This is at or above the $5,000 approval threshold, so confirming submits it for approval..."*
- **It never invents an account.** If any code you name isn't in the chart of accounts (or is an inactive / roll-up account you can't post to), the assistant drafts **nothing** and tells you which code was the problem — it will not guess a classification.
- **It must balance.** If the debits and credits don't foot to the same total, there is no Confirm card. Only a balanced entry can be confirmed.
- **A reason is always required.** The reason is recorded on the audit trail with the entry (the same T11 reason the manual JE screen asks for).

When you Confirm, the entry posts through the **exact same path** as posting a manual journal entry by hand:

- **Below the approval threshold** (currently **$5,000**), it posts to the ledger immediately, recorded as posted by **you**.
- **At or above the threshold**, it is **held for approval** — it does **not** post. It becomes a pending approval that a **different** authorized person must approve before it hits the ledger. The assistant is the *maker*; it can never be the *checker*, and because the entry is created as **you**, you cannot approve your own draft either. A second, independent person always approves money.

This is the same maker-checker control the manual JE screen uses — the assistant simply prepares the entry; nothing about who may post or approve is relaxed.

## 47.5 What stays gated

- **Money still double-gates.** When a later draft action moves money (a journal entry, a payment), your Confirm is only the first gate — it still goes through the normal approval rules, and a **different** person approves it. The assistant can never approve, because it holds no user identity.
- **Your access rights still apply.** A draft action's write is checked against your permissions on the target module at the moment you Confirm — exactly as if you had done it by hand in the panel.
- **Confirmations are single-use and short-lived.** Each Confirm card is good for one click within five minutes; a stale or reused card is rejected.

## 47.6 Notes

- The assistant only ever *drafts*; every write in this program is an explicit human **Confirm** click. There is no autonomous or scheduled write, ever.
- Draft actions are unavailable until the confirmation secret is configured on the server. Until then, previews and drafts still work — only the Confirm step is inert.
- Dates shown in drafts and summaries follow the guide-wide **MM/DD/YYYY** convention; you never see raw record IDs — chargebacks show their item number, invoices their invoice number.
