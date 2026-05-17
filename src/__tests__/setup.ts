// Vitest setup file — loaded once per test run. Wires
// @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
// into vitest's expect.
//
// Tests that mount React components should add this at the top of
// the file (vitest discovers it automatically because of the
// `setupFiles` entry in vite.config.ts):
//
//   // @vitest-environment jsdom
//   import { render, screen } from "@testing-library/react";
//
// Pure helper tests (no DOM) stay on the default node environment
// and don't load this setup.

import "@testing-library/jest-dom/vitest";
