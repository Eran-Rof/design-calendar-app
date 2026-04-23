# GS1 Prepack Label Generation — Phase 1 + SSCC

## What this module does

Generates GS1 GTIN-14 pack labels and SSCC-18 carton labels for apparel prepack shipments.

**Core workflow:**
1. Configure your GS1 company prefix, GTIN numbering, and SSCC numbering in Company Setup.
2. Optionally import child UPCs into the UPC Master (foundation for Phase 2 receiving).
3. Configure pack scale codes and size ratios in Scale Master.
4. Upload a packing list (.xlsx or .xls). The parser extracts style/color/channel/scale/qty blocks.
5. Generate Pack GTINs for every unique Style + Color + Scale combination found.
6. Create a Label Batch — choose **GTIN Only**, **SSCC Only**, or **GTIN + SSCC** mode.
   - GTIN labels: one per pack (label_qty = pack_qty from packing list).
   - SSCC labels: one per physical carton; serial references are reserved atomically.
7. Print (PDF via browser print dialog) or export CSV for BarTender/Zebra label software.
8. For standalone carton SSCC creation: use the **Carton Labels** tab.

---

## GTIN vs SSCC — what's the difference?

| Concept | GTIN-14 | SSCC-18 |
|---|---|---|
| Identifies | A **style/color/scale pack** (product type) | A **physical carton** (shipping unit) |
| Digits | 14 | 18 |
| Layout | Indicator + GS1 Prefix + Item Reference + Check | Extension + GS1 Prefix + Serial Reference + Check |
| Counter | `next_item_reference_counter` | `sscc_next_serial_reference_counter` |
| Uniqueness | Same style/color/scale always reuses the same GTIN | Each carton gets a unique, never-reused serial |
| Barcode format | ITF-14 or GS1-128 (02) | GS1-128 with AI (00) |

---

## Schema overview

| Table | Purpose |
|---|---|
| `company_settings` | GS1 prefix, indicator digit, GTIN counter, SSCC extension digit, SSCC counter |
| `upc_item_master` | Child UPC → style/color/size mapping |
| `scale_master` | Pack scale codes (CA, CB, CD, …) |
| `scale_size_ratios` | Units per size within a scale |
| `pack_gtin_master` | One GTIN per unique style+color+scale |
| `pack_gtin_bom` | Pack composition (child UPCs per pack) — Phase 2 |
| `packing_list_uploads` | Uploaded packing list files |
| `packing_list_blocks` | Parsed rows (style/color/channel/scale/qty) |
| `parse_issues` | Parse warnings and errors |
| `label_batches` | Printable label batch headers — includes `label_mode` |
| `label_batch_lines` | One line per GTIN with label_qty, sscc_first, sscc_last |
| `cartons` | One row per physical carton — unique SSCC, links batch/upload, stores PO/carton# |
| `carton_contents` | BOM explosion per carton — pack GTIN, style/color/scale, pack qty, exploded unit qty |

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

---

## How SSCC generation works

**SSCC-18 layout:**
```
[extension_digit (1)][gs1_prefix (N)][serial_reference (16-N)][check_digit (1)]
= 18 total digits
```

**Example** with prefix `0310927` (length 7), extension `0`, serial reference `1`:
```
extension = 0
prefix    = 0310927    (7 digits)
serial    = 000000001  (16-7=9 digits, left-padded)
base 17   = 00310927000000001
check     = GS1 Mod-10 of base 17
SSCC-18   = 003109270000000017  (example)
```

**Key rules:**
- The base before the check digit must be exactly **17 digits**.
- The final SSCC must be exactly **18 digits**.
- Serial reference is left-padded with zeros to fill `16 - prefix_length` digits.
- The "starting serial reference" entered in Company Setup is the first serial number to use.
  It **excludes** the GS1 prefix and check digit — only the user-controlled serial portion.
- Each carton gets a unique, monotonically-increasing serial reference. Reuse is prevented by
  the `sscc_claim_serial_range` and `sscc_claim_one_serial` RPCs, which atomically increment
  the counter under a `FOR UPDATE` lock.

**GS1 Mod-10 check digit algorithm (shared by GTIN and SSCC):**
- Assign position from right (position 1 = rightmost digit of the base).
- Multiply: odd positions from right × 3, even positions × 1.
- Sum all products.
- Check digit = `(10 − (sum % 10)) % 10`

---

## Label modes

When creating a batch from a parsed packing list you choose one of three modes:

| Mode | What gets generated |
|---|---|
| `pack_gtin` | GTIN labels only — one per pack (label_qty copies) |
| `sscc` | SSCC carton labels only — one per physical carton |
| `both` | Both GTIN and SSCC — cartons with their pack GTIN contents |

For SSCC modes, serial references are claimed in bulk via `sscc_claim_serial_range(count)` —
one DB call per batch line — and SSCCs are built locally. This keeps DB round-trips minimal
even for batches with thousands of cartons.

---

## Carton Labels tab

For standalone (non-batch) carton SSCC generation:
1. Go to **Carton Labels** tab.
2. Optionally link to an existing packing list upload.
3. Enter PO#, carton number, channel, style, color, pack and unit totals.
4. Click **Create Carton & Generate SSCC**.
5. The SSCC is displayed and stored; the serial counter is atomically incremented.

---

## Future receiving foundation

The `cartons` and `carton_contents` tables are designed for future one-scan carton receiving:
- Scan SSCC → look up carton row → explode `carton_contents` to pack GTINs and child UPCs.
- `carton_contents.exploded_unit_qty = pack_qty × scale.total_units` (stored at creation when BOM is available).
- Full receiving posting (sync to Xoro) is Phase 2.

---

## Navigation

Route: `/gs1`

Added as a card in the PLM launcher (🏷️ Prepack Labels).

Internal tabs:
- Company Setup
- UPC Master
- Scale Master
- Pack GTINs
- Packing List
- Label Batches
- **Carton Labels** ← new

---

## Running tests

```bash
# GTIN tests
npm test -- src/gs1/__tests__/gtinService.test.ts

# SSCC tests
npm test -- src/gs1/__tests__/ssccService.test.ts

# All GS1 tests
npm test -- src/gs1/__tests__/
```

### SSCC test coverage

- Check digit calculation correctness (validated against GS1 algorithm)
- SSCC length always = 18
- Base-17 length always = 17
- Serial padding for prefix lengths 6, 7, 8, 9
- Duplicate prevention: same serial → same SSCC (deterministic)
- Uniqueness: 100 consecutive serials produce 100 distinct SSCCs
- Counter increment: serial N and N+1 always differ
- Boundary: max serial reference for each prefix length
- Error cases: bad extension digit, prefix mismatch, serial overflow

### Manual test steps

1. Go to `/gs1` → Company Setup → fill SSCC extension digit (e.g. `0`), starting serial reference (e.g. `1`), save.
2. Go to **Carton Labels** tab → fill PO# and carton# → click Create.
3. Verify SSCC appears (18 digits, validates with GS1 Mod-10).
4. Repeat → verify each SSCC has a different serial reference.
5. Go to **Packing List** tab → upload a packing list.
6. Go to **Label Batches** → select **GTIN + SSCC** mode → Create Batch.
7. Verify batch lines show SSCC First and SSCC Last columns.
8. Click **Print SSCC Labels** → verify 4×6 label popup with (00) prefix.
9. Click **↓ SSCC CSV** → verify CSV has one row per carton.
