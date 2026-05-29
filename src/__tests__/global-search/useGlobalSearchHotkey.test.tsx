// @vitest-environment jsdom
//
// Tests for the ⌘K / Ctrl-K global search hotkey. Cross-cutter T6-3.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useGlobalSearchHotkey } from "../../hooks/useGlobalSearchHotkey";

function Harness({
  isOpen,
  onToggle,
  onClose,
}: {
  isOpen: boolean;
  onToggle: (next: boolean) => void;
  onClose: () => void;
}) {
  useGlobalSearchHotkey({ isOpen, onToggle, onClose });
  return <div data-testid="harness">{isOpen ? "open" : "closed"}</div>;
}

describe("useGlobalSearchHotkey — ⌘K / Ctrl-K toggle", () => {
  it("Meta+K (Mac) calls onToggle with the inverse of the current open state", () => {
    const onToggle = vi.fn();
    const onClose = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("Ctrl+K (Windows/Linux) calls onToggle with the inverse of the current open state", () => {
    const onToggle = vi.fn();
    const onClose = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("when palette is open, ⌘K toggles it closed (passes false)", () => {
    const onToggle = vi.fn();
    render(<Harness isOpen={true} onToggle={onToggle} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("accepts uppercase K (Shift+⌘K still works)", () => {
    const onToggle = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: "K", metaKey: true });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("plain K (no modifier) is ignored", () => {
    const onToggle = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: "k" });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("other modified keys (⌘J, ⌘S, etc.) are ignored", () => {
    const onToggle = vi.fn();
    render(<Harness isOpen={false} onToggle={onToggle} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("useGlobalSearchHotkey — Escape", () => {
  it("calls onClose when Escape is pressed while open", () => {
    const onClose = vi.fn();
    render(<Harness isOpen={true} onToggle={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when Escape is pressed while closed", () => {
    const onClose = vi.fn();
    render(<Harness isOpen={false} onToggle={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onToggle on Escape", () => {
    const onToggle = vi.fn();
    render(<Harness isOpen={true} onToggle={onToggle} onClose={vi.fn()} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("useGlobalSearchHotkey — cleanup", () => {
  it("removes the listener on unmount (no further toggle calls after unmount)", () => {
    const onToggle = vi.fn();
    const { unmount } = render(
      <Harness isOpen={false} onToggle={onToggle} onClose={vi.fn()} />,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);

    unmount();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
