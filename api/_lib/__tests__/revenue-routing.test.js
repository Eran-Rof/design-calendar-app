import { describe, it, expect } from "vitest";
import {
  resolveRevenueRouting, resolveArAccountCode, isPrivateLabelStyle, channelFromIpChannelName,
} from "../accounting/revenueRouting.js";

describe("resolveRevenueRouting — the 2026-07-07 COA spec", () => {
  it("catch-all: adult ROF wholesale → 4005/5010", () => {
    expect(resolveRevenueRouting({ brandCode: "ROF", genderCode: "M", channel: "wholesale" }))
      .toEqual({ revenueCode: "4005", cogsCode: "5010" });
    expect(resolveRevenueRouting({ brandCode: "AXECROWN", genderCode: "W", channel: "wholesale" }))
      .toEqual({ revenueCode: "4005", cogsCode: "5010" });
    // Unknown gender falls to catch-all, never crashes.
    expect(resolveRevenueRouting({ brandCode: "ROF" }).revenueCode).toBe("4005");
  });

  it("kids (B/C/G) non-PL → 4006/5011", () => {
    for (const g of ["B", "C", "G"]) {
      expect(resolveRevenueRouting({ brandCode: "ROF", genderCode: g, channel: "wholesale" }))
        .toEqual({ revenueCode: "4006", cogsCode: "5011" });
    }
  });

  it("Psycho Tuna: wholesale → 4009/5012, ecom → 4008/5013 (beats kids gender)", () => {
    expect(resolveRevenueRouting({ brandCode: "PT", genderCode: "M", channel: "wholesale" }))
      .toEqual({ revenueCode: "4009", cogsCode: "5012" });
    expect(resolveRevenueRouting({ brandCode: "PT", genderCode: "B", channel: "ecom_pt" }))
      .toEqual({ revenueCode: "4008", cogsCode: "5013" });
  });

  it("ROF ecom (any brand except PT/PL) → 4011/5014, beats kids gender", () => {
    expect(resolveRevenueRouting({ brandCode: "ROF", genderCode: "B", channel: "ecom_rof" }))
      .toEqual({ revenueCode: "4011", cogsCode: "5014" });
  });

  it("private label wins over brand/gender/channel (except samples) → 4012/5015", () => {
    expect(resolveRevenueRouting({ brandCode: "ROF", genderCode: "B", channel: "ecom_rof", isPrivateLabel: true }))
      .toEqual({ revenueCode: "4012", cogsCode: "5015" });
    expect(resolveRevenueRouting({ brandCode: "PL", genderCode: "M", channel: "wholesale" }))
      .toEqual({ revenueCode: "4012", cogsCode: "5015" });
  });

  it("consignment → 4007/5018", () => {
    expect(resolveRevenueRouting({ brandCode: "ROF", channel: "consignment" }))
      .toEqual({ revenueCode: "4007", cogsCode: "5018" });
  });

  it("samples → 4010 with NO COGS (expense out), beats everything", () => {
    expect(resolveRevenueRouting({ brandCode: "PT", genderCode: "B", channel: "ecom_pt", isPrivateLabel: true, isSample: true }))
      .toEqual({ revenueCode: "4010", cogsCode: null });
  });

  it("shipping income routes by store, NO COGS: 4014 PT / 4015 ROF ecom / 4016 wholesale", () => {
    expect(resolveRevenueRouting({ isShipping: true, channel: "ecom_pt" })).toEqual({ revenueCode: "4014", cogsCode: null });
    expect(resolveRevenueRouting({ isShipping: true, channel: "ecom_rof" })).toEqual({ revenueCode: "4015", cogsCode: null });
    expect(resolveRevenueRouting({ isShipping: true, channel: "wholesale" })).toEqual({ revenueCode: "4016", cogsCode: null });
  });
});

describe("resolveArAccountCode — factored 1107 / credit-card 1105 / house 1108", () => {
  it("routes by customer class", () => {
    expect(resolveArAccountCode({ is_factored: true })).toBe("1107");
    expect(resolveArAccountCode({ payment_processor: "stripe" })).toBe("1105");
    expect(resolveArAccountCode({})).toBe("1108");
    // Factored wins over processor.
    expect(resolveArAccountCode({ is_factored: true, payment_processor: "stripe" })).toBe("1107");
  });
});

describe("adapters", () => {
  it("isPrivateLabelStyle: catalog PL suffix", () => {
    expect(isPrivateLabelStyle("RYB0412PL")).toBe(true);
    expect(isPrivateLabelStyle("RYB0412")).toBe(false);
    expect(isPrivateLabelStyle(null)).toBe(false);
  });
  it("channelFromIpChannelName: bridge channel names", () => {
    expect(channelFromIpChannelName("PT ECOM")).toBe("ecom_pt");
    expect(channelFromIpChannelName("ROF ECOM")).toBe("ecom_rof");
    expect(channelFromIpChannelName("ROF")).toBe("wholesale");
    expect(channelFromIpChannelName("PT")).toBe("wholesale");
    expect(channelFromIpChannelName(null)).toBe("wholesale");
  });
});
