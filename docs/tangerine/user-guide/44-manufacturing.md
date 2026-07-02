# 44. Manufacturing — assembling parts, services & labor into a finished style

The **Manufacturing module** lets you build a finished, sellable style out of purchased **parts** (blank garments, labels, trims, packaging), outsourced **services / labor** (printing, sewing, packing), and — where relevant — an existing finished style. It is designed around Ring of Fire's **outsourced CMT** model: you buy components, send them to a factory that converts them for a service fee, and receive finished garments back. Costs flow cleanly into both **inventory** (the finished style's actual cost) and **accounting** (Work-In-Process → finished goods).

> **Design principle — parts stay separate.** Parts and service items live in their own masters and (for parts) their own inventory pool. They never appear in the Style Inventory Matrix, ATS, or sales/PO style pickers. Only the *finished* style is real sellable inventory.

This chapter grows as the module ships in phases. The current state:

| Phase | What it adds | Status |
|---|---|---|
| **M1 — Masters** | Part Master + Service Item Master | ✅ Shipped |
| M2 — Part inventory | Parts get their own FIFO stock + GL; on-hand view + adjustments | ✅ Shipped |
| M3 — BOM | Per-style recipe of parts + services + consumed styles | ✅ Shipped |
| M4 — Build orders + WIP | Release → issue components into WIP → complete into finished goods | ✅ Shipped |
| M5 — PO-driven completion | Receive the finished good against a conversion PO to close the build | ✅ Shipped |
| M6 — Reports | Open WIP, completed-build cost, parts valuation | ✅ Shipped |

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

- **+ New BOM** — pick the **finished style** to build (the picker lists **base styles** — code + name — not per-size SKUs). If the style isn't on file yet, click **+ New style** to create it inline (admins only). Set a **version** and **status** (draft / active / archived), optionally a **default conversion vendor** (the factory) and notes.
- **Customer-specific BOM (private label).** Optionally set a **Customer** on the BOM: a style can have a **generic** BOM (no customer) plus **per-customer** variants. When you release a build that's *for a customer*, Tangerine picks that customer's active BOM if one exists, otherwise the generic one. "One active BOM" is enforced per **style + customer**, so the generic and each customer's BOM can each be active at once. The BOM list shows the customer (or *generic*).
- **Components** — add a row per component. Each row picks a **kind**, then the item:
  - **Part** — a `part_master` component (blank tee, label, trim, packaging) consumed from part inventory.
  - **Service** — a `service_item_master` charge (print, sew, pack) billed by the factory.
  - **Finished style** — an existing finished style consumed into the build (e.g. a base jean → its `PL` packed/labeled variant).
  - Set **Qty/unit** (how much of the component goes into one finished unit), an optional **Scrap %**, and a **Cost** basis (Actual/FIFO is the default).
- **One active version per finished style** — saving a second BOM as *active* for the same style is rejected; archive the old one or bump the version. Drafts and archives can coexist.
- **Add a part or service on the fly.** Next to the component picker, **+ New part** / **+ New service** open a popup with the same key fields as the Part / Service masters; on save the item is created, added to the dropdown, and selected — you stay in the BOM. Admins only.
- **Costs & total.** Each row shows a **unit cost** and an **extended cost** (unit × qty/unit), and the BOM shows a **total cost**. Costs default to the masters — part default cost, service default charge (**editable inline** per BOM), finished-style average cost — so you can see the recipe's cost before ever building.
- **Save → activate prompt.** Saving a *draft* BOM asks whether to set it **Active** now (OK) or keep it draft (Cancel) — so a finished BOM is one click from buildable. (Manufacturing lives in its **own top-level drawer section** now, not under Master Data.)

A BOM is just the recipe — nothing is consumed or costed until you run a **build order** against it (M4). The two example flows (printed tee = blank-tee part + print service; PL jean = base style + labels part + sew/pack services) are both modeled as a single BOM each.

## M4 — build orders + WIP (shipped)

A **build order** runs a BOM to produce real finished-goods inventory, with all costs flowing through a **Work-In-Process (WIP)** account at **actual cost**. Find it under **Manufacturing → Build Orders** (`/tangerine?m=mfg_build_orders`).

The lifecycle:

1. **New build** — search and pick the **finished style** (the picker lists **base styles** — one row per style, code + name — not per-size SKUs), then **plan the run by size**: a color × size matrix (the same grid as SO/PO entry) lets you enter the quantity per size right away, and the **target quantity is the matrix total**. (If the style has no size scale, you just enter a total.) Creates a *draft*. **Add a style on the fly:** if the style isn't on file, click **+ New style** (admins only). *The new style still needs an active **BOM** before you can Release the build.*
   - **Active-BOM gate.** You can only build a style that has an **active BOM**. If its BOM is still **Draft**, you're offered a one-click **Activate**; if it has **no BOM**, you're told to create one first. Create stays disabled until a usable BOM resolves.
   - **Auto customer.** If the resolved BOM is customer-specific, **Build for customer** is auto-filled with that customer.
   - **Availability under each size.** The plan matrix shows each finished size's **on-hand** underneath the cell (like SO entry), and a **component-availability** panel lists the BOM's parts with required-vs-on-hand and a **shortage warning** when you'd build beyond what's in stock (informational — it never blocks). *First version: parts show aggregate on-hand; per-size and on-PO are a follow-up.*
2. **Release** — snapshots the style's active BOM into the build, scaling each component to `qty_per_unit × target × (1 + scrap%)`. Status → *released*.
3. **Issue components → WIP** — consumes the **parts** (from part inventory) and any **consumed finished styles** (from style inventory) at their actual **FIFO** cost, into WIP. Posts, per component, `DR 1305 WIP / CR 1360 Inventory-Parts` (or `/ CR` the style inventory account). Status → *issued*. **Where you see the result:** the build's **WIP rollup** (Parts / Consumed styles / WIP total) and each row's *Consumed* + *Actual cost*; the **General Ledger** (journal entries on **1305 WIP** and the credited inventory accounts); the **part inventory** depleting; and **Manufacturing → Reports** (open WIP). Every posting now carries an **audit reason** (required by the ledger's audit policy) generated automatically per step.
4. **Capitalize services** — for each conversion/labor **service** component, click **Capitalize** and enter the factory's actual charge. Posts `DR 1305 WIP / CR 2000 AP` (the vendor bill) and rolls the charge into WIP.
5. **Complete → finished goods** — moves the full accumulated WIP into finished-goods inventory: posts `DR <style inventory> / CR 1305 WIP` and creates the finished style's **FIFO layer at the real build cost** (`accumulated ÷ completed qty`), tagged `source_kind = manufacture`. Status → *completed*. (You must capitalize all service charges first.)

The build detail view shows a live **WIP rollup** — parts cost, consumed-style cost, service cost, WIP total, and the projected/finished unit cost. It also shows a **projected cost** per component from the masters **before anything is issued or capitalized**, so you can see the expected cost of the run up front (actual cost fills in as each step posts). **WIP is a control account** keyed by build order, so the WIP balance always reconciles per build. A build can be **cancelled** before completion; a completed build keeps its journal entries.

### Completing by size — the produced color × size matrix

A build usually makes a run of one style across **many sizes** (and colors) at once, and inventory is tracked **per size**. When the finished good is a **style-backed** item, pressing **Complete → finished goods** now opens a **produced-by-size matrix** — the same color × size grid used on sales-order and PO entry. Enter the quantity actually produced in each cell (an **Even-split target** button splits the target evenly across the sizes of the default colour as a starting point; you can then tweak, and the total is free to differ from the target to reflect real yield).

On submit, each filled cell resolves to (or auto-creates) that size's SKU and Tangerine lands **one finished-goods FIFO layer per size** — so on-hand and future COGS are correct at size grain instead of dumped onto a single item. The accounting stays clean: the per-unit cost is **uniform** (`accumulated ÷ total units produced`), the finished-inventory **debit is split per size** (one line each, so the per-item subledger matches the layers), and the single **WIP credit** clears the whole accumulated cost — the journal entry balances exactly. The completed build lists what it produced under **Produced (by size)**.

The completion matrix is **pre-filled from the plan** you entered at build creation, so you usually just confirm (or adjust for actual yield) and complete. If the finished good has no size scale, completion falls back to the original single-quantity path (`completed qty`, one layer).

### Building for a customer (private label) + auto customer style number

When you create a build you can optionally set **Build for customer** — the customer this run is being made for (private-label / made-to-order). Pick the customer and Tangerine pre-fills a **Customer style #** as `<customer code>-<base style>` (e.g. `CUST-00042-RYB0412`); you can edit it before saving. On create, that number is saved to the shared **customer style-number** register (`style_customer_numbers`) — the same one edited in **Style Master → Customer style numbers** and used to resolve a customer's own number on an incoming PO.

It's **idempotent**: a customer has at most one number per base style, so if a mapping already exists it's kept (not overwritten). The build header shows *For &lt;customer&gt; · cust style &lt;number&gt;*, and every number for a customer is listed read-only under **Customer Master → Style numbers**. Leaving the customer blank keeps the build a normal for-stock build.

**Delete a build (item 2).** Each **draft** or **cancelled** build row has a **Del** button. Deleting checks whether a **BOM is attached** (its components are snapshotted on Release): if so, a warning asks you to **continue or cancel** before it removes the build and its components (they cascade). Issued/in-progress/completed builds can't be deleted — cancel them first (and completed builds are immutable for GL integrity).

> The printed tee: release pulls the blank tee + the print service into the build; issue draws the blank tee into WIP at FIFO cost; capitalize the printer's charge into WIP; complete creates the printed-tee inventory at *blank cost + print charge*. The PL jean works the same way, additionally consuming the base finished style.

## M5 — receive the finished good against a conversion PO (shipped)

Instead of pressing **Complete** by hand, you can let **receiving** close the build — the flow the operator asked for ("a PO may be issued for the printed t-shirt… how is it received against the PO?").

How it works:
1. Run the build through **Release → Issue → capitalize services** (so WIP holds the full cost), exactly as in M4.
2. Cut a **conversion / subcontract PO** (a native Purchase Order) for the finished style — e.g. the print job that returns printed tees — and **link it to the build** (the build's *conversion PO* field).
3. When the finished goods arrive, **receive them against that PO** and post the receipt as normal.

On posting, Tangerine detects the build link and **completes the build automatically**: it skips the ordinary goods-receipt path (no GRNI / landed-cost layer at the PO's nominal price) and instead moves the build's accumulated WIP into finished-goods inventory at the **real build cost** — `DR <style inventory> / CR 1305 WIP` plus the finished FIFO layer at `accumulated ÷ received qty`. The build flips to *completed*, the received quantity becomes the completed quantity, and the receipt is stamped with the finished layer.

Guards: the build must be *issued* and **all service charges capitalized** first (otherwise the receipt is rejected with a clear message), so the finished cost is never understated.

> So the printed-tee PO is received exactly like any other PO — but because it's a conversion PO tied to a build, the receipt's effect is "finish the build," valuing the printed tees at *blank-tee cost + print charge* rather than at the PO's headline price.

### Buying parts (shipped)

Parts are stocked the proper way too — as a **vendor purchase**, not just opening-balance adjustments. In **Part Inventory**, **+ Receive purchase** (or **Buy** on a part row) opens a modal: pick the **part** and **vendor**, enter **quantity** and **unit cost**, optionally a bill number. On save it **creates a vendor bill and posts it** — `DR 1360 Inventory-Parts / CR Accounts Payable` — and stocks the part into its FIFO pool at the purchase cost. So the parts you'll consume in builds enter inventory at real purchase cost and leave a payable for the vendor, exactly like buying finished goods. (Built on the AP posting engine via a part line on the vendor bill.)

## M6 — manufacturing reports (shipped)

**Manufacturing → Mfg Reports** (`/tangerine?m=mfg_reports`) gives a read-only view over the whole module:

- **Open WIP** — every build still in progress, with its cost split (parts / services / consumed styles), **days open**, and WIP total. The summary card shows the **total value tied up in WIP** right now.
- **Completed builds** — each finished build with its quantity, cost breakdown, total cost, **finished unit cost**, and completion date — your actual cost of make.
- **Parts valuation** — on-hand parts ranked by value, plus the total parts inventory value.

Every section exports to Excel. This closes out the module: masters → part inventory → BOM → build orders + WIP → PO-driven completion → reports.
