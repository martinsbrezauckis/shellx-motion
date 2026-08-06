import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planCutImport } from "@shellx-motion/adapters-cut";
import {
  loadMotionPackage,
  lowerGltfToMotion,
  parseGltfContainer,
} from "@shellx-motion/core";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode.js";

describe("glTF scene3d Cut handoff", () => {
  it("keeps rich mesh rendering intact by selecting rendered media, never lossy editable lowering", async () => {
    const fixturePath = resolve("../../fixtures/imports/gltf-triangle/input.gltf");
    const bytes = await readFile(fixturePath);
    const container = parseGltfContainer(bytes, "gltf");
    const lowered = lowerGltfToMotion({
      adapterId: "adapter.gltf",
      sourcePath: fixturePath,
      sourceText: container.jsonText,
      normalizedPackagePath: "pkg_gltf_cut_test",
      container,
      createdBy: "connector-test",
      createdAt: "2026-07-13T10:00:00.000Z",
    });
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion = lowered.motion;
    pkg.manifest.id = "pkg_gltf_cut_test";

    const automatic = planCutImport(pkg, cutTargetCapabilitiesForMode({
      targetId: "shellx-cut",
      mode: "auto",
    }));
    expect(automatic).toMatchObject({
      ok: true,
      mode: "rendered_media",
      operations: [{
        verb: "cut.media.import_rendered",
        source: { packageId: "pkg_gltf_cut_test", render: "required" },
      }],
      unsupported: [{
        layerId: "gltf-scene",
        feature: "layer.type:scene3d",
        reason: expect.stringMatching(/cannot lower scene3d layers/),
      }],
    });

    const editableOnly = planCutImport(pkg, cutTargetCapabilitiesForMode({
      targetId: "shellx-cut",
      mode: "editable_lowering",
    }));
    expect(editableOnly).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: [expect.objectContaining({ feature: "layer.type:scene3d" })],
    });
  });
});
