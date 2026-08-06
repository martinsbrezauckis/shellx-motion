import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDebugCommandContracts, debugCommandDefinition } from "../command-registry.js";
import { SCENE3D_COMMAND_METADATA } from "../command-metadata-scene3d.js";
import { writeStaticGltfPackage } from "./authoring-gltf-package.js";
import { dispatchGltfAuthoringCommand } from "./authoring-gltf.js";

const fixturePath = resolve("../../fixtures/imports/gltf-triangle/input.gltf");
const tempDirs: string[] = [];

describe("glTF authoring debug command", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("is a permissioned write-local command with a receipt contract", () => {
    expect(debugCommandDefinition("motion.scene3d.gltf.import")).toMatchObject({
      domain: "authoring",
      permission: "write_local",
      mutates: true,
    });
    const contract = buildDebugCommandContracts(SCENE3D_COMMAND_METADATA)
      .find((value) => value.command === "motion.scene3d.gltf.import");
    expect(contract).toMatchObject({
      argsSchema: { required: ["sourcePath", "outDir"], additionalProperties: false },
      expectedReceipts: [{ operation: "adapter.lower", mode: "emits", required: true }],
    });
  });

  it("imports through host-owned roots and returns package-visible state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-gltf-command-"));
    tempDirs.push(root);
    const sourcePath = join(root, "input", "triangle.gltf");
    const outDir = join(root, "packages", "triangle");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, await readFile(fixturePath));

    const result = await dispatchGltfAuthoringCommand("motion.scene3d.gltf.import", {
      sourcePath,
      outDir,
      createdBy: "debug-command-test",
      createdAt: "2026-07-13T09:00:00.000Z",
    }, {
      gltfPackageWriter: writeStaticGltfPackage,
      authoringInputRoots: [root],
      authoringOutputRoots: [root],
    });

    expect(result).toMatchObject({
      ok: true,
      receiptId: expect.stringMatching(/^adapter-lowering-gltf-/),
      visibleState: {
        panel: "packages",
        operation: "scene3d.gltf.import",
        packageRoot: outDir,
        format: "gltf",
      },
      warnings: [expect.stringMatching(/Generated flat vertex normals/)],
    });
  });

  it("does not let command arguments establish filesystem trust", async () => {
    const result = await dispatchGltfAuthoringCommand("motion.scene3d.gltf.import", {
      sourcePath: "/tmp/input.gltf",
      outDir: "/tmp/package",
      inputRoots: ["/"],
      outputRoots: ["/"],
    }, { gltfPackageWriter: writeStaticGltfPackage });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved/) },
    });
  });
});
