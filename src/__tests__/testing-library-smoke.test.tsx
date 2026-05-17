// @vitest-environment jsdom
// Smoke test for @testing-library/react + jsdom + jest-dom matchers.
// If this file passes, the infrastructure is wired correctly and any
// future React component test can follow the same shape:
//
//   // @vitest-environment jsdom
//   import { render, screen } from "@testing-library/react";
//   import userEvent from "@testing-library/user-event";
//
// Don't add real test logic here — this is a sanity probe.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";

function Counter() {
  const [n, setN] = useState(0);
  return (
    <div>
      <span data-testid="count">{n}</span>
      <button onClick={() => setN(v => v + 1)}>+1</button>
    </div>
  );
}

describe("testing-library infrastructure smoke", () => {
  it("renders a React component into jsdom", () => {
    render(<Counter />);
    expect(screen.getByTestId("count")).toBeInTheDocument();
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  it("dispatches a click + observes the state update", () => {
    render(<Counter />);
    fireEvent.click(screen.getByRole("button", { name: "+1" }));
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });
});
