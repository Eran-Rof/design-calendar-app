// @vitest-environment jsdom
//
// Unit tests for <DateRangePresets /> — Cross-cutter T7-1.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DateRangePresets from "../DateRangePresets.tsx";
import { DEFAULT_PRESETS, type Preset } from "../dateRangeMath";

describe("<DateRangePresets /> — render", () => {
  it("renders one chip per default preset", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    const chips = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-preset-key"));
    expect(chips).toHaveLength(DEFAULT_PRESETS.length);
  });

  it("each chip carries its preset label as text", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    for (const p of DEFAULT_PRESETS) {
      expect(screen.getByText(p.label)).toBeInTheDocument();
    }
  });

  it("renders a tooltip showing the computed range", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    const mtd = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "mtd")!;
    const title = mtd.getAttribute("title");
    expect(title).toMatch(/\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/);
  });

  it("custom chip's tooltip is a manual-pick hint, not the empty sentinel", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    const custom = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "custom")!;
    expect(custom.getAttribute("title")).toBe("Pick from/to manually");
  });
});

describe("<DateRangePresets /> — click → onChange", () => {
  it("clicking a chip fires onChange with that preset's computed from/to + preset object", () => {
    const onChange = vi.fn();
    render(<DateRangePresets from="" to="" onChange={onChange} />);
    const mtd = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "mtd")!;
    fireEvent.click(mtd);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [from, to, preset] = onChange.mock.calls[0];
    expect(from).toMatch(/^\d{4}-\d{2}-01$/); // first of some month
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((preset as Preset).key).toBe("mtd");
  });

  it("clicking the custom chip fires onChange with empty strings + preset object", () => {
    const onChange = vi.fn();
    render(<DateRangePresets from="2026-01-01" to="2026-05-28" onChange={onChange} />);
    const custom = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "custom")!;
    fireEvent.click(custom);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [from, to, preset] = onChange.mock.calls[0];
    expect(from).toBe("");
    expect(to).toBe("");
    expect((preset as Preset).key).toBe("custom");
  });
});

describe("<DateRangePresets /> — active-chip highlight", () => {
  it("the chip whose computed range matches current from/to carries aria-pressed=true", () => {
    // Compute today's MTD so the highlight target is deterministic.
    const mtd = DEFAULT_PRESETS.find((p) => p.key === "mtd")!.compute(new Date());
    render(<DateRangePresets from={mtd.from} to={mtd.to} onChange={vi.fn()} />);
    const chip = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "mtd")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("no chip is active when from/to don't match any preset", () => {
    render(
      <DateRangePresets from="1999-06-15" to="1999-07-15" onChange={vi.fn()} />,
    );
    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(0);
  });

  it("custom chip never goes active even when from='' and to=''", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    const custom = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "custom")!;
    expect(custom.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("<DateRangePresets /> — props", () => {
  it("align='right' sets justify-content: flex-end", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} align="right" />);
    const row = screen.getByRole("group");
    expect((row as HTMLElement).style.justifyContent).toBe("flex-end");
  });

  it("align='left' (default) sets justify-content: flex-start", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} />);
    const row = screen.getByRole("group");
    expect((row as HTMLElement).style.justifyContent).toBe("flex-start");
  });

  it("custom presets prop fully overrides DEFAULT_PRESETS", () => {
    const myPresets: Preset[] = [
      { key: "foo", label: "Foo", compute: () => ({ from: "2020-01-01", to: "2020-12-31" }) },
      { key: "bar", label: "Bar", compute: () => ({ from: "2021-01-01", to: "2021-12-31" }) },
    ];
    render(<DateRangePresets from="" to="" onChange={vi.fn()} presets={myPresets} />);
    const chips = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-preset-key"));
    expect(chips).toHaveLength(2);
    expect(screen.getByText("Foo")).toBeInTheDocument();
    expect(screen.getByText("Bar")).toBeInTheDocument();
    // Default labels are gone.
    expect(screen.queryByText("MTD")).not.toBeInTheDocument();
  });

  it("buttonStyle prop is merged into chip style", () => {
    render(
      <DateRangePresets
        from=""
        to=""
        onChange={vi.fn()}
        buttonStyle={{ fontWeight: 700 }}
      />,
    );
    const chip = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("data-preset-key") === "mtd") as HTMLElement;
    expect(chip.style.fontWeight).toBe("700");
  });
});

describe("<DateRangePresets /> — dropdown variant (custom, themed)", () => {
  it("renders a trigger button; opening shows one themed option per preset", () => {
    render(<DateRangePresets from="" to="" onChange={vi.fn()} variant="dropdown" />);
    const trigger = screen.getByTestId("date-range-presets-dropdown");
    expect(trigger.tagName).toBe("BUTTON");
    // Closed by default — no native <select>, no listbox.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(DEFAULT_PRESETS.length);
  });

  it("clicking a preset option fires onChange with its computed range", () => {
    const onChange = vi.fn();
    render(<DateRangePresets from="" to="" onChange={onChange} variant="dropdown" />);
    const mtd = DEFAULT_PRESETS.find((p) => p.key === "mtd")!;
    const computed = mtd.compute(new Date());
    fireEvent.click(screen.getByTestId("date-range-presets-dropdown"));
    fireEvent.click(screen.getByRole("option", { name: mtd.label }));
    expect(onChange).toHaveBeenCalledWith(
      computed.from,
      computed.to,
      expect.objectContaining({ key: "mtd" }),
    );
  });

  it("reflects the active preset on the trigger label", () => {
    const mtd = DEFAULT_PRESETS.find((p) => p.key === "mtd")!;
    const c = mtd.compute(new Date());
    render(<DateRangePresets from={c.from} to={c.to} onChange={vi.fn()} variant="dropdown" />);
    expect(screen.getByTestId("date-range-presets-dropdown")).toHaveTextContent(mtd.label);
  });
});
