// @vitest-environment jsdom
//
// Unit tests for <SearchableSelect /> — Cross-cutter T9-1.
//
// Coverage: open/close, filter, keyboard nav (↑/↓/Enter/Esc/Tab),
// click-outside, group headers, disabled options, empty state, the
// 200-item visible cap + footer, ARIA combobox roles + aria-expanded,
// searchHaystack override, panelMaxHeight prop, controlled re-render
// after onChange.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableSelect, type SearchableSelectOption } from "../SearchableSelect";

function basicOptions(): SearchableSelectOption[] {
  return [
    { value: "1", label: "Alpha" },
    { value: "2", label: "Bravo" },
    { value: "3", label: "Charlie" },
    { value: "4", label: "Delta" },
  ];
}

describe("SearchableSelect — display + open/close", () => {
  it("renders selected option's label as the input value when closed", () => {
    render(
      <SearchableSelect value="2" onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    expect((input as HTMLInputElement).value).toBe("Bravo");
  });

  it("shows placeholder when value is null", () => {
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        placeholder="Pick one…"
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("Pick one…");
  });

  it("opens panel on input focus", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("opens panel on click", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("aria-expanded toggles on open/close", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const wrapper = screen.getByRole("combobox");
    expect(wrapper.getAttribute("aria-expanded")).toBe("false");
    fireEvent.focus(wrapper.querySelector("input")!);
    expect(wrapper.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(wrapper.querySelector("input")!, { key: "Escape" });
    expect(wrapper.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SearchableSelect — filter", () => {
  it("narrows visible options as user types", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "br");
    const listbox = screen.getByRole("listbox");
    const opts = within(listbox).getAllByRole("option");
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent("Bravo");
  });

  it("filter is case-insensitive", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "DEL");
    const opts = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent("Delta");
  });

  it("uses searchHaystack override when present", async () => {
    const user = userEvent.setup();
    const opts: SearchableSelectOption[] = [
      { value: "uuid-aaa-111", label: "Customer A", searchHaystack: "Customer A uuid-aaa-111" },
      { value: "uuid-bbb-222", label: "Customer B", searchHaystack: "Customer B uuid-bbb-222" },
    ];
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "aaa-111");
    const visible = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveTextContent("Customer A");
  });

  it("shows custom emptyText when no matches", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        emptyText="Nothing found, sorry"
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "zzzzzz");
    expect(screen.getByText("Nothing found, sorry")).toBeInTheDocument();
  });

  it("shows default emptyText when no matches and prop omitted", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "qqqqq");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

describe("SearchableSelect — keyboard nav", () => {
  it("ArrowDown highlights next option, ArrowUp prev", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const wrapper = screen.getByRole("combobox");
    const input = wrapper.querySelector("input")!;
    fireEvent.focus(input);
    // Initial highlight is index 0 (Alpha). Press ArrowDown once → Bravo.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const activeEl = document.getElementById(active!);
    expect(activeEl).toHaveTextContent("Bravo");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const active2 = input.getAttribute("aria-activedescendant");
    const activeEl2 = document.getElementById(active2!);
    expect(activeEl2).toHaveTextContent("Alpha");
  });

  it("ArrowDown wraps from last to first", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    // 4 options; start at 0 → press down 4× → back to 0
    for (let i = 0; i < 4; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active!)).toHaveTextContent("Alpha");
  });

  it("ArrowUp wraps from first to last", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const active = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active!)).toHaveTextContent("Delta");
  });

  it("Enter commits the highlighted option", () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect value={null} onChange={onChange} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight Bravo
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("2");
    // Panel closes.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("Esc closes panel and clears query without committing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SearchableSelect value="1" onChange={onChange} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")! as HTMLInputElement;
    await user.click(input);
    await user.type(input, "del");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // Selected display restored.
    expect(input.value).toBe("Alpha");
  });

  it("Tab closes panel without committing", () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect value="1" onChange={onChange} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("SearchableSelect — click + outside", () => {
  it("click on option commits", () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect value={null} onChange={onChange} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    const charlieOpt = screen.getByText("Charlie");
    fireEvent.mouseDown(charlieOpt);
    expect(onChange).toHaveBeenCalledWith("3");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("click outside closes the panel", () => {
    render(
      <div>
        <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />
        <button>Outside</button>
      </div>,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Outside"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("SearchableSelect — group headers", () => {
  it("renders group headers when options have .group", () => {
    const opts: SearchableSelectOption[] = [
      { value: "1", label: "Cash", group: "Assets" },
      { value: "2", label: "AR", group: "Assets" },
      { value: "3", label: "AP", group: "Liabilities" },
      { value: "4", label: "Revenue", group: "Income" },
    ];
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    expect(screen.getByText("Assets")).toBeInTheDocument();
    expect(screen.getByText("Liabilities")).toBeInTheDocument();
    expect(screen.getByText("Income")).toBeInTheDocument();
  });

  it("group header only renders once per consecutive group", () => {
    const opts: SearchableSelectOption[] = [
      { value: "1", label: "Cash", group: "Assets" },
      { value: "2", label: "AR", group: "Assets" },
    ];
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    const headers = screen.getAllByText("Assets");
    expect(headers).toHaveLength(1);
  });
});

describe("SearchableSelect — disabled options", () => {
  it("clicking a disabled option does not commit", () => {
    const onChange = vi.fn();
    const opts: SearchableSelectOption[] = [
      { value: "1", label: "Active" },
      { value: "2", label: "Locked", disabled: true },
    ];
    render(<SearchableSelect value={null} onChange={onChange} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    fireEvent.mouseDown(screen.getByText("Locked"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ArrowDown skips disabled options when committing via Enter", () => {
    const onChange = vi.fn();
    const opts: SearchableSelectOption[] = [
      { value: "1", label: "Alpha" },
      { value: "2", label: "Locked", disabled: true },
      { value: "3", label: "Charlie" },
    ];
    render(<SearchableSelect value={null} onChange={onChange} options={opts} />);
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // Alpha → skip Locked → Charlie
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("3");
  });

  it("disabled option carries aria-disabled=true", () => {
    const opts: SearchableSelectOption[] = [
      { value: "1", label: "Active" },
      { value: "2", label: "Locked", disabled: true },
    ];
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    const locked = screen.getByText("Locked");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("SearchableSelect — 200-item visible cap", () => {
  it("shows cap footer when filtered exceeds 200, renders only 200", () => {
    const opts: SearchableSelectOption[] = Array.from({ length: 500 }, (_, i) => ({
      value: String(i),
      label: `Item ${i}`,
    }));
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    const visible = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(visible).toHaveLength(200);
    expect(screen.getByText(/showing 200 of 500/i)).toBeInTheDocument();
  });

  it("cap footer hidden when filtered ≤ 200", () => {
    const opts: SearchableSelectOption[] = Array.from({ length: 50 }, (_, i) => ({
      value: String(i),
      label: `Item ${i}`,
    }));
    render(<SearchableSelect value={null} onChange={vi.fn()} options={opts} />);
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    expect(screen.queryByText(/showing 200 of/i)).not.toBeInTheDocument();
  });
});

describe("SearchableSelect — props", () => {
  it("panelMaxHeight prop is applied to listbox style", () => {
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        panelMaxHeight={500}
      />,
    );
    fireEvent.focus(screen.getByRole("combobox").querySelector("input")!);
    const listbox = screen.getByRole("listbox") as HTMLElement;
    expect(listbox.style.maxHeight).toBe("500px");
  });

  it("updates displayed label after parent re-renders with new value", () => {
    const { rerender } = render(
      <SearchableSelect value="1" onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")! as HTMLInputElement;
    expect(input.value).toBe("Alpha");
    rerender(
      <SearchableSelect value="4" onChange={vi.fn()} options={basicOptions()} />,
    );
    expect(input.value).toBe("Delta");
  });

  it("ARIA roles: combobox wrapper + listbox panel + option items", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const wrapper = screen.getByRole("combobox");
    expect(wrapper.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.focus(wrapper.querySelector("input")!);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(4);
  });

  it("disabled prop blocks panel from opening", () => {
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} disabled />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    fireEvent.focus(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("SearchableSelect — onAddNew (Polish ask B, 2026-05-30)", () => {
  it("does not render the add-new row when onAddNew is undefined", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect value={null} onChange={vi.fn()} options={basicOptions()} />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "Zeta");
    expect(screen.queryByText(/\+ Add/)).not.toBeInTheDocument();
  });

  it("renders the add-new row once the user types something", async () => {
    const user = userEvent.setup();
    const onAddNew = vi.fn();
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        onAddNew={onAddNew}
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    // Empty query: no add-new row yet (we want a typed value to commit).
    expect(screen.queryByText(/\+ Add/)).not.toBeInTheDocument();
    await user.type(input, "Zeta");
    expect(screen.getByText('+ Add "Zeta"')).toBeInTheDocument();
  });

  it("clicking the add-new row invokes onAddNew with the typed value", async () => {
    const user = userEvent.setup();
    const onAddNew = vi.fn();
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        onAddNew={onAddNew}
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "Zeta");
    fireEvent.mouseDown(screen.getByText('+ Add "Zeta"'));
    expect(onAddNew).toHaveBeenCalledWith("Zeta");
  });

  it("renders the add-new row even with zero matches, so an admin can recover", async () => {
    const user = userEvent.setup();
    const onAddNew = vi.fn();
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        onAddNew={onAddNew}
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "qqqq");
    expect(screen.getByText('+ Add "qqqq"')).toBeInTheDocument();
  });

  it("uses a custom addNewLabel when provided", async () => {
    const user = userEvent.setup();
    render(
      <SearchableSelect
        value={null}
        onChange={vi.fn()}
        options={basicOptions()}
        onAddNew={vi.fn()}
        addNewLabel={(q) => `+ New category "${q || "..."}"`}
      />,
    );
    const input = screen.getByRole("combobox").querySelector("input")!;
    await user.click(input);
    await user.type(input, "Bottoms");
    expect(screen.getByText('+ New category "Bottoms"')).toBeInTheDocument();
  });
});
