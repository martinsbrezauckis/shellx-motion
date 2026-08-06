import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const svgUrl = new URL("../assets/brand/shellx-motion-icon.svg", import.meta.url);
const pngUrl = new URL("../assets/brand/shellx-motion-icon.png", import.meta.url);

describe("ShellX Motion brand asset", () => {
  it("keeps the family X and the Motion cyan keyframe badge in the canonical SVG", async () => {
    const svg = await readFile(svgUrl, "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('rx="112"');
    expect(svg).toContain('fill="#f5f7f6"');
    expect(svg.match(/#3ad9f2/g)).toHaveLength(3);
    expect(svg).toContain("cyan keyframe curve badge");
  });

  it("ships a 512 x 512 PNG derived asset", async () => {
    const png = await readFile(pngUrl);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });
});
