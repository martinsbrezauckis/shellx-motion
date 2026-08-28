import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCommandTestAuthoringRoots } from "./authoring-test-context.test-support.js";
import { assertConfiguredAuthoringOutputRoot } from "./domains/authoring-root-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-authoring-test-context-"));
  roots.push(root);
  return root;
}

describe("test-only authoring root context", () => {
  it("uses the owned parent for an absent output directory", async () => {
    const root = await workspace();
    const packageRoot = join(root, "package");
    const outputParent = join(root, "outputs");
    await Promise.all([mkdir(packageRoot), mkdir(outputParent)]);

    const context = withCommandTestAuthoringRoots({}, "motion.package.patch", {
      packageRoot,
      outDir: join(outputParent, "revision")
    });

    expect(context).toMatchObject({
      authoringInputRoots: [resolve(packageRoot)],
      authoringOutputRoots: [resolve(outputParent)]
    });
  });

  it("uses an owned file parent so production can reject the file leaf", async () => {
    const root = await workspace();
    const packageRoot = join(root, "package");
    const outputRoot = join(root, "outputs");
    const outputPath = join(outputRoot, "not-a-directory.txt");
    await Promise.all([mkdir(packageRoot), mkdir(outputRoot)]);
    await writeFile(outputPath, "keep", "utf8");

    const context = withCommandTestAuthoringRoots({}, "motion.timeline.layer.track.assign", {
      packageRoot,
      outDir: outputPath
    });

    expect(context).toMatchObject({ authoringOutputRoots: [resolve(outputRoot)] });
    await expect(assertConfiguredAuthoringOutputRoot(
      outputPath,
      context.authoringOutputRoots,
      "track assignment output"
    )).rejects.toThrow("track assignment output must be inside an approved authoring output root and may not traverse symbolic links.");
  });

  it("grants Canvas selection input only through its containing fixture directory", async () => {
    const root = await workspace();
    const selectionRoot = join(root, "canvas-fixture");
    const packageDir = join(root, "package-output");
    const selectionPath = join(selectionRoot, "frame-selection.json");
    await Promise.all([mkdir(selectionRoot), mkdir(packageDir)]);
    await writeFile(selectionPath, "{}", "utf8");

    const context = withCommandTestAuthoringRoots({}, "motion.canvas.package", {
      canvasSelectionPath: selectionPath,
      packageDir
    });

    expect(context).toMatchObject({
      authoringInputRoots: [resolve(selectionRoot)],
      authoringOutputRoots: [resolve(packageDir)]
    });
  });

  it("keeps browser workflow evidence within its named scratch directories", async () => {
    const root = await workspace();
    const fixtureRoot = join(root, "fixture");
    const scratchRoot = join(root, "scratch");
    const workflowPath = join(fixtureRoot, "workflow.json");
    const catalogPath = join(scratchRoot, "browser-workflows.catalog.json");
    await Promise.all([mkdir(fixtureRoot), mkdir(scratchRoot)]);
    await writeFile(workflowPath, "{}", "utf8");

    const context = withCommandTestAuthoringRoots({}, "motion.browser.workflow.capture", {
      packageRoot: fixtureRoot,
      outDir: join(scratchRoot, "capture"),
      workflowPath,
      catalogPath
    });

    expect(context).toMatchObject({
      authoringInputRoots: [resolve(fixtureRoot)],
      authoringOutputRoots: [resolve(scratchRoot)]
    });
  });

  it("preserves explicit empty roots for fail-closed tests", () => {
    const context = withCommandTestAuthoringRoots({
      authoringInputRoots: [],
      authoringOutputRoots: []
    }, "motion.canvas.package", {
      canvasSelectionPath: "/owned/fixture/frame-selection.json",
      packageDir: "/owned/output"
    });

    expect(context.authoringInputRoots).toEqual([]);
    expect(context.authoringOutputRoots).toEqual([]);
  });
});
