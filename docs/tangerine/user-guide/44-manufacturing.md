# 44. Manufacturing — assembling parts, services & labor into a finished style

The **Manufacturing module** lets you build a finished, sellable style out of purchased **parts** (blank garments, labels, trims, packaging), outsourced **services / labor** (printing, sewing, packing), and — where relevant — an existing finished style. It is designed around Ring of Fire's **outsourced CMT** model: you buy components, send them to a factory that converts them for a service fee, and receive finished garments back. Costs flow cleanly into both **inventory** (the finished style's actual cost) and **accounting** (Work-In-Process → finished goods).

> **Design principle — parts stay separate.** Parts and service items live in their own masters and (for parts) their own inventory pool. They never appear in the Style Inventory Matrix, ATS, or sales/PO style pickers. Only the *finished* style is real sellable inventory.

This chapter grows as the module ships in phases. The current state:

| Phase | What it adds | Status |
|---|---|---|
| **M1 — Masters** | Part Master + Service Item Master | ✅ Shipped |
| M2 — Part inventory | Parts get their own FIFO stock (received via AP), with GL | ⬜ |
| M3 — BOM | Per-style recipe of parts + services + consumed styles | ⬜ |
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
