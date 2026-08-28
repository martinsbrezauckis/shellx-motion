import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gpuStraightRgba, gpuStraightRgbaInPlace } from "./gpu-straight-rgba";

describe("gpuStraightRgbaInPlace", () => {
  it("keeps the safe helper non-mutating and makes ownership explicit for in-place normalization", () => {
    const shared = Buffer.from([64, 32, 0, 128, 80, 20, 10, 0]);
    const original = Buffer.from(shared);
    const safe = gpuStraightRgba({ rgba: shared, width: 2, height: 1 });
    expect(shared).toEqual(original);
    expect([...safe]).toEqual([128, 64, 0, 128, 0, 0, 0, 0]);

    const owned = Buffer.from(shared);
    const normalized = gpuStraightRgbaInPlace({ rgba: owned, width: 2, height: 1 });
    expect(normalized).toBe(owned);
    expect(normalized).toEqual(safe);
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(createHash("sha256").update(safe).digest("hex"));
  });
});
