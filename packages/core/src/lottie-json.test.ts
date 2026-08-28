import { describe, expect, it, vi } from "vitest";
import { parseBoundedLottieJson } from "./lottie-json";

describe("bounded Lottie JSON parser", () => {
  it("keeps ordinary Lottie JSON compatible", () => {
    expect(parseBoundedLottieJson(JSON.stringify({
      v: "5.12.2",
      w: 1920,
      h: 1080,
      fr: 30,
      ip: 0,
      op: 60,
      layers: [{ ind: 1, ty: 1, nm: "Background" }]
    }))).toMatchObject({ w: 1920, h: 1080, fr: 30, ip: 0, op: 60, layers: [{ ind: 1, ty: 1 }] });
  });

  it("refuses every JSON resource budget before JSON.parse expands the document", () => {
    const bytes = `"${"x".repeat(16 * 1024 * 1024)}"`;
    const nesting = `${"[".repeat(66)}0${"]".repeat(66)}`;
    const string = `"${"x".repeat(1024 * 1024 + 1)}"`;
    const array = `[${Array.from({ length: 20_001 }, () => "0").join(",")}]`;
    const object = `{${Array.from({ length: 1_001 }, (_, index) => `"f${index}":0`).join(",")}}`;
    const nodes = `[${Array.from({ length: 100 }, () => `[${Array.from({ length: 1_000 }, () => "0").join(",")}]`).join(",")}]`;

    for (const [source, reason] of [
      [bytes, /16 MiB diagnostic limit/],
      [nesting, /depth-64 pre-parse limit/],
      [string, /string exceeds the 1 MiB pre-parse limit/],
      [array, /20000-item pre-parse limit/],
      [object, /1000-field pre-parse limit/],
      [nodes, /100000-node pre-parse structural limit/]
    ] as const) {
      expectRefusedBeforeJsonParse(source, reason);
    }
  });

  it("retains post-parse forbidden-key and finite top-level validation", () => {
    expect(() => parseBoundedLottieJson('{"w":1,"h":1,"fr":30,"ip":0,"op":1,"layers":[],"__proto__":{}}')).toThrow("forbidden object key __proto__");
    expect(() => parseBoundedLottieJson('{"w":1,"h":1,"fr":"30","ip":0,"op":1,"layers":[]}')).toThrow("fr must be a finite number");
  });
});

function expectRefusedBeforeJsonParse(sourceText: string, reason: RegExp): void {
  const parseSpy = vi.spyOn(JSON, "parse");
  try {
    expect(() => parseBoundedLottieJson(sourceText)).toThrow(reason);
    expect(parseSpy).not.toHaveBeenCalled();
  } finally {
    parseSpy.mockRestore();
  }
}
