import { describe, expect, it } from "vitest";
import { findAction } from "./catalog";

describe("generic connector catalog action", () => {
  it("finds the generic read-only connector catalog by its CLI wording", () => {
    const action = findAction("connector catalog");

    expect(action?.id).toBe("motion.connector.catalog");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.connector.catalog"]);
    expect(action?.verify).toEqual(expect.arrayContaining([
      expect.stringContaining("canonical v2 descriptor inventory")
    ]));
  });
});
