import { describe, it, expect } from "vitest";
import { computeTrimBox } from "../exportImages";

// Build an RGBA buffer: a (configurable) backdrop canvas (w×h) with a solid
// content rect. Backdrop defaults to pure white.
function makeImage(
  w: number,
  h: number,
  rect: { x: number; y: number; rw: number; rh: number; color?: [number, number, number] } | null,
  bg: [number, number, number] = [255, 255, 255],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  if (rect) {
    const [r, g, b] = rect.color ?? [40, 40, 40];
    for (let y = rect.y; y < rect.y + rect.rh; y++) {
      for (let x = rect.x; x < rect.x + rect.rw; x++) {
        const idx = (y * w + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
  }
  return data;
}

describe("computeTrimBox", () => {
  it("crops a white border down to the content (with small padding)", () => {
    // 200×300 white, content rect at (60,90) sized 80×120 → margins all around.
    const w = 200, h = 300;
    const box = computeTrimBox(makeImage(w, h, { x: 60, y: 90, rw: 80, rh: 120 }), w, h, { padFrac: 0 });
    expect(box).not.toBeNull();
    expect(box!.sx).toBe(60);
    expect(box!.sy).toBe(90);
    expect(box!.sw).toBe(80);
    expect(box!.sh).toBe(120);
  });

  it("adds padding around the content but clamps to image bounds", () => {
    const w = 200, h = 300;
    const box = computeTrimBox(makeImage(w, h, { x: 60, y: 90, rw: 80, rh: 120 }), w, h, { padFrac: 0.05 });
    // pad = round(min(80,120)*0.05) = 4
    expect(box!.sx).toBe(56);
    expect(box!.sy).toBe(86);
    expect(box!.sw).toBe(88);
    expect(box!.sh).toBe(128);
  });

  it("returns null for an all-white image (nothing to trim)", () => {
    expect(computeTrimBox(makeImage(100, 100, null), 100, 100)).toBeNull();
  });

  it("returns null when content already fills the frame (no border)", () => {
    const box = computeTrimBox(makeImage(100, 100, { x: 0, y: 0, rw: 100, rh: 100 }), 100, 100);
    expect(box).toBeNull();
  });

  it("bails (null) on implausible over-crop below the min-area guard", () => {
    // A tiny 4×4 speck in a 200×200 frame → bbox area 16 << 12% of 40000.
    const box = computeTrimBox(makeImage(200, 200, { x: 100, y: 100, rw: 4, rh: 4 }), 200, 200);
    expect(box).toBeNull();
  });

  it("tolerates a few stray non-white pixels in an otherwise-white border", () => {
    const w = 200, h = 300;
    const data = makeImage(w, h, { x: 60, y: 90, rw: 80, rh: 120 });
    // one stray dark pixel up in the white margin (row 5) — within the 1% tolerance
    const idx = (5 * w + 10) * 4;
    data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0;
    const box = computeTrimBox(data, w, h, { padFrac: 0 });
    expect(box!.sy).toBe(90); // stray pixel ignored, top still snaps to content
  });

  it("returns null on a malformed/short buffer", () => {
    expect(computeTrimBox(new Uint8ClampedArray(10), 200, 300)).toBeNull();
  });

  it("trims an OFF-WHITE backdrop the old ≥248 test would have missed", () => {
    // Backdrop ~242 grey (below the old pure-white threshold) → corner detection
    // picks it up and still crops to the content.
    const w = 200, h = 300;
    const box = computeTrimBox(
      makeImage(w, h, { x: 60, y: 90, rw: 80, rh: 120 }, [242, 242, 242]),
      w, h, { padFrac: 0 },
    );
    expect(box).not.toBeNull();
    expect(box!.sx).toBe(60);
    expect(box!.sy).toBe(90);
    expect(box!.sw).toBe(80);
    expect(box!.sh).toBe(120);
  });

  it("bails on a dark backdrop (won't risk cropping a full-bleed product)", () => {
    const w = 200, h = 300;
    const box = computeTrimBox(
      makeImage(w, h, { x: 60, y: 90, rw: 80, rh: 120, color: [255, 255, 255] }, [30, 30, 30]),
      w, h,
    );
    expect(box).toBeNull();
  });
});
