/** Routing proof for modular media-effect actions. */
import { describe, expect, it } from "vitest";
import { findAction } from "./catalog.js";

describe("media-effect action catalog", () => {
  it("preserves tracking action routes after extraction", () => {
    expect(findAction("run planar tracking")?.id).toBe("motion.analysis.tracking.request");
    expect(findAction("show lost tracking spans")?.id).toBe("motion.analysis.tracking.inspect");
    expect(findAction("apply tracking stabilization")?.id).toBe("motion.analysis.tracking.apply");
    expect(findAction("restore transform before tracking")?.id).toBe("motion.analysis.tracking.detach");
    expect(findAction("verify track before cut handoff")?.id).toBe("motion.analysis.tracking.verify");
  });

  it("routes natural keying and roto requests to bounded workflows", () => {
    expect(findAction("key out green screen")?.id).toBe("motion.keying.apply");
    expect(findAction("restore unkeyed footage")?.id).toBe("motion.keying.remove");
    expect(findAction("animate roto mask")?.id).toBe("motion.roto.upsert");
    expect(findAction("keep roto frames remove tracking")?.id).toBe("motion.roto.tracking.detach");
    expect(findAction("delete rotoscope mask")?.id).toBe("motion.roto.remove");
  });

  it("exposes verification calls before preview and handoff", () => {
    expect(findAction("apply chroma key")?.calls).toEqual([
      "motion.keying.inspect",
      "motion.keying.apply",
      "motion.preview.frame",
      "motion.receipts.read",
    ]);
    expect(findAction("attach tracking to roto")?.verify[0]).toMatch(/stable vertex identities/);
  });
});
