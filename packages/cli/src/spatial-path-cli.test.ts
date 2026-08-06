import { describe, expect, it } from "vitest";
import { SPATIAL_PATH_DEBUG_COMMANDS, spatialPathDebugArgs } from "./spatial-path-cli";

describe("spatial path CLI adapter", () => {
  it("maps bounded aliases and explicit handle arguments", () => {
    expect(SPATIAL_PATH_DEBUG_COMMANDS["spatial-position-upsert"]).toBe("motion.timeline.spatial.position.upsert");
    expect(spatialPathDebugArgs("motion.timeline.spatial.position.upsert", [
      "--out", "/tmp/edited", "--layer", "subject", "--at-ms", "500", "--x", "120", "--y", "80",
      "--easing", "ease-in-out", "--mode", "broken", "--in-x", "-10", "--in-y", "0", "--out-x", "20", "--out-y", "5",
    ], "/tmp/source")).toEqual({
      packageRoot: "/tmp/source",
      outDir: "/tmp/edited",
      receiptsRoot: undefined,
      createdBy: undefined,
      layerId: "subject",
      atMs: 500,
      x: 120,
      y: 80,
      easing: "ease-in-out",
      spatial: { mode: "broken", in: { x: -10, y: 0 }, out: { x: 20, y: 5 } },
    });
  });

  it("returns paired move/delete arguments and ignores other commands", () => {
    expect(spatialPathDebugArgs("motion.timeline.spatial.position.move", [
      "--package-dir", "/tmp/edited", "--layer-id", "subject", "--from-ms", "100", "--to-ms", "250",
    ], "/tmp/source")).toMatchObject({ layerId: "subject", fromMs: 100, toMs: 250 });
    expect(spatialPathDebugArgs("motion.timeline.spatial.position.delete", [
      "--out", "/tmp/edited", "--layer", "subject", "--at-ms", "250",
    ], "/tmp/source")).toMatchObject({ layerId: "subject", atMs: 250 });
    expect(spatialPathDebugArgs("motion.timeline.keyframe.upsert", [], "/tmp/source")).toBeNull();
  });
});
