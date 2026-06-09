import { describe, it, expect } from "vitest";
import { buildPOWorkbook } from "../exportHelpers";
import type { XoroPO, Milestone, LocalNote } from "../../utils/tandaTypes";
import type { ExcelJS } from "../../shared/excelLogo";

// ── Helpers ──────────────────────────────────────────────────────────────────
// Extract a worksheet's cell values as a 0-based 2D array so we can scan for
// the table header / total / info rows regardless of the logo-banner offset.
function rowsOf(ws: ExcelJS.Worksheet): any[][] {
  const out: any[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const vals: any[] = [];
    const v = row.values as any[]; // 1-indexed
    for (let c = 1; c < v.length; c++) vals.push(v[c]);
    out.push(vals);
  });
  return out;
}
const sheetNames = (wb: ExcelJS.Workbook) => wb.worksheets.map((w) => w.name);
const findRow = (ws: ExcelJS.Worksheet, pred: (r: any[]) => boolean) => rowsOf(ws).find(pred);

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
  } as Milestone;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("buildPOWorkbook", () => {
  it("throws for an unknown export mode", () => {
    expect(() => buildPOWorkbook(makePO(), [], "bogus_mode", {}, [])).toThrow("Excel export not available");
  });

  describe('mode "po" — Matrix + Line Items', () => {
    it("creates Matrix and Line Items sheets", async () => {
      const items = [
        makeItem("STYLE1-RED-BLK-Small", 10, 5.0, "Red/Black Small"),
        makeItem("STYLE1-RED-BLK-Medium", 20, 5.0, "Red/Black Medium"),
        makeItem("STYLE1-BLU-WHT-Small", 15, 6.0, "Blue/White Small"),
      ];
      const { wb } = await buildPOWorkbook(makePO(), items, "po", {}, []);
      expect(sheetNames(wb)).toContain("Matrix");
      expect(sheetNames(wb)).toContain("Line Items");
    });

    it("produces the correct filename", async () => {
      const { fileName } = await buildPOWorkbook(makePO({ PoNumber: "PO-999" }), [makeItem("X-A-S", 1, 1)], "po", {}, []);
      expect(fileName).toBe("PO-999_PO_Details.xlsx");
    });

    it("builds the matrix with correct size columns and totals", async () => {
      const items = [makeItem("BASE-CLR-Small", 10, 5.0), makeItem("BASE-CLR-Medium", 20, 5.0)];
      const { wb } = await buildPOWorkbook(makePO(), items, "po", {}, []);
      const matrix = wb.getWorksheet("Matrix")!;
      const headerRow = findRow(matrix, (r) => r[0] === "Base Part");
      expect(headerRow).toBeDefined();
      expect(headerRow).toContain("Small");
      expect(headerRow).toContain("Medium");
      expect(headerRow).toContain("Total");
      expect(headerRow).toContain("PO Cost");
      expect(headerRow).toContain("Total Cost");
    });

    it("calculates line item totals correctly", async () => {
      const items = [makeItem("SKU-A", 10, 2.5), makeItem("SKU-B", 4, 10.0)];
      const { wb } = await buildPOWorkbook(makePO(), items, "po", {}, []);
      const lineSheet = wb.getWorksheet("Line Items")!;
      const totalRow = findRow(lineSheet, (r) => r.includes("TOTAL"));
      expect(totalRow).toBeDefined();
      expect(totalRow).toContain(14); // total qty
      expect(totalRow).toContain(65); // 10*2.5 + 4*10
    });

    it("handles items with no size component (2-part SKU)", async () => {
      const { wb } = await buildPOWorkbook(makePO(), [makeItem("PART-COLOR", 5, 3.0)], "po", {}, []);
      expect(wb.getWorksheet("Matrix")).toBeDefined();
    });
  });

  describe('mode "milestones"', () => {
    it("creates a Milestones sheet with correct rows", async () => {
      const ms: Record<string, Milestone[]> = {
        "PO-100": [
          makeMs({ phase: "Lab Dip", status: "Complete", expected_date: "2026-02-01" }),
          makeMs({ phase: "Trims", status: "In Progress", expected_date: "2026-03-01" }),
        ],
      };
      const { wb } = await buildPOWorkbook(makePO(), [], "milestones", ms, []);
      const ws = wb.getWorksheet("Milestones")!;
      expect(findRow(ws, (r) => r[0] === "Category")).toBeDefined();
      const dataRows = rowsOf(ws).filter((r) => r[1] === "Lab Dip" || r[1] === "Trims");
      expect(dataRows).toHaveLength(2);
    });

    it("produces the correct filename for milestones mode", async () => {
      const { fileName } = await buildPOWorkbook(makePO({ PoNumber: "PO-42" }), [], "milestones", { "PO-42": [] }, []);
      expect(fileName).toBe("PO-42_Milestones.xlsx");
    });

    it("handles PO with no milestones", async () => {
      const { wb } = await buildPOWorkbook(makePO(), [], "milestones", {}, []);
      const ws = wb.getWorksheet("Milestones")!;
      expect(findRow(ws, (r) => r[0] === "Category")).toBeDefined();
    });
  });

  describe('mode "notes"', () => {
    it("creates a Notes sheet filtered to the PO", async () => {
      const notes: LocalNote[] = [
        { id: "n1", po_number: "PO-100", note: "First note", created_at: "2026-01-10", user_name: "Alice" } as any,
        { id: "n2", po_number: "PO-200", note: "Other PO", created_at: "2026-01-11", user_name: "Bob" } as any,
        { id: "n3", po_number: "PO-100", note: "Second note", created_at: "2026-01-12", user_name: "Carol" } as any,
      ];
      const { wb } = await buildPOWorkbook(makePO(), [], "notes", {}, notes);
      const ws = wb.getWorksheet("Notes")!;
      const noteRows = rowsOf(ws).filter((r) => r[2] === "First note" || r[2] === "Second note" || r[2] === "Other PO");
      expect(noteRows).toHaveLength(2);
    });

    it("produces the correct filename", async () => {
      const { fileName } = await buildPOWorkbook(makePO({ PoNumber: "PO-55" }), [], "notes", {}, []);
      expect(fileName).toBe("PO-55_Notes.xlsx");
    });
  });

  describe('mode "all"', () => {
    it("creates Line Items + Milestones sheets when milestones exist", async () => {
      const ms: Record<string, Milestone[]> = { "PO-100": [makeMs({ phase: "Lab Dip" })] };
      const { wb } = await buildPOWorkbook(makePO(), [makeItem("SKU-A", 5, 2.0)], "all", ms, []);
      expect(sheetNames(wb)).toContain("Line Items");
      expect(sheetNames(wb)).toContain("Milestones");
    });

    it("omits Milestones sheet when there are no milestones for the PO", async () => {
      const { wb } = await buildPOWorkbook(makePO(), [makeItem("SKU-A", 5, 2.0)], "all", {}, []);
      expect(sheetNames(wb)).toContain("Line Items");
      expect(sheetNames(wb)).not.toContain("Milestones");
    });

    it("produces the correct filename", async () => {
      const { fileName } = await buildPOWorkbook(makePO({ PoNumber: "PO-ALL" }), [], "all", {}, []);
      expect(fileName).toBe("PO-ALL_All.xlsx");
    });
  });

  describe("PO info header block", () => {
    it("includes vendor name and PO number in the title banner of all sheets", async () => {
      const { wb } = await buildPOWorkbook(makePO({ PoNumber: "PO-HDR", VendorName: "AcmeCo" }), [makeItem("X", 1, 1)], "po", {}, []);
      const matrix = wb.getWorksheet("Matrix")!;
      const titleRow = findRow(matrix, (r) => r.some((v) => typeof v === "string" && v.includes("AcmeCo") && v.includes("PO-HDR")));
      expect(titleRow).toBeDefined();
    });

    it("includes Memo row when PO has a memo", async () => {
      const { wb } = await buildPOWorkbook(makePO({ Memo: "Rush order" }), [makeItem("X", 1, 1)], "po", {}, []);
      const matrix = wb.getWorksheet("Matrix")!;
      const memoRow = findRow(matrix, (r) => r[0] === "Memo");
      expect(memoRow).toBeDefined();
      expect(memoRow![1]).toBe("Rush order");
    });
  });
});
