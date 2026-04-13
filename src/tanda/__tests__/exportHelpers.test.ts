import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportPOExcel } from "../exportHelpers";
import type { XoroPO, Milestone, LocalNote } from "../../utils/tandaTypes";

// ── XLSX mock ────────────────────────────────────────────────────────────────
// Captures the data passed through the XLSX pipeline so we can assert on
// the assembled rows without needing a real spreadsheet library.

function createXLSXMock() {
  const sheets: { name: string; data: any[][] }[] = [];
  let lastWriteFilename = "";

  const XLSX = {
    utils: {
      aoa_to_sheet: (data: any[][]) => {
        // Return a minimal sheet object the styling code can work with
        const ref = `A1:${String.fromCharCode(65 + (data[0]?.length ?? 1) - 1)}${data.length}`;
        const sheet: Record<string, any> = { "!ref": ref, _rawData: data };
        // Populate cells so the styling loop doesn't crash
        data.forEach((row, r) => {
          row.forEach((val: any, c: number) => {
            const addr = XLSX.utils.encode_cell({ r, c });
            sheet[addr] = { v: val, t: typeof val === "number" ? "n" : "s" };
          });
        });
        return sheet;
      },
      book_new: () => ({ Sheets: {}, SheetNames: [] }),
      book_append_sheet: (wb: any, sheet: any, name: string) => {
        wb.Sheets[name] = sheet;
        wb.SheetNames.push(name);
        sheets.push({ name, data: sheet._rawData });
      },
      decode_range: (ref: string) => {
        const [start, end] = ref.split(":");
        const s = XLSX.utils.decode_cell_internal(start);
        const e = XLSX.utils.decode_cell_internal(end);
        return { s, e };
      },
      encode_cell: ({ r, c }: { r: number; c: number }) => {
        return String.fromCharCode(65 + c) + (r + 1);
      },
      decode_cell_internal: (addr: string) => {
        const c = addr.charCodeAt(0) - 65;
        const r = parseInt(addr.slice(1), 10) - 1;
        return { r, c };
      },
    },
    writeFile: (_wb: any, filename: string) => {
      lastWriteFilename = filename;
    },
  };

  return { XLSX, sheets, getFilename: () => lastWriteFilename };
}

// ── Factories ────────────────────────────────────────────────────────────────

function makePO(overrides: Partial<XoroPO> = {}): XoroPO {
  return {
    PoNumber: "PO-100",
    VendorName: "Test Vendor",
    DateOrder: "2026-01-15",
    DateExpectedDelivery: "2026-06-01",
    StatusName: "Open",
    CurrencyCode: "USD",
    Memo: "",
    PaymentTermsName: "Net 30",
    ShipMethodName: "Ocean",
    BuyerName: "Jane",
    ...overrides,
  };
}

function makeItem(sku: string, qty: number, price: number, desc = "") {
  return { ItemNumber: sku, Description: desc, QtyOrder: qty, UnitPrice: price };
}

function makeMs(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: "ms_1",
    po_number: "PO-100",
    phase: "Lab Dip",
    category: "Pre-Production",
    sort_order: 0,
    days_before_ddp: 120,
    expected_date: "2026-02-01",
    actual_date: null,
    status: "Not Started",
    status_date: null,
    status_dates: null,
    notes: "",
    note_entries: null,
    variant_statuses: null,
    updated_at: "",
    updated_by: "",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("exportPOExcel", () => {
  let xlsxMock: ReturnType<typeof createXLSXMock>;

  beforeEach(() => {
    xlsxMock = createXLSXMock();
    (globalThis as any).window = { XLSX: xlsxMock.XLSX };
  });

  it("throws when XLSX is not loaded", () => {
    (globalThis as any).window = {};
    expect(() => exportPOExcel(makePO(), [], "po", {}, [])).toThrow("Excel library still loading");
  });

  it("throws for an unknown export mode", () => {
    expect(() => exportPOExcel(makePO(), [], "bogus_mode", {}, [])).toThrow("Excel export not available");
  });

  // ── mode: "po" (Matrix + Line Items) ──────────────────────────────────────

  describe('mode "po" — Matrix + Line Items', () => {
    it("creates Matrix and Line Items sheets", () => {
      const items = [
        makeItem("STYLE1-RED-BLK-Small", 10, 5.0, "Red/Black Small"),
        makeItem("STYLE1-RED-BLK-Medium", 20, 5.0, "Red/Black Medium"),
        makeItem("STYLE1-BLU-WHT-Small", 15, 6.0, "Blue/White Small"),
      ];
      exportPOExcel(makePO(), items, "po", {}, []);
      const names = xlsxMock.sheets.map(s => s.name);
      expect(names).toContain("Matrix");
      expect(names).toContain("Line Items");
    });

    it("writes correct filename", () => {
      exportPOExcel(makePO({ PoNumber: "PO-999" }), [makeItem("X-A-S", 1, 1)], "po", {}, []);
      expect(xlsxMock.getFilename()).toBe("PO-999_PO_Details.xlsx");
    });

    it("builds the matrix with correct size columns and totals", () => {
      const items = [
        makeItem("BASE-CLR-Small", 10, 5.0),
        makeItem("BASE-CLR-Medium", 20, 5.0),
      ];
      exportPOExcel(makePO(), items, "po", {}, []);
      const matrix = xlsxMock.sheets.find(s => s.name === "Matrix")!;
      // The raw data has PO info header rows + blank + data rows
      // Find the data rows (after the PO info block)
      const allData = matrix.data;
      // The header row of the actual table
      const headerRow = allData.find((r: any[]) => r[0] === "Base Part");
      expect(headerRow).toBeDefined();
      expect(headerRow).toContain("Small");
      expect(headerRow).toContain("Medium");
      expect(headerRow).toContain("Total");
      expect(headerRow).toContain("PO Cost");
      expect(headerRow).toContain("Total Cost");
    });

    it("calculates line item totals correctly", () => {
      const items = [
        makeItem("SKU-A", 10, 2.5),
        makeItem("SKU-B", 4, 10.0),
      ];
      exportPOExcel(makePO(), items, "po", {}, []);
      const lineSheet = xlsxMock.sheets.find(s => s.name === "Line Items")!;
      const totalRow = lineSheet.data[lineSheet.data.length - 1];
      // Grand total = 10*2.5 + 4*10 = 65
      expect(totalRow).toContain("TOTAL");
      // Total qty = 14
      expect(totalRow).toContain(14);
      // Total value = 65
      expect(totalRow).toContain(65);
    });

    it("handles items with no size component (2-part SKU)", () => {
      const items = [makeItem("PART-COLOR", 5, 3.0)];
      exportPOExcel(makePO(), items, "po", {}, []);
      const matrix = xlsxMock.sheets.find(s => s.name === "Matrix")!;
      expect(matrix).toBeDefined();
    });
  });

  // ── mode: "milestones" ────────────────────────────────────────────────────

  describe('mode "milestones"', () => {
    it("creates a Milestones sheet with correct rows", () => {
      const ms: Record<string, Milestone[]> = {
        "PO-100": [
          makeMs({ phase: "Lab Dip", status: "Complete", expected_date: "2026-02-01" }),
          makeMs({ phase: "Trims", status: "In Progress", expected_date: "2026-03-01" }),
        ],
      };
      exportPOExcel(makePO(), [], "milestones", ms, []);
      const sheet = xlsxMock.sheets.find(s => s.name === "Milestones")!;
      expect(sheet).toBeDefined();
      // Header + 2 data rows
      const headerRow = sheet.data.find((r: any[]) => r[0] === "Category");
      expect(headerRow).toBeDefined();
      // Data rows
      const dataRows = sheet.data.filter((r: any[]) => r[1] === "Lab Dip" || r[1] === "Trims");
      expect(dataRows).toHaveLength(2);
    });

    it("writes correct filename for milestones mode", () => {
      exportPOExcel(makePO({ PoNumber: "PO-42" }), [], "milestones", { "PO-42": [] }, []);
      expect(xlsxMock.getFilename()).toBe("PO-42_Milestones.xlsx");
    });

    it("handles PO with no milestones", () => {
      exportPOExcel(makePO(), [], "milestones", {}, []);
      const sheet = xlsxMock.sheets.find(s => s.name === "Milestones")!;
      expect(sheet).toBeDefined();
      // Only header row in the data table portion
      const headerRow = sheet.data.find((r: any[]) => r[0] === "Category");
      expect(headerRow).toBeDefined();
    });
  });

  // ── mode: "notes" ─────────────────────────────────────────────────────────

  describe('mode "notes"', () => {
    it("creates a Notes sheet filtered to the PO", () => {
      const notes: LocalNote[] = [
        { id: "n1", po_number: "PO-100", note: "First note", created_at: "2026-01-10", user_name: "Alice" },
        { id: "n2", po_number: "PO-200", note: "Other PO", created_at: "2026-01-11", user_name: "Bob" },
        { id: "n3", po_number: "PO-100", note: "Second note", created_at: "2026-01-12", user_name: "Carol" },
      ];
      exportPOExcel(makePO(), [], "notes", {}, notes);
      const sheet = xlsxMock.sheets.find(s => s.name === "Notes")!;
      expect(sheet).toBeDefined();
      // Should only include notes for PO-100 (2 notes, not the PO-200 one)
      const noteRows = sheet.data.filter((r: any[]) => r[2] === "First note" || r[2] === "Second note" || r[2] === "Other PO");
      expect(noteRows).toHaveLength(2);
    });

    it("writes correct filename", () => {
      exportPOExcel(makePO({ PoNumber: "PO-55" }), [], "notes", {}, []);
      expect(xlsxMock.getFilename()).toBe("PO-55_Notes.xlsx");
    });
  });

  // ── mode: "all" ───────────────────────────────────────────────────────────

  describe('mode "all"', () => {
    it("creates Line Items + Milestones sheets when milestones exist", () => {
      const items = [makeItem("SKU-A", 5, 2.0)];
      const ms: Record<string, Milestone[]> = {
        "PO-100": [makeMs({ phase: "Lab Dip" })],
      };
      exportPOExcel(makePO(), items, "all", ms, []);
      const names = xlsxMock.sheets.map(s => s.name);
      expect(names).toContain("Line Items");
      expect(names).toContain("Milestones");
    });

    it("omits Milestones sheet when there are no milestones for the PO", () => {
      const items = [makeItem("SKU-A", 5, 2.0)];
      exportPOExcel(makePO(), items, "all", {}, []);
      const names = xlsxMock.sheets.map(s => s.name);
      expect(names).toContain("Line Items");
      expect(names).not.toContain("Milestones");
    });

    it("writes correct filename", () => {
      exportPOExcel(makePO({ PoNumber: "PO-ALL" }), [], "all", {}, []);
      expect(xlsxMock.getFilename()).toBe("PO-ALL_All.xlsx");
    });
  });

  // ── PO info block ─────────────────────────────────────────────────────────

  describe("PO info header block", () => {
    it("includes vendor name and PO number in the first row of all sheets", () => {
      exportPOExcel(makePO({ PoNumber: "PO-HDR", VendorName: "AcmeCo" }), [makeItem("X", 1, 1)], "po", {}, []);
      const matrix = xlsxMock.sheets.find(s => s.name === "Matrix")!;
      // First row of raw data is title row
      expect(matrix.data[0][0]).toContain("AcmeCo");
      expect(matrix.data[0][0]).toContain("PO-HDR");
    });

    it("includes Memo row when PO has a memo", () => {
      exportPOExcel(makePO({ Memo: "Rush order" }), [makeItem("X", 1, 1)], "po", {}, []);
      const matrix = xlsxMock.sheets.find(s => s.name === "Matrix")!;
      const memoRow = matrix.data.find((r: any[]) => r[0] === "Memo");
      expect(memoRow).toBeDefined();
      expect(memoRow![1]).toBe("Rush order");
    });
  });
});
