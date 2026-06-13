# 44. Manufacturing — assembling parts, services & labor into a finished style

The **Manufacturing module** lets you build a finished, sellable style out of purchased **parts** (blank garments, labels, trims, packaging), outsourced **services / labor** (printing, sewing, packing), and — where relevant — an existing finished style. It is designed around Ring of Fire's **outsourced CMT** model: you buy components, send them to a factory that converts them for a service fee, and receive finished garments back. Costs flow cleanly into both **inventory** (the finished style's actual cost) and **accounting** (Work-In-Process → finished goods).

> **Design principle — parts stay separate.** Parts and service items live in their own masters and (for parts) their own inventory pool. They never appear in the Style Inventory Matrix, ATS, or sales/PO style pickers. Only the *finished* style is real sellable inventory.

This chapter grows as the module ships in phases. The current state:

| Phase | What it adds | Status |
|---|---|---|
| **M1 — Masters** | Part Master + Service Item Master | ✅ Shipped |
| M2 — Part inventory | Parts get their own FIFO stock + GL; on-hand view + adjustments | ✅ Shipped |
| M3 — BOM | Per-style recipe of parts + services + consumed styles | ✅ Shipped |
| M4 — Build orders + WIP | Release → issue components into WIP → complete into finished goods | ⬜ |
| M5 — PO-driven completion | Receive the finished good against a conversion PO to close the build | ⬜ |
| M6 — Reports | WIP aging, build-cost variance, parts valuation | ⬜ |

## The two real-world flows this is built for

1. **Printed tee** — the finished style is a printed tee. Its components are a **blank tee** (a part you stock) plus a **print** (a service the printer charges for). You cut a conversion PO for the print job; when the printed tees arrive you receive them against that PO, and the finished tee's cost becomes *blank-tee cost + print charge*.
2. **Jeans "PL" variant** — a base jean style plus a `PL` suffix that needs **labels**, **label sewing**, and **packing**. The build consumes the base finished style and the label part, adds the sew + pack services, and produces the `PL` finished style.

## M1 — the masters (shipped)

Two new Master Data panels are the foundation; both are documented in [02-master-data.md](02-master-data.md):

- **🧩 Part Master** (`/tangerine?m=part_master`) — purchased components, server-coded `PART-NNNNN`, with a part type, unit of measure, default vendor/cost, an optional *size-scaled* flag (for by-size parts like blank tees), and an optional link to a Fabric Code when the part is fabric.
- **🛠️ Service Item Master** (`/tangerine?m=service_item_master`) — outsourced conversion/labor charges, server-coded `SVC-NNNNN`, with a service kind, default vendor/charge, and a *Capitalize to WIP* switch that decides whether the charge rolls into the finished good's value or expenses directly.

With the masters in place you can catalog every component and service. Building actual recipes and running builds arrives in M3–M5.

## M2 — part inventory (shipped)

Parts now hold real stock in their **own FIFO pool**, completely separate from finished-style inventory — they never appear in the Inventory Matrix or ATS.

- **🧩 Part Inventory** (`/tangerine?m=part_inventory`, under **Manufacturing**) shows on-hand by part: quantity, average unit cost, total value, and layer count, with a running **Total parts value**. Export to xlsx.
- **Adjust / opening balance** — the **+ Adjust** button (or per-row **Adjust**) opens a modal to change a part's on-hand:
  - **Increase** (opening balance / found / correction-up) — enter a quantity and **unit cost**, pick a **counter account** (e.g. an opening-balance equity or found-income account). This creates a FIFO cost layer and posts **DR 1360 Inventory-Parts / CR** your counter account.
  - **Decrease** (damage / shrinkage / write-off / correction-down) — enter a quantity and pick an **expense account**. This FIFO-consumes the oldest layers at their actual cost and posts **DR** expense **/ CR 1360 Inventory-Parts**.
  - Every adjustment is posted to the general ledger immediately and is immutable; correct a mistake with an opposing adjustment.

Behind the scenes parts use a dedicated FIFO engine (`part_inventory_layers` + `part_fifo_consume`) and a new control account **1360 Inventory – Parts** (subledger by part), mirroring the finished-goods FIFO engine but kept entirely separate. How parts are *purchased* (a vendor bill / PO that stocks parts) is wired up alongside the build-order work in a later chunk; today, opening balances and corrections seed and maintain part stock.

## M3 — bill of materials (shipped)

A **BOM** is the recipe for assembling a finished style. Find it under **Manufacturing → Bill of Materials** (`/tangerine?m=mfg_bom`).

- **+ New BOM** — pick the **finished style** to build (type to search your styles), set a **version** and **status** (draft / active / archived), optionally a **default conversion vendor** (the factory) and notes.
- **Components** — add a row per component. Each row picks a **kind**, then the item:
  - **Part** — a `part_master` component (blank tee, label, trim, packaging) consumed from part inventory.
  - **Service** — a `service_item_master` charge (print, sew, pack) billed by the factory.
  - **Finished style** — an existing finished style consumed into the build (e.g. a base jean → its `PL` packed/labeled variant).
  - Set **Qty/unit** (how much of the component goes into one finished unit), an optional **Scrap %**, and a **Cost** basis (Actual/FIFO is the default).
- **One active version per finished style** — saving a second BOM as *active* for the same style is rejected; archive the old one or bump the version. Drafts and archives can coexist.

A BOM is just the recipe — nothing is consumed or costed until you run a **build order** against it (M4). The two example flows (printed tee = blank-tee part + print service; PL jean = base style + labels part + sew/pack services) are both modeled as a single BOM each.
