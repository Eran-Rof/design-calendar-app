import { describe, it, expect } from "vitest";
import {
  isValidContainerNumber,
  mapShipment,
  mapEvents,
  type SearatesResponse,
} from "../shipmentUtils";

describe("isValidContainerNumber (ISO 6346)", () => {
  it("accepts known valid container numbers", () => {
    // These are real examples from Searates documentation + public carrier data.
    expect(isValidContainerNumber("MSKU1234567")).toBe(false); // placeholder — real below
    // Verified-valid examples:
    expect(isValidContainerNumber("ECMU7336714")).toBe(true);
    expect(isValidContainerNumber("MRKU7181100")).toBe(true);
    expect(isValidContainerNumber("CSQU3054383")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isValidContainerNumber("ecmu7336714")).toBe(true);
    expect(isValidContainerNumber("  ECMU 7336714 ")).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(isValidContainerNumber("ECMU733671")).toBe(false);  // 10
    expect(isValidContainerNumber("ECMU73367140")).toBe(false); // 12
    expect(isValidContainerNumber("")).toBe(false);
  });

  it("rejects wrong shape", () => {
    expect(isValidContainerNumber("1234ECMU567")).toBe(false); // digits first
    expect(isValidContainerNumber("ECM17336714")).toBe(false); // digit in letters
    expect(isValidContainerNumber("ECMU733671A")).toBe(false); // letter in digits
  });

  it("rejects bad checksum", () => {
    // Last digit flipped to something that breaks the check
    expect(isValidContainerNumber("ECMU7336715")).toBe(false);
    expect(isValidContainerNumber("MRKU7181101")).toBe(false);
  });

  it("rejects non-string input gracefully", () => {
    expect(isValidContainerNumber(null as unknown as string)).toBe(false);
    expect(isValidContainerNumber(undefined as unknown as string)).toBe(false);
    expect(isValidContainerNumber(12345 as unknown as string)).toBe(false);
  });
});

// A compact fixture matching the real Searates /tracking response shape.
const fixture: SearatesResponse = {
  status: "success",
  message: "OK",
  data: {
    metadata: {
      type: "BL",
      number: "HKA2573372",
      sealine: "CMDU",
      sealine_name: "CMA CGM",
      status: "IN_TRANSIT",
      updated_at: "2025-10-31 09:00:25",
    },
    locations: [
      { id: 1, name: "San Antonio", locode: "CLSAI" },
      { id: 2, name: "Shanghai", locode: "CNSHG" },
      { id: 3, name: "Shekou", locode: "CNSHK" },
    ],
    facilities: [
      { id: 1, name: "Mawan Container Terminal", locode: "CNSHK" },
      { id: 2, name: "Yangshan Deep Water Port", locode: "CNSGH" },
    ],
    route: {
      prepol: { location: 3, date: "2025-09-13 01:01:00", actual: true },
      pol: { location: 3, date: "2025-09-30 03:32:00", actual: true },
      pod: { location: 1, date: "2025-10-31 23:00:00", actual: false },
      postpod: { location: null, date: null, actual: null },
    },
    containers: [
      {
        number: "ECMU7336714",
        iso_code: "45G1",
        size_type: "40' High Cube Dry",
        status: "IN_TRANSIT",
        events: [
          {
            order_id: 1,
            location: 3,
            facility: 1,
            description: "Empty Picked-up at Depot",
            event_type: "EQUIPMENT",
            event_code: "PICK",
            status: "CPS",
            date: "2025-09-13 01:29:00",
            actual: true,
          },
          {
            order_id: 2,
            location: 3,
            facility: null,
            description: "Gate in at POL",
            event_type: "TRANSPORT",
            event_code: "GTIN",
            status: "CGI",
            date: "2025-09-29 18:00:00",
            actual: true,
          },
          {
            order_id: 10,
            location: 1,
            facility: null,
            description: "Arrive at POD",
            event_type: "TRANSPORT",
            event_code: "ARRI",
            status: "LTS",
            date: "2025-10-31 23:00:00",
            actual: false,
          },
        ],
      },
    ],
  },
};

describe("mapShipment", () => {
  it("collapses the response metadata + route into a shipment row", () => {
    const row = mapShipment(fixture);
    expect(row).not.toBeNull();
    expect(row!.number).toBe("HKA2573372");
    expect(row!.number_type).toBe("BL");
    expect(row!.sealine_scac).toBe("CMDU");
    expect(row!.sealine_name).toBe("CMA CGM");
    expect(row!.current_status).toBe("IN_TRANSIT");
    expect(row!.pol_locode).toBe("CNSHK");
    expect(row!.pod_locode).toBe("CLSAI");
  });

  it("treats pod.actual=true as ATA and pod.actual=false as ETA", () => {
    const predictive = mapShipment(fixture);
    expect(predictive!.eta).toBe("2025-10-31 23:00:00");
    expect(predictive!.ata).toBeNull();

    const arrived = mapShipment({
      ...fixture,
      data: {
        ...fixture.data!,
        route: { ...fixture.data!.route, pod: { location: 1, date: "2025-10-31 23:00:00", actual: true } },
      },
    });
    expect(arrived!.eta).toBeNull();
    expect(arrived!.ata).toBe("2025-10-31 23:00:00");
  });

  it("returns null when the response is missing metadata", () => {
    expect(mapShipment({ status: "success", message: "OK" })).toBeNull();
    expect(mapShipment({ status: "success", message: "OK", data: {} })).toBeNull();
  });
});

describe("mapEvents", () => {
  it("flattens events across containers with id → locode resolution", () => {
    const events = mapEvents(fixture);
    expect(events).toHaveLength(3);
    expect(events[0].container_number).toBe("ECMU7336714");
    expect(events[0].location_locode).toBe("CNSHK");
    expect(events[0].facility_name).toBe("Mawan Container Terminal");
    expect(events[0].is_actual).toBe(true);
    expect(events[0].event_code).toBe("PICK");
  });

  it("sets is_actual=false for predictive events", () => {
    const events = mapEvents(fixture);
    const arrival = events.find((e) => e.event_code === "ARRI");
    expect(arrival?.is_actual).toBe(false);
  });

  it("handles missing location/facility ids gracefully", () => {
    const events = mapEvents(fixture);
    const gateIn = events.find((e) => e.event_code === "GTIN");
    expect(gateIn?.location_locode).toBe("CNSHK");
    expect(gateIn?.facility_name).toBeNull(); // facility was null in fixture
  });

  it("returns empty array when the response has no containers", () => {
    expect(mapEvents({ data: {} })).toEqual([]);
    expect(mapEvents({ data: { containers: [] } })).toEqual([]);
  });
});
