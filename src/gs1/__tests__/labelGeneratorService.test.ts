import { describe, it, expect } from "vitest";
import {
  validateGtinLabel,
  validateSsccLabel,
  validateBatchForPrint,
  validateCartonsForPrint,
  generateGtinZpl,
  generateSsccZpl,
  generateBatchZpl,
  generateGtinCsvData,
  generateSsccCsvData,
  DEFAULT_GTIN_TEMPLATE,
  DEFAULT_SSCC_TEMPLATE,
} from "../services/labelGeneratorService";
import type { LabelBatchLine, Carton, LabelTemplate } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockLine: LabelBatchLine = {
  id: "line-1",
  batch_id: "batch-1",
  style_no: "100001",
  color: "BLK",
  scale_code: "CA",
  pack_gtin: "10310927000010",  // exactly 14 digits
  label_qty: 3,
  source_sheet_name: "Sheet1",
  source_channel: "MAJOR",
  label_type: "pack_gtin",
  sscc_first: null,
  sscc_last: null,
  carton_count: null,
  created_at: "2026-04-28T00:00:00Z",
};

const mockCarton: Carton = {
  id: "carton-1",
  sscc: "003109270000000017",   // exactly 18 digits
  serial_reference: 17,
  batch_id: "batch-1",
  batch_line_id: "line-1",
  upload_id: null,
  po_number: "PO-2001",
  carton_no: null,
  channel: "MAJOR",
  pack_gtin: "10310927000010",
  style_no: "100001",
  color: "BLK",
  scale_code: "CA",
  carton_seq: 1,
  total_packs: 5,
  total_units: 30,
  status: "generated",
  created_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
};

const zplTemplate: LabelTemplate = {
  id: "tmpl-zpl",
  label_type: "pack_gtin",
  template_name: "ZPL 4x6",
  label_width: "4",
  label_height: "6",
  printer_type: "zebra_zpl",
  barcode_format: "gtin14",
  human_readable_fields: {
    show_style: true, show_color: true, show_scale: true, show_channel: true,
    show_po: false, show_carton: false, show_units: false,
  },
  is_default: false,
  created_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
};

const ssccZplTemplate: LabelTemplate = {
  ...zplTemplate,
  id: "tmpl-sscc-zpl",
  label_type: "sscc",
  barcode_format: "sscc18",
  human_readable_fields: {
    show_style: true, show_color: true, show_scale: false, show_channel: false,
    show_po: true, show_carton: true, show_units: true,
  },
};

// ── validateGtinLabel ─────────────────────────────────────────────────────────

describe("validateGtinLabel", () => {
  it("returns [] for valid 14-digit GTIN and qty > 0", () => {
    expect(validateGtinLabel("10310927000010", 1)).toEqual([]);
  });

  it("errors on 13-digit GTIN", () => {
    const errs = validateGtinLabel("1031092700001", 1);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/14 digits/i);
  });

  it("errors on 15-digit GTIN", () => {
    const errs = validateGtinLabel("103109270000101", 1);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("errors on GTIN with non-digit characters", () => {
    const errs = validateGtinLabel("1031092700001X", 1);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("errors on qty = 0", () => {
    const errs = validateGtinLabel("10310927000010", 0);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/quantity/i);
  });

  it("errors on negative qty", () => {
    const errs = validateGtinLabel("10310927000010", -5);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("collects both GTIN and qty errors when both invalid", () => {
    const errs = validateGtinLabel("bad", 0);
    expect(errs.length).toBe(2);
  });
});

// ── validateSsccLabel ─────────────────────────────────────────────────────────

describe("validateSsccLabel", () => {
  it("returns [] for valid 18-digit SSCC", () => {
    expect(validateSsccLabel("003109270000000017")).toEqual([]);
  });

  it("errors on 17-digit SSCC", () => {
    const errs = validateSsccLabel("00310927000000017");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/18 digits/i);
  });

  it("errors on 19-digit SSCC", () => {
    expect(validateSsccLabel("0031092700000000171").length).toBeGreaterThan(0);
  });

  it("errors on SSCC with non-digit characters", () => {
    expect(validateSsccLabel("0031092700000000XY").length).toBeGreaterThan(0);
  });
});

// ── validateBatchForPrint / validateCartonsForPrint ────────────────────────────

describe("validateBatchForPrint", () => {
  it("returns [] for a batch with valid lines", () => {
    expect(validateBatchForPrint([mockLine])).toEqual([]);
  });

  it("returns errors when a line has an invalid GTIN", () => {
    const bad = { ...mockLine, pack_gtin: "BADGTIN123" };
    const errs = validateBatchForPrint([bad]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("GTIN");
  });

  it("returns errors when qty is 0", () => {
    const bad = { ...mockLine, label_qty: 0 };
    const errs = validateBatchForPrint([bad]);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("validateCartonsForPrint", () => {
  it("returns [] for a carton with valid SSCC", () => {
    expect(validateCartonsForPrint([mockCarton])).toEqual([]);
  });

  it("returns errors for carton with short SSCC", () => {
    const bad = { ...mockCarton, sscc: "00310927" };
    const errs = validateCartonsForPrint([bad]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("SSCC");
  });
});

// ── generateGtinZpl ───────────────────────────────────────────────────────────

describe("generateGtinZpl", () => {
  it("wraps output in ^XA / ^XZ", () => {
    const zpl = generateGtinZpl(mockLine, zplTemplate);
    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.endsWith("^XZ")).toBe(true);
  });

  it("includes the GTIN digits in the barcode field", () => {
    const zpl = generateGtinZpl(mockLine, zplTemplate);
    expect(zpl).toContain(mockLine.pack_gtin);
  });

  it("includes GS1-128 AI prefix >;01 for gtin14 format", () => {
    const zpl = generateGtinZpl(mockLine, zplTemplate);
    expect(zpl).toContain(">;01");
  });

  it("uses plain Code128 when barcode_format is code128", () => {
    const tmpl = { ...zplTemplate, barcode_format: "code128" };
    const zpl  = generateGtinZpl(mockLine, tmpl);
    expect(zpl).not.toContain(">;01");
    expect(zpl).toContain(mockLine.pack_gtin);
  });

  it("includes show_style text when show_style is true", () => {
    const zpl = generateGtinZpl(mockLine, zplTemplate);
    expect(zpl).toContain("Style:");
    expect(zpl).toContain(mockLine.style_no);
  });

  it("omits style text when show_style is false", () => {
    const tmpl = { ...zplTemplate, human_readable_fields: { ...zplTemplate.human_readable_fields!, show_style: false } };
    const zpl  = generateGtinZpl(mockLine, tmpl);
    expect(zpl).not.toContain("Style:");
  });

  it("includes ^PW / ^LL with dot values derived from label dimensions", () => {
    const zpl = generateGtinZpl(mockLine, zplTemplate);
    expect(zpl).toContain("^PW812");   // 4" × 203dpi
    expect(zpl).toContain("^LL1218");  // 6" × 203dpi
  });
});

// ── generateSsccZpl ───────────────────────────────────────────────────────────

describe("generateSsccZpl", () => {
  it("wraps output in ^XA / ^XZ", () => {
    const zpl = generateSsccZpl(mockCarton, ssccZplTemplate);
    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.endsWith("^XZ")).toBe(true);
  });

  it("includes SSCC digits", () => {
    const zpl = generateSsccZpl(mockCarton, ssccZplTemplate);
    expect(zpl).toContain(mockCarton.sscc);
  });

  it("includes GS1 AI (00) prefix for sscc18 barcode format", () => {
    const zpl = generateSsccZpl(mockCarton, ssccZplTemplate);
    expect(zpl).toContain(">;00");
  });

  it("shows human-readable (00) label", () => {
    const zpl = generateSsccZpl(mockCarton, ssccZplTemplate);
    expect(zpl).toContain("(00)");
  });
});

// ── generateBatchZpl ──────────────────────────────────────────────────────────

describe("generateBatchZpl", () => {
  it("repeats the label exactly label_qty times", () => {
    const line3 = { ...mockLine, label_qty: 3 };
    const zpl   = generateBatchZpl([line3], zplTemplate);
    const count = (zpl.match(/\^XA/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("concatenates multiple line types", () => {
    const lineA = { ...mockLine, id: "a", label_qty: 1 };
    const lineB = { ...mockLine, id: "b", label_qty: 2 };
    const zpl   = generateBatchZpl([lineA, lineB], zplTemplate);
    expect((zpl.match(/\^XA/g) ?? []).length).toBe(3);
  });
});

// ── CSV generation ────────────────────────────────────────────────────────────

describe("generateGtinCsvData", () => {
  it("has a header row with Pack GTIN column", () => {
    const csv = generateGtinCsvData([mockLine]);
    const rows = csv.split("\n");
    expect(rows[0]).toContain("Pack GTIN");
  });

  it("includes one data row per line", () => {
    const csv  = generateGtinCsvData([mockLine, mockLine]);
    const rows = csv.split("\n");
    expect(rows.length).toBe(3);  // header + 2 data rows
  });

  it("includes the GTIN value in the data row", () => {
    const csv = generateGtinCsvData([mockLine]);
    expect(csv).toContain(mockLine.pack_gtin);
  });
});

describe("generateSsccCsvData", () => {
  it("has a header row with SSCC column", () => {
    const csv = generateSsccCsvData([mockCarton]);
    expect(csv.split("\n")[0]).toContain("SSCC");
  });

  it("includes one data row per carton", () => {
    const csv = generateSsccCsvData([mockCarton, mockCarton]);
    expect(csv.split("\n").length).toBe(3);
  });

  it("includes the SSCC value and PO number", () => {
    const csv = generateSsccCsvData([mockCarton]);
    expect(csv).toContain(mockCarton.sscc);
    expect(csv).toContain("PO-2001");
  });
});

// ── Default templates ─────────────────────────────────────────────────────────

describe("DEFAULT_GTIN_TEMPLATE", () => {
  it("is a pack_gtin type template", () => {
    expect(DEFAULT_GTIN_TEMPLATE.label_type).toBe("pack_gtin");
  });
  it("uses gtin14 barcode format", () => {
    expect(DEFAULT_GTIN_TEMPLATE.barcode_format).toBe("gtin14");
  });
});

describe("DEFAULT_SSCC_TEMPLATE", () => {
  it("is an sscc type template", () => {
    expect(DEFAULT_SSCC_TEMPLATE.label_type).toBe("sscc");
  });
  it("uses sscc18 barcode format", () => {
    expect(DEFAULT_SSCC_TEMPLATE.barcode_format).toBe("sscc18");
  });
});
