import { describe, expect, it } from "vitest";
import { DerivedOutputPublication } from "./derived-output-publication.js";
import { isCoreDerivedOutputPublication } from "./derived-output-publication-authenticity.js";

describe("Core derived-output publication authenticity", () => {
  it("refuses structural and prototype-shaped impostors", () => {
    expect(isCoreDerivedOutputPublication({ outputPath: "/public/final.mp4", stagingPath: "/private/final.mp4" })).toBe(false);
    expect(isCoreDerivedOutputPublication(Object.create(DerivedOutputPublication.prototype))).toBe(false);
  });
});
