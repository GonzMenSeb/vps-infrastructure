import { describe, expect, test } from "bun:test";
import { squarify, wr } from "../src/lib/treemap";

const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ v, n: `i${i}` }));

describe("squarify", () => {
  test("conserves total area and each item's proportional area", () => {
    const W = 400;
    const H = 250;
    const out = squarify(items, 0, 0, W, H);
    expect(out).toHaveLength(items.length);
    const total = out.reduce((s, r) => s + r.w * r.h, 0);
    expect(total).toBeCloseTo(W * H, 6);
    const sum = items.reduce((s, i) => s + i.v, 0);
    for (const r of out) expect(r.w * r.h).toBeCloseTo((r.v / sum) * W * H, 6);
  });

  test("rectangles stay inside the bounds and do not overlap", () => {
    const out = squarify(items, 10, 20, 300, 200);
    for (const r of out) {
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(310 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(220 + 1e-9);
    }
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 1e-6 && oy > 1e-6).toBe(false);
      }
    }
  });

  test("single item fills the box; payload fields are preserved", () => {
    const [r] = squarify([{ v: 5, n: "only" }], 1, 2, 30, 40);
    expect(r).toMatchObject({ n: "only", x: 1, y: 2, w: 30, h: 40 });
  });

  test("drops zero, negative and non-finite values and handles empty or degenerate input", () => {
    const out = squarify([{ v: 0 }, { v: -3 }, { v: NaN }, { v: 4 }], 0, 0, 10, 10);
    expect(out).toHaveLength(1);
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([{ v: 1 }], 0, 0, 0, 10)).toEqual([]);
  });

  test("unsorted input is laid out largest first", () => {
    const out = squarify([{ v: 1 }, { v: 9 }], 0, 0, 100, 10);
    expect(out[0]!.v).toBe(9);
  });

  test("wr is the worst aspect ratio of a row", () => {
    expect(wr([{ a: 75 }, { a: 25 }], 10)).toBeCloseTo(4, 9);
    expect(wr([{ a: 100 }], 10)).toBeCloseTo(1, 9);
  });
});
