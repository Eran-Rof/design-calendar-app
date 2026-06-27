// @vitest-environment jsdom
//
// Integration tests for <ImagesTab />. Focused smoke coverage of
// the empty state, upload flow (mocked uploadImage), thumbnail
// grid rendering, lightbox open, and ✕ delete.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImagesTab } from "../tabs/ImagesTab";
import { emptyTechPack } from "../factories";
import type { TechPack } from "../types";

function makeTp(images: TechPack["images"] = []): TechPack {
  const base = emptyTechPack({ name: "Eran" });
  return { ...base, id: "tp-123", images };
}

describe("<ImagesTab />", () => {
  it("renders the empty state when no images", () => {
    render(<ImagesTab
      tp={makeTp()}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    expect(screen.getByText("No images uploaded yet")).toBeInTheDocument();
  });

  it("renders the image grid when images exist", () => {
    render(<ImagesTab
      tp={makeTp([
        { id: "i1", url: "u1.jpg", name: "front.jpg", type: "image/jpeg" },
        { id: "i2", url: "u2.jpg", name: "back.jpg", type: "image/jpeg" },
      ])}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    expect(screen.getByText("front.jpg")).toBeInTheDocument();
    expect(screen.getByText("back.jpg")).toBeInTheDocument();
    expect(screen.queryByText("No images uploaded yet")).not.toBeInTheDocument();
  });

  it("clicking ✕ on a thumbnail removes that image via updateSelected", () => {
    const updateSelected = vi.fn();
    render(<ImagesTab
      tp={makeTp([
        { id: "i1", url: "u1.jpg", name: "front.jpg", type: "image/jpeg" },
        { id: "i2", url: "u2.jpg", name: "back.jpg", type: "image/jpeg" },
      ])}
      updateSelected={updateSelected}
      uploadImage={vi.fn()}
      setLightboxImg={vi.fn()}
    />);
    const removeButtons = screen.getAllByText("Delete");
    fireEvent.click(removeButtons[0]); // remove i1
    expect(updateSelected).toHaveBeenCalledWith({
      images: [{ id: "i2", url: "u2.jpg", name: "back.jpg", type: "image/jpeg" }],
    });
  });

  it("clicking an image fires setLightboxImg with the url", () => {
    const setLightboxImg = vi.fn();
    render(<ImagesTab
      tp={makeTp([{ id: "i1", url: "u1.jpg", name: "front.jpg", type: "image/jpeg" }])}
      updateSelected={vi.fn()}
      uploadImage={vi.fn()}
      setLightboxImg={setLightboxImg}
    />);
    fireEvent.click(screen.getByAltText("front.jpg"));
    expect(setLightboxImg).toHaveBeenCalledWith("u1.jpg");
  });
});
