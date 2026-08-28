import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { localRenderOptions } from "./local-debug-context";

describe("localRenderOptions", () => {
  const request = {
    packageRoot: resolve("package"),
    outputPath: resolve("artifacts/render.mp4"),
    preset: "mp4-h264",
    workflowPath: resolve("workflows/capture.json"),
    qualityManifestPath: resolve("quality/manifest.json")
  };

  it("does not widen roots a boundary host already supplied", () => {
    const hostOptions = {
      renderPackageRoots: [resolve("server/packages")],
      renderInputRoots: [resolve("server/inputs")],
      renderOutputRoots: [resolve("server/outputs")],
      enforceRenderRoots: true
    };

    expect(localRenderOptions(hostOptions, request, request.packageRoot, resolve("artifacts"))).toBe(hostOptions);
  });

  it("derives the direct host's narrow package, input, and output roots", () => {
    expect(localRenderOptions({}, request, request.packageRoot, resolve("artifacts"))).toMatchObject({
      renderPackageRoots: [request.packageRoot],
      renderInputRoots: [request.packageRoot, dirname(request.workflowPath), dirname(request.qualityManifestPath)],
      renderOutputRoots: [resolve("artifacts")]
    });
  });
});
