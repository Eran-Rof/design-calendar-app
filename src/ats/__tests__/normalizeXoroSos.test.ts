import { describe, expect, it } from "vitest";
import { normalizeXoroSos, type XoroSoRecord } from "../normalizeXoroSos";

// Builder for the minimum-viable Xoro record shape — keeps the test
// terse without locking us into the full 100+ field surface.
function rec(over: {
  orderNumber?: string | null;
  customerFullName?: string | null;
  storeName?: string | null;
  saleStoreName?: string | null;
  headerShipDate?: string | null;
  headerCancelDate?: string | null;
  lines: Array<{
    sku?: string | null;
    qtyRemaining?: number | null;
    qtyOrdered?: number | null;
    qty?: number | null;
    unitPrice?: number | null;
    lineAmount?: number | null;
    lineShipDate?: string | null;
    lineCancelDate?: string | null;
  }>;
}): XoroSoRecord {
  return {
    SoEstimateHeader: {
      OrderNumber: over.orderNumber ?? null,
      CustomerFullName: over.customerFullName ?? null,
      StoreName: over.storeName ?? null,
      SaleStoreName: over.saleStoreName ?? null,
      DateToBeShipped: over.headerShipDate ?? null,
      CancelDate: over.headerCancelDate ?? null,
    },
    SoEstimateItemLineArr: over.lines.map((l) => ({
      ItemNumber: l.sku ?? null,
      QtyRemainingToShip: l.qtyRemaining ?? null,
      QtyOrdered: l.qtyOrdered ?? null,
      Qty: l.qty ?? null,
      UnitPrice: l.unitPrice ?? null,
      LineAmount: l.lineAmount ?? null,
      DateToBeShipped: l.lineShipDate ?? null,
      CancelDate: l.lineCancelDate ?? null,
    })),
  };
}

describe("normalizeXoroSos", () => {
  it("flattens header+lines into one event per line", () => {
    const records = [
      rec({
        orderNumber: "PBPT-S000426",
        customerFullName: "LITTLE PELICAN",
        storeName: "Psycho Tuna",
        headerShipDate: "02/03/2025",
        lines: [
          { sku: "PTYB0206-Moonless-S", qtyRemaining: 1, unitPrice: 26, lineAmount: 26 },
          { sku: "PTYB0206-Moonless-M", qtyRemaining: 2, unitPrice: 26, lineAmount: 52 },
        ],
      }),
    ];
    const { events } = normalizeXoroSos(records);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      sku: "PTYB0206-Moonless-S",
      date: "2025-02-03",
      qty: 1,
      orderNumber: "PBPT-S000426",
      customerName: "LITTLE PELICAN",
      unitPrice: 26,
      totalPrice: 26,
      store: "Psycho Tuna",
    });
    expect(events[1].qty).toBe(2);
  });

  it("prefers QtyRemainingToShip over QtyOrdered (the 'open' qty)", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 3, qtyOrdered: 10, qty: 10 }],
      }),
    ]);
    expect(events[0].qty).toBe(3);
  });

  it("falls back to QtyOrdered when QtyRemainingToShip is null", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: null, qtyOrdered: 7, qty: 10 }],
      }),
    ]);
    expect(events[0].qty).toBe(7);
  });

  it("uses line-level ship date over header when both present", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 1, lineShipDate: "03/20/2026" }],
      }),
    ]);
    expect(events[0].date).toBe("2026-03-20");
  });

  it("falls back to header ship date when line date is missing", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 1, lineShipDate: null }],
      }),
    ]);
    expect(events[0].date).toBe("2026-01-15");
  });

  it("computes totalPrice from unitPrice*qty when LineAmount missing", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 4, unitPrice: 12.5, lineAmount: null }],
      }),
    ]);
    expect(events[0].totalPrice).toBe(50);
  });

  it("prefers StoreName (clean) over SaleStoreName (prefixed)", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "Psycho Tuna",
        saleStoreName: "Prebook - Psycho Tuna",
        headerShipDate: "01/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 1 }],
      }),
    ]);
    expect(events[0].store).toBe("Psycho Tuna");
  });

  it("extracts header-level CancelDate onto every line", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "08/15/2026",
        headerCancelDate: "06/01/2026",
        lines: [
          { sku: "AAA-RED-L", qtyRemaining: 1 },
          { sku: "AAA-RED-XL", qtyRemaining: 2 },
        ],
      }),
    ]);
    expect(events[0].cancelDate).toBe("2026-06-01");
    expect(events[1].cancelDate).toBe("2026-06-01");
  });

  it("prefers line-level CancelDate over header CancelDate", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "08/15/2026",
        headerCancelDate: "06/01/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 1, lineCancelDate: "05/20/2026" }],
      }),
    ]);
    expect(events[0].cancelDate).toBe("2026-05-20");
  });

  it("leaves cancelDate undefined when neither header nor line provides one", () => {
    const { events } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "08/15/2026",
        lines: [{ sku: "AAA-RED-L", qtyRemaining: 1 }],
      }),
    ]);
    expect(events[0].cancelDate).toBeUndefined();
  });

  it("skips lines with no SKU, no date, or zero qty and reports counts", () => {
    const { events, skipped } = normalizeXoroSos([
      rec({
        orderNumber: "S1",
        customerFullName: "X",
        storeName: "PT",
        headerShipDate: "01/15/2026",
        lines: [
          { sku: "", qtyRemaining: 1 },             // no SKU
          { sku: "GOOD-RED-S", qtyRemaining: 0 },    // zero qty
          { sku: "GOOD-RED-M", qtyRemaining: 1 },    // ok
        ],
      }),
      rec({
        orderNumber: "S2",
        customerFullName: "Y",
        storeName: "PT",
        headerShipDate: null,                        // no date anywhere
        lines: [{ sku: "GOOD-RED-L", qtyRemaining: 1, lineShipDate: null }],
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].sku).toBe("GOOD-RED-M");
    expect(skipped).toEqual({ noSku: 1, noDate: 1, zeroQty: 1 });
  });
});
