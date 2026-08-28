import { expect, it } from "vitest";
import { hashBuffer } from "@shellx-motion/core";
import { legacyCutGenerateMotionHash } from "./cut-generate-to-cut-legacy-support";

it("retains Cut Generate's historical insertion-order motion hash", () => {
  const motion = { z: 1, a: { second: true, first: false } };
  expect(legacyCutGenerateMotionHash(motion)).toBe(hashBuffer(Buffer.from(JSON.stringify(motion), "utf8")));
});
