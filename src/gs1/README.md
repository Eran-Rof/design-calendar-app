# GS1 Prepack Label Generation — Phase 1

## What this module does

Generates GS1 GTIN-14 labels for apparel prepack cartons.

**Core workflow:**
1. Configure your GS1 company prefix and GTIN numbering in Company Setup.
2. Optionally import child UPCs into the UPC Master (foundation for Phase 2 receiving).
3. Configure pack scale codes and size ratios in Scale Master.
4. Upload a packing list (.xlsx or .xls). The parser extracts style/color/channel/scale/qty blocks.
5. Generate Pack GTINs for every unique Style + Color + Scale combination found.
6. Create a Label Batch — specifying how many copies of each GTIN to print (= pack_qty from packing list).
7. Print (PDF via browser print dialog) or export CSV for BarTender/Zebra label software.

---

## Schema overview

| Table | Purpose |
|---|---|
| `company_settings` | GS1 prefix, indicator digit, item reference counter |
| `upc_item_master` | Child UPC → style/color/size mapping |
| `scale_master` | Pack scale codes (CA, CB, CD, …) |
| `scale_size_ratios` | Units per size within a scale |
| `pack_gtin_master` | One GTIN per unique style+color+scale |
| `pack_gtin_bom` | Pack composition (child UPCs per pack) — Phase 2 |
| `packing_list_uploads` | Uploaded packing list files |
| `packing_list_blocks` | Parsed rows (style/color/channel/scale/qty) |
| `parse_issues` | Parse warnings and errors |
| `label_batches` | Printable label batch headers |
| `label_batch_lines` | One line per GTIN with label_qty |

---

## How GTIN generation works

**GTIN-14 layout:**
```
[indicator_digit (1)][gs1_prefix (N)][item_reference (12-N)][check_digit (1)]
= 14 total digits
```

**Example** with prefix `0310927` (length 7), indicator `1`, item reference `1`:
```
indicator = 1
prefix    = 0310927   (7 digits)
item_ref  = 00001     (12-7=5 digits, left-padded)
base 13   = 1031092700001
check     = GS1 Mod-10 of base 13
GTIN-14   = 10310927000012   (example)
```

**GS1 Mod-10 check digit algorithm:**
- Assign position from right (position 1 = rightmost of 13 digits).
- Multiply: odd positions × 3, even positions × 1.
- Sum all products.
- Check digit = `(10 − (sum % 10)) % 10`

**Duplicate prevention:**
- The system checks for an existing GTIN for the same style/color/scale before claiming a counter value.
- The `gs1_claim_next_item_reference()` RPC atomically increments the counter in a single `FOR UPDATE` transaction — safe under concurrent writes.
- `pack_gtin_master` has a `UNIQUE` constraint on `(style_no, color, scale_code)` as a second safety layer.

**Item reference:**
- The "starting item reference" entered in Company Setup is the first number to use.
- The "next item reference counter" tracks the current position.
- Entering an item reference in Company Setup excludes the GS1 prefix and check digit — only the user-controlled portion.

---

## What Phase 1 supports

- Company / GS1 prefix setup
- UPC master import from Excel
- Scale code and size ratio management
- Packing list upload (.xlsx / .xls)
- Parser: block-style layouts, multiple sheets, style/color/scale/channel detection, confidence scoring, issue reporting
- Pack GTIN generation (one per style+color+scale, idempotent)
- Label batch creation with label_qty = pack_qty from packing list
- PDF print output (browser print dialog, 4×6 label layout)
- CSV export for BarTender / Zebra label software
- Database schema ready for Phase 2 (pack BOM, carton SSCC)

---

## What is left for Phase 2

- **Carton SSCC generation**: assign an SSCC-18 to each physical carton, link to label batch lines.
- **One-scan carton receiving**: scan a carton SSCC → automatically receive all GTINs in the carton at their BOM quantities.
- **Pack BOM population**: for each Pack GTIN, store which child UPCs are inside and in what quantity.
- **Xoro API integration**: sync UPCs from Xoro instead of manual Excel import; push received quantities back.
- **Barcode rendering**: replace monospace GTIN text with a rendered GS1-128 or ITF-14 barcode SVG.
- **Size scale matrix sheet parsing**: detect and import scale size ratios from a dedicated matrix sheet in the packing list workbook.
- **Per-user permissions**: add GS1 to the PLM user permission system if access control is needed.

---

## Navigation

Route: `/gs1`

Added as a card in the PLM launcher (🏷️ Prepack Labels).

Internal tabs: Company Setup → UPC Master → Scale Master → Pack GTINs → Packing List → Label Batches

---

## Testing GTIN generation

```bash
npm test -- src/gs1/__tests__/gtinService.test.ts
```

Key tests:
- Check digit calculation for known inputs
- GTIN-14 construction (length, padding, validation)
- Duplicate detection (same item ref → same GTIN)
- Edge cases (min/max item reference, all indicator digits)

## Testing packing list upload

1. Go to `/gs1` → Company Setup → fill in prefix and save.
2. Go to Packing List tab → upload your `.xlsx` packing list.
3. Verify parsed blocks appear in the table with style/color/scale/qty.
4. Click "Generate GTINs for All Parsed Rows".
5. Go to Label Batches → Create Batch → Print or Export CSV.
6. Check Pack GTINs tab to see all generated GTINs with validation checkmarks.
