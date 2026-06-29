# 15. Fabric Codes (P3 / Chunk 11)

The Fabric Codes panel is Tangerine's lightweight, textile-specific master for the fabrics that make up your designs. It connects to Style Master via a many-to-many "style ↔ fabric" junction, so each style can declare which fabrics it uses, in what role, and how much yardage per finished unit.

> **Why this exists.** M34 Style Master (P1) shipped without structured fabric data, and the full M42 PIM is still months away in P8. Tech packs, GS1 care labels, and the upcoming M48 customs work all need real fabric reference data **now** — not a JSON blob stuffed into `attributes`. Operator flagged the gap on 2026-05-27 and this chunk closes it.

## Where to find it

**Tangerine top nav → Master Data → 🧵 Fabric Codes.**

Sits alongside Style / Vendor / Customer Master.

## What a fabric code looks like

| Field | Required | Meaning |
|---|---|---|
| `code` | yes (unique per entity, locked after creation) | Short identifier — e.g. `CTN100`, `DEN14`, `POLY60_CTN40` |
| `name` | yes | Human-readable label |
| `composition_text` | yes | Free-form composition for tech-pack / label display, e.g. `60% Polyester / 40% Cotton` |
| `composition_json` | no | Optional structured composition — `[{"fiber":"cotton","pct":100}]` — used for analytics + auto-label generation |
| `fabric_weight_gsm` | no | Grams per square meter |
| `country_of_origin_iso2` | no | ISO 3166-1 alpha-2 (2 letters, uppercased automatically) |
| `hts_code` | no | HTS / HSN code for customs filings — feeds M48 |
| `care_instructions` | no | Free-form care instructions — feeds GS1 care labels |
| `default_vendor_id` | no | FK to Vendor Master — sets a default sourcing vendor |
| `is_active` | yes (default `true`) | Inactive fabrics are hidden from style attachment dropdowns |

## Seeded defaults

The migration seeds these for the ROF entity (skipped if any fabric_codes row already exists for ROF):

| Code | Name | Composition | GSM |
|---|---|---|---|
| `CTN100` | 100% Cotton | 100% Cotton | 180 |
| `DEN14` | 14oz Denim | 100% Cotton, 14oz denim weave | 410 |
| `DEN12` | 12oz Denim | 100% Cotton, 12oz denim weave | 350 |
| `POLY100` | 100% Polyester | 100% Polyester | 150 |
| `POLY60_CTN40` | 60/40 Polyester-Cotton | 60% Polyester / 40% Cotton | 200 |
| `VIS100` | 100% Viscose | 100% Viscose | 130 |
| `WOOL100` | 100% Wool | 100% Wool | 280 |
| `LINEN100` | 100% Linen | 100% Linen | 200 |
| `SPANDEX_BLEND` | Cotton-Spandex blend (typical) | 95% Cotton / 5% Spandex (typical) | 220 |

Country of origin and HTS code are left **NULL** on the seeded rows — the operator fills them via the UI when known.

## Attaching fabrics to a style

The `style_fabric_codes` table is a many-to-many junction. The same fabric can appear on the same style in **different roles** (e.g. cotton as `primary` AND cotton as `trim`), but not duplicated within a role.

Open Style Master → Edit a style. At the bottom of the edit modal you'll see a **Fabrics** subsection:

- **Lists** current fabrics on this style: role, fabric (code + name), yards/unit, notes
- **+ Add fabric** opens an inline form: pick a role, pick a fabric from the dropdown, optionally enter yardage, optionally add notes
- **Remove** detaches the fabric from the style (the fabric itself remains in the master — only the link is removed)

### Roles

The `role` column accepts these values: `primary`, `lining`, `trim`, `interlining`, `accent`, `other`.

Typical use:
- **primary** — the main shell fabric (one per style usually)
- **lining** — interior lining
- **trim** — pocketing, binding, contrast panels
- **interlining** — collar / waistband stiffeners
- **accent** — small decorative panels, embroidered patches
- **other** — anything else (zipper tape, tags, etc.)

### Yardage

`yardage_per_unit` is a free-form numeric — units are assumed yards. Leave blank if not yet measured. The number is used by future BOM (M33) and material costing flows.

## Workflow

```
[Add fabric to master]  →  [Attach to style via junction]  →  [Reference downstream]
                                                                ├─ Tech Pack PDF (P8)
                                                                ├─ GS1 care label (existing)
                                                                ├─ Customs filing (M48)
                                                                └─ BOM / material costing (M33)
```

## Deletion behavior

- **Soft retire a fabric:** edit it and uncheck `is_active`. It stops appearing in style dropdowns; existing links remain intact.
- **Hard delete:** only allowed if NO `style_fabric_codes` row references the fabric. Otherwise the DELETE returns `409 Conflict` with a count of references.
- **Detach a fabric from a single style:** use the Remove button in the style edit modal's Fabrics subsection — this deletes the junction row only.

## Future integration points

| Module | How fabric_codes connects |
|---|---|
| **M33 BOM** | `style_fabric_codes.yardage_per_unit` becomes the apparel-side BOM coefficient |
| **Tech Pack PDF** | The composition_text + GSM + care_instructions render into the spec sheet automatically |
| **GS1 care labels** | The `care_instructions` text becomes the human-readable block on the label |
| **M48 Customs** | `country_of_origin_iso2` + `hts_code` are the two columns customs needs |
| **M42 PIM (P8)** | When PIM ships, fabric_codes either folds into it as a sub-entity OR remains as a normalized lookup. Decided in the P8 arch pass; UI surface is forward-compatible either way. |

## AI HTS Suggestion (🤖 Suggest)

The **HTS code** field in the Style Master add/edit modal includes a **🤖 Suggest HTS** button that uses Claude AI (claude-haiku-4-5-20251001) to propose the top 3 most likely HTS codes based on the style's Group (top / bottom / accessory) + Gender + the base fabric's composition.

### Up to three Countries of Origin (COO)

The HTS section is a **per-country repeater** — add up to **three COO rows**, each with its own **HTS code**, **Duty %**, **Tariff %**, **Country of origin** picker, and its own **🤖 Suggest HTS** button.

> **Tariff % (the additional Trump-administration tariff).** Next to each row's Duty % is a **Tariff %** field for the additional tariff that currently applies **flat at +10%, all countries and categories** — it defaults to `10`. It is stored per COO row and mirrored on the style, separate from the country-specific Duty %, so costing and customs can read the base duty and the additional tariff independently. Adjust it if policy changes. Because the HTS *code* is product-based it's normally the same across countries, but the **duty rate varies by country**: the AI applies any US trade-preference program the country qualifies for (e.g. **AGOA** for eligible sub-Saharan African countries like Madagascar, **USMCA** for Mexico/Canada, **CAFTA-DR**, **GSP**), which often drops the rate to 0%; otherwise it uses the Column 1 General (MFN) rate, and states the basis in its reasoning. **Row 1 is the primary** — its HTS code + duty rate are what costing and customs read. Rows 2–3 are stored alongside on the style (`attributes.coo_hts`).

### How to use

1. Fill in the style's **Group** and a **Base fabric** (with composition).
2. Pick the **Country of origin** on a row, then click its **🤖 Suggest HTS** — the suggestion's duty reflects that country.
3. A dropdown appears with up to 3 suggestions, each showing:
   - The HTS code (e.g. `6110.20.2090`)
   - A plain-English description
   - Duty rate percentage (country-specific)
   - Confidence level (high / medium / low)
   - AI reasoning (incl. the duty basis, e.g. "AGOA duty-free")
4. Click any suggestion to fill that row. You can still edit the code/duty manually after. Use **+ Add COO** for a second/third country.

> **Always verify AI suggestions against the official HTSUS schedule** (hts.usitc.gov) before using them in customs filings. AI classification is a starting point, not a legal ruling. Misclassification can result in underpayment of duties or CBP penalties.

The button is disabled if `ANTHROPIC_API_KEY` is not configured in the Vercel environment; it returns an empty list with a note instead of an error.

> **Gender-correct suggestions.** The HTS suggestion now classifies for the **style's own gender only** — it no longer returns a code that spans multiple genders.

### 🤖 Auto-fill HTS (BD / CN / MG) — bulk backfill

For a one-shot pass over the whole catalog, the Style Master toolbar has an **🤖 Auto-fill HTS (BD/CN/MG)** button. It walks every apparel style and makes one gender-aware AI call per style, returning a single HS code plus the duty rate for the three main sourcing countries — **Bangladesh** and **China** (Column-1 MFN rates) and **Madagascar** (AGOA duty-free) — and stamps the **+10% additional tariff** on each. It's **idempotent**: styles that already carry all three countries are skipped, so it's safe to re-run. As always, treat the AI codes as suggestions to verify before customs use. Needs the AI key on the deployment.

## HTS Master panel

**Tangerine top nav → Master Data → 🛃 HTS Master**

The HTS Master is a reference table where you maintain your organization's working set of HTS codes. Use it to:

- Store codes you use frequently for fast lookup
- Record official descriptions and duty rates
- Organize by chapter/heading for browsing

| Field | Required | Meaning |
|---|---|---|
| `code` | yes | HTS code string (e.g. `6110.20.2090`). Unique per entity; locked after creation. Operator-supplied — no auto-generation. |
| `description` | yes | Official or operator description of the tariff category |
| `chapter` | no | Two-digit chapter (e.g. `61`) |
| `heading` | no | Four-digit heading (e.g. `6110`) |
| `duty_rate_pct` | no | General duty rate as a percentage (e.g. `16.5`) |
| `notes` | no | Free-form notes on this classification |
| `is_active` | yes (default `true`) | Inactive codes are hidden from active-only queries |
| `sort_order` | yes (default `0`) | Display ordering within the list |

## See also

- [Style Master (02-master-data.md)](02-master-data.md) — parent reference; the Fabrics subsection of the style edit modal is documented inline here.
- [`../P3-acc-core-architecture.md`](../P3-acc-core-architecture.md) §10 — schema rationale for the junction table and role enum.
- HTSUS official schedule: https://hts.usitc.gov
