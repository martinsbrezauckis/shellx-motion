import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cutoutRigAuthoringRoots,
  cutoutRigDebugArgs,
  CUTOUT_RIG_DEBUG_COMMANDS,
  hydrateCutoutRigDebugArgs,
} from "./cutout-rig-cli.js";

const RIG = {
  schema: "shellx-motion/cutout-rig@1",
  sampleEveryFrames: 1,
  nodes: [{
    layerId: "hand",
    stackIndex: 0,
    crop: { x: 0, y: 0, width: 10, height: 10 },
    origin: { x: 0, y: 0 },
    poses: [{ atMs: 0, x: 0, y: 0, scale: 1, rotation: 0 }],
  }],
};

describe("cutout rig CLI", () => {
  it("hydrates a governed rig file then removes its local path from the public request", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cutout-rig-cli-"));
    try {
      const rigFile = join(root, "rig.json");
      const packageRoot = join(root, "package");
      const outDir = join(root, "out");
      await writeFile(rigFile, JSON.stringify(RIG));

      expect(CUTOUT_RIG_DEBUG_COMMANDS).toEqual({ "cutout-rig-bake": "motion.timeline.cutout.rig.bake" });
      const args = await cutoutRigDebugArgs("motion.timeline.cutout.rig.bake", [
        "--rig-file", rigFile, "--out", outDir, "--source-layer", "source",
      ], packageRoot);
      expect(cutoutRigAuthoringRoots("motion.timeline.cutout.rig.bake", args)).toEqual({
        inputRoots: [root, root],
        outputRoots: [root],
      });

      const hydrated = await hydrateCutoutRigDebugArgs("motion.timeline.cutout.rig.bake", args, [root]);
      expect(hydrated).toEqual({
        packageRoot: resolve(packageRoot),
        outDir,
        sourceLayerId: "source",
        rig: RIG,
        receiptsRoot: undefined,
        createdBy: undefined,
      });
      expect(hydrated).not.toHaveProperty("rigFilePath");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
