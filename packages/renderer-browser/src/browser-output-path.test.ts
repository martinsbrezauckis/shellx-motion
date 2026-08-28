import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserOutputPathFor } from "./browser-output-path.js";

describe("browser output path authority", () => {
  const pkg = { manifest: { id: "pkg" } };

  it("allows a frame under an authenticated directory stage while keeping evidence in a child root", () => {
    const stage = join(process.cwd(), ".scratch", "private-stage");
    expect(browserOutputPathFor(pkg, {
      atMs: 0,
      outDir: join(stage, ".browser-render-evidence", "000000"),
      outputPath: join(stage, "000001.png")
    }, stage)).toBe(join(stage, "000001.png"));
  });

  it("refuses the same cross-root output without authenticated private authority", () => {
    const stage = join(process.cwd(), ".scratch", "private-stage");
    expect(() => browserOutputPathFor(pkg, {
      atMs: 0,
      outDir: join(stage, ".browser-render-evidence", "000000"),
      outputPath: join(stage, "000001.png")
    })).toThrow(/authenticated private publication root/i);
  });
});
