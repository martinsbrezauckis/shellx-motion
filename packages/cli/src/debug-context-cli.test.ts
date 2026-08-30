import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { activeTrustedWorkspaceAnchorForTarget } from "@shellx-motion/core/internal/trusted-host-workspace";
import { cliAuthoringRoots } from "./debug-authoring-roots";
import { cliDebugDispatchContext, rawDebugFileInputPaths, sourceWorkspaceOperationPaths, withCliSourceWorkspaceAnchor } from "./debug-context-cli";

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

  it("uses the generic authoring-root selection for public imports", () => {
    for (const command of [
      "motion.scene3d.gltf.import",
      "motion.lottie.import",
      "motion.dotlottie.import",
    ] as const) {
      const args = {
        sourcePath: "/workspace/fixtures/input",
        outDir: "/workspace/.scratch/import-package",
      };
      expect(sourceWorkspaceOperationPaths(args, cliAuthoringRoots(command, args))).toEqual([
        resolve("/workspace/fixtures"),
        resolve("/workspace/.scratch"),
      ]);
    }
  });

  it.skipIf(process.platform === "win32")("anchors generic timeline COW roots only when every selected input and output stays inside the source checkout", async () => {
    const checkout = resolve(process.cwd(), "../..");
    const source = join(checkout, "fixtures", "packages", "lower-third");
    const output = join(checkout, ".scratch", "debug-context-cli", "revision");
    const internalArgs = { packageRoot: source, outDir: output };
    const internalPaths = sourceWorkspaceOperationPaths(internalArgs, cliAuthoringRoots("motion.timeline.layer.trim", internalArgs));

    expect(internalPaths).toEqual([dirnameOf(source), dirnameOf(output)]);
    const anchored = await withCliSourceWorkspaceAnchor(internalPaths, async () => await activeTrustedWorkspaceAnchorForTarget(source));
    expect(anchored?.path).toBe(checkout);

    for (const externalArgs of [
      { packageRoot: "/outside/source", outDir: output },
      { packageRoot: source, outDir: "/outside/revision" },
    ]) {
      const paths = sourceWorkspaceOperationPaths(externalArgs, cliAuthoringRoots("motion.timeline.layer.trim", externalArgs));
      const unanchored = await withCliSourceWorkspaceAnchor(paths, async () => await activeTrustedWorkspaceAnchorForTarget(source));
      expect(unanchored).toBeUndefined();
    }

    const pathsWithExternalRawFile = sourceWorkspaceOperationPaths(
      internalArgs,
      cliAuthoringRoots("motion.timeline.layer.trim", internalArgs),
      undefined,
      ["/outside/selected-patch.json"],
    );
    const unanchoredRawFile = await withCliSourceWorkspaceAnchor(pathsWithExternalRawFile, async () => await activeTrustedWorkspaceAnchorForTarget(source));
    expect(unanchoredRawFile).toBeUndefined();
  });

  it("retains every authoring-root input plus CLI and host receipt supplements for caption import", () => {
    const args = {
      packageRoot: "/workspace/packages/source",
      captionsPath: "/workspace/captions/launch.srt",
      outDir: "/workspace/revisions/captioned",
      receiptsRoot: "/workspace/receipts/caller",
    };
    expect(sourceWorkspaceOperationPaths(
      args,
      cliAuthoringRoots("motion.timeline.caption.import", args),
      "/workspace/.scratch/host-receipts/captions",
    )).toEqual([
      resolve("/workspace/packages"),
      resolve("/workspace/captions"),
      resolve("/workspace/revisions"),
      resolve("/workspace/receipts/caller"),
      resolve("/workspace/.scratch/host-receipts/captions"),
    ]);
  });

  it("retains generic raw CLI file-valued inputs after typed Debug parsing", () => {
    const rawFileInputs = rawDebugFileInputPaths([
      "package-patch",
      "--graph-file", "inputs/graph.json",
      "--relationship-file", "inputs/relationship.json",
      "--patch-file", "inputs/patch.json",
      "--policy-file", "inputs/policy.json",
    ], (path) => resolve("/workspace", path));
    expect(rawFileInputs).toEqual([
      "/workspace/inputs/graph.json",
      "/workspace/inputs/relationship.json",
      "/workspace/inputs/patch.json",
      "/workspace/inputs/policy.json",
    ]);

    const args = { packageRoot: "/workspace/packages/source", outDir: "/workspace/revisions/final" };
    expect(sourceWorkspaceOperationPaths(
      args,
      cliAuthoringRoots("motion.package.patch", args),
      undefined,
      rawFileInputs,
    )).toEqual([
      "/workspace/packages",
      "/workspace/revisions",
      "/workspace/inputs/graph.json",
      "/workspace/inputs/relationship.json",
      "/workspace/inputs/patch.json",
      "/workspace/inputs/policy.json",
    ]);
  });
});

function dirnameOf(path: string): string {
  return resolve(path, "..");
}
