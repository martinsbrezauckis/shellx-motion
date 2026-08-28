import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { gltfAuthoringRoots, gltfDebugArgs, GLTF_DEBUG_COMMANDS } from "./gltf-cli.js";
import { runCli } from "./main.js";

describe("modular glTF CLI", () => {
  it("maps and parses a local import without exposing trust-root flags", () => {
    const previousInitCwd = process.env.INIT_CWD;
    try {
      process.env.INIT_CWD = process.cwd();
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
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
    }
  });

  it("resolves relative paths from INIT_CWD for the documented source-checkout form", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-init-cwd-"));
    const previousInitCwd = process.env.INIT_CWD;
    try {
      await mkdir(join(root, "fixtures"), { recursive: true });
      await writeFile(join(root, "fixtures", "model.gltf"), "{}");
      process.env.INIT_CWD = root;

      expect(gltfDebugArgs("motion.scene3d.gltf.import", [
        "--source", "fixtures/model.gltf",
        "--out", ".scratch/model-package",
      ])).toMatchObject({
        sourcePath: join(root, "fixtures", "model.gltf"),
        outDir: join(root, ".scratch", "model-package"),
      });
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses process cwd for the installed form when INIT_CWD is absent", () => {
    const previousInitCwd = process.env.INIT_CWD;
    try {
      delete process.env.INIT_CWD;
      expect(gltfDebugArgs("motion.scene3d.gltf.import", [
        "--source", "installed/model.gltf",
        "--out", ".scratch/model-package",
      ])).toMatchObject({
        sourcePath: resolve("installed/model.gltf"),
        outDir: resolve(".scratch/model-package"),
      });
    } finally {
      if (previousInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = previousInitCwd;
    }
  });

  it("normalizes extended Windows and UNC paths before deriving import arguments", () => {
    expect(gltfDebugArgs("motion.scene3d.gltf.import", [
      "--source", String.raw`\\?\C:\Motion\fixtures\triangle.gltf`,
      "--out", String.raw`\\?\UNC\server\share\Motion\triangle-package`,
    ])).toMatchObject({
      sourcePath: String.raw`C:\Motion\fixtures\triangle.gltf`,
      outDir: String.raw`\\server\share\Motion\triangle-package`,
    });
  });

  it("imports through the real CLI with roots derived by the host adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-cli-"));
    try {
      const sourcePath = join(root, "input", "triangle.gltf");
      const outDir = join(root, "packages", "triangle");
      await mkdir(dirname(sourcePath), { recursive: true, mode: 0o700 });
      await mkdir(dirname(outDir), { recursive: true, mode: 0o700 });
      await writeFile(
        sourcePath,
        await readFile(resolve(import.meta.dirname, "../../../fixtures/imports/gltf-triangle/input.gltf")),
      );

      const result = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () => await runCli([
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
      ], { trustedLocalTier: true }));

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
