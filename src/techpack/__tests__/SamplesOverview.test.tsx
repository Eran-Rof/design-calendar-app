// @vitest-environment jsdom
//
// Smoke test for <SamplesOverview />. Tiny presentational component
// — verifies empty state + row rendering with the denormalized
// style fields.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SamplesOverview } from "../views/SamplesOverview";
import type { SampleWithStyle } from "../listLogic";

function sample(over: Partial<SampleWithStyle> = {}): SampleWithStyle {
  return {
    id: "s1", type: "Proto", status: "Requested",
    requestDate: "2026-05-01", receiveDate: null,
    vendor: "Acme", comments: "", images: [],
    styleNumber: "RYB001", styleName: "Edge Slim",
    ...over,
  };
}

describe("<SamplesOverview />", () => {
  it("renders the empty state when there are no samples", () => {
    render(<SamplesOverview allSamples={[]} />);
    expect(screen.getByText(/No samples tracked/)).toBeInTheDocument();
  });

  it("renders one row per sample with styleNumber + styleName + type + status", () => {
    render(<SamplesOverview allSamples={[
      sample({ id: "a", styleNumber: "001", styleName: "Edge", type: "Proto", status: "Requested" }),
      sample({ id: "b", styleNumber: "002", styleName: "Bartram", type: "PP", status: "Approved" }),
    ]} />);
    expect(screen.getByText("001")).toBeInTheDocument();
    expect(screen.getByText("Edge")).toBeInTheDocument();
    expect(screen.getByText("002")).toBeInTheDocument();
    expect(screen.getByText("Bartram")).toBeInTheDocument();
    expect(screen.getByText("Proto")).toBeInTheDocument();
    expect(screen.getByText("PP")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });
});
