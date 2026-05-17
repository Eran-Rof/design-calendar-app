// @vitest-environment jsdom
//
// Smoke coverage of <SamplesTab />: empty state, "+ Add Sample"
// uses the injected `today` for requestDate, status transition
// runs through updateSampleStatus (stamps receiveDate on Received),
// ✕ removes a sample.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SamplesTab } from "../tabs/SamplesTab";
import { emptyTechPack } from "../factories";
import type { TechPack, Sample } from "../types";

const TODAY = () => "2026-05-17";

function sample(over: Partial<Sample> = {}): Sample {
  return {
    id: "s1", type: "Proto", status: "Requested",
    requestDate: "2026-05-01", receiveDate: null,
    vendor: "", comments: "", images: [],
    ...over,
  };
}

function makeTp(samples: Sample[] = []): TechPack {
  return { ...emptyTechPack({ name: "Eran" }), samples };
}

describe("<SamplesTab />", () => {
  it("renders the empty state when no samples", () => {
    render(<SamplesTab
      tp={makeTp()}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    expect(screen.getByText("No samples tracked yet.")).toBeInTheDocument();
  });

  it("'+ Add Sample' uses the injected today for requestDate + leaves receiveDate null", () => {
    const updateSelected = vi.fn();
    render(<SamplesTab
      tp={makeTp()}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    fireEvent.click(screen.getByText("+ Add Sample"));
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.samples).toHaveLength(1);
    expect(arg.samples[0]).toMatchObject({
      type: "Proto",
      status: "Requested",
      requestDate: "2026-05-17",
      receiveDate: null,
    });
  });

  it("changing status to 'Received' auto-stamps receiveDate via updateSampleStatus", () => {
    const updateSelected = vi.fn();
    render(<SamplesTab
      tp={makeTp([sample()])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    // Status select is the second select on the page (first is "Type")
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "Received" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.samples[0].status).toBe("Received");
    expect(arg.samples[0].receiveDate).toBe("2026-05-17");
  });

  it("changing status from Received → Requested preserves the existing receiveDate", () => {
    const updateSelected = vi.fn();
    render(<SamplesTab
      tp={makeTp([sample({ status: "Received", receiveDate: "2026-04-01" })])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "Requested" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.samples[0].status).toBe("Requested");
    // updateSampleStatus preserves it
    expect(arg.samples[0].receiveDate).toBe("2026-04-01");
  });

  it("clicking 🗑️ removes the sample", () => {
    const updateSelected = vi.fn();
    render(<SamplesTab
      tp={makeTp([sample({ id: "a" }), sample({ id: "b", type: "PP" })])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    fireEvent.click(screen.getAllByText("🗑️")[0]);
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.samples.map((s: Sample) => s.id)).toEqual(["b"]);
  });

  it("editing Vendor calls updateSelected with the new vendor", () => {
    const updateSelected = vi.fn();
    render(<SamplesTab
      tp={makeTp([sample()])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
      showToast={vi.fn()}
      today={TODAY}
    />);
    fireEvent.change(screen.getByPlaceholderText("Vendor name"), { target: { value: "Acme" } });
    const arg = updateSelected.mock.calls[0][0];
    expect(arg.samples[0].vendor).toBe("Acme");
  });
});
