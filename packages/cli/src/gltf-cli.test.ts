import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gltfAuthoringRoots, gltfDebugArgs, GLTF_DEBUG_COMMANDS } from "./gltf-cli.js";
import { runCli } from "./main.js";

describe("modular glTF CLI", () => {
  it("maps and parses a local import without exposing trust-root flags", () => {
    expect(GLTF_DEBUG_COMMANDS).toEqual({ "gltf-import": "motion.scene3d.gltf.import" });
    const args = gltfDebugArgs("motion.scene3d.gltf.import", [
      "--source", "fixtures/model.gltf",
      "--out", "tmp/model-package",
      "--created-by", "cli-test",
    ]);

    expect(args).toEqual({
      sourcePath: resolve("fixtures/model.gltf"),
      outDir: resolve("tmp/model-package"),
      createdBy: "cli-test",
      createdAt: undefined,
    });
    expect(gltfAuthoringRoots("motion.scene3d.gltf.import", args)).toEqual({
      inputRoots: [resolve("fixtures")],
      outputRoots: [resolve("tmp")],
    });
  });

  it("imports through the real CLI with roots derived by the host adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-cli-"));
    try {
      const sourcePath = join(root, "input", "triangle.gltf");
      const outDir = join(root, "packages", "triangle");
      await mkdir(dirname(sourcePath), { recursive: true });
      await mkdir(dirname(outDir), { recursive: true });
      await writeFile(
        sourcePath,
        await readFile(resolve("../../fixtures/imports/gltf-triangle/input.gltf")),
      );

      const result = await runCli([
        "debug",
        "gltf-import",
        "--tier",
        "write_local",
        "--source",
        sourcePath,
        "--out",
        outDir,
        "--created-by",
        "cli-test",
      ], { trustedLocalTier: true });

      expect(result).toMatchObject({
        ok: true,
        command: "debug.gltf-import",
        visibleState: {
          panel: "packages",
          operation: "scene3d.gltf.import",
          packageRoot: outDir,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
