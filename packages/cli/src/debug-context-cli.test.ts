import { describe, expect, it } from "vitest";
import { cliDebugDispatchContext, sourceWorkspaceOperationPaths } from "./debug-context-cli";

describe("cliDebugDispatchContext", () => {
  it("keeps direct CLI render roots and scratch-root precedence host-owned", () => {
    const context = cliDebugDispatchContext({
      debugName: "motion.render.final",
      tier: "render_motion",
      actor: { kind: "host", label: "cli", transport: "cli", sessionId: "cli-test", grantedTier: "render_motion" },
      callerId: "cli:local",
      scratchRoot: "/host/scratch",
      cliReceiptsRoot: "/operator/receipts",
      renderRoots: {
        packageRoots: ["/packages/lower-third"],
        inputRoots: ["/packages/lower-third", "/workflow"],
        outputRoots: ["/renders"]
      }
    });

    expect(context).toMatchObject({
      scratchRoot: "/host/scratch",
      renderPackageRoots: ["/packages/lower-third"],
      renderInputRoots: ["/packages/lower-third", "/workflow"],
      renderOutputRoots: ["/renders"],
      callerId: "cli:local",
      crossCallerJobScope: true
    });
    expect(context.receiptsRoot).toBeUndefined();
  });

  it("anchors the public import source and output beneath the source checkout", () => {
    for (const command of [
      "motion.scene3d.gltf.import",
      "motion.lottie.import",
      "motion.dotlottie.import",
    ] as const) {
      expect(sourceWorkspaceOperationPaths(command, {
        sourcePath: "/workspace/fixtures/input",
        outDir: "/workspace/.scratch/import-package",
      })).toEqual(["/workspace/fixtures/input", "/workspace/.scratch/import-package"]);
    }
  });
});
