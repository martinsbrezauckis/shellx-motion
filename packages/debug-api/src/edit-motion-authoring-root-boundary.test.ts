import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchCallerSteeredCommand } from "./index.js";

const fixture = resolve("../../fixtures/packages/lower-third");
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("edit_motion authoring root boundary", () => {
  it("fails closed without host-approved roots before package loading", async () => {
    const result = await dispatchCallerSteeredCommand("motion.timeline.transition.preset.apply", {
      packageRoot: fixture,
      outDir: join(dirname(fixture), "unapproved-edit"),
      layerId: "title",
      preset: "soft-fade",
    }, { tier: "edit_motion" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "authoring_path_not_approved", message: expect.stringMatching(/host-approved authoring input and output roots/) },
    });
  });

  it("refuses input and output paths outside the host roots without publishing", async () => {
    const root = await privateRoot("shellx-motion-edit-roots-");
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const outsideInput = join(root, "outside-input");
    const outsideOutput = join(root, "outside-output");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 })]);
    await cp(fixture, outsideInput, { recursive: true });

    const context = { tier: "edit_motion" as const, authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] };
    const inputRefusal = await dispatchCallerSteeredCommand("motion.timeline.transition.preset.apply", {
      packageRoot: outsideInput, outDir: join(outputRoot, "input-refusal"), layerId: "title", preset: "soft-fade",
    }, context);
    const outputRefusal = await dispatchCallerSteeredCommand("motion.timeline.transition.preset.apply", {
      packageRoot: fixture, outDir: outsideOutput, layerId: "title", preset: "soft-fade",
    }, { ...context, authoringInputRoots: [dirname(fixture)] });

    expect(inputRefusal).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    expect(outputRefusal).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    await expect(lstat(join(outputRoot, "input-refusal"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(outsideOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked package route and accepts stable private roots", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot("shellx-motion-edit-symlink-");
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const packageRoot = join(inputRoot, "package");
    const linkedPackage = join(inputRoot, "linked-package");
    await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 })]);
    await cp(fixture, packageRoot, { recursive: true });
    await symlink(packageRoot, linkedPackage, "dir");
    const context = { tier: "edit_motion" as const, authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] };

    const refused = await dispatchCallerSteeredCommand("motion.timeline.transition.preset.apply", {
      packageRoot: linkedPackage, outDir: join(outputRoot, "refused"), layerId: "title", preset: "soft-fade",
    }, context);
    expect(refused).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });

    const acceptedOut = join(outputRoot, "accepted");
    const accepted = await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), async () =>
      await dispatchCallerSteeredCommand("motion.timeline.transition.preset.apply", {
        packageRoot, outDir: acceptedOut, layerId: "title", preset: "soft-fade",
      }, context)
    );
    expect(accepted).toMatchObject({ ok: true, result: { packageDir: acceptedOut } });
    await expect(readFile(join(acceptedOut, "receipts", "timeline-transition-preset-apply.receipt.json"), "utf8")).resolves.toContain('"status": "passed"');
  });

  it("refuses template replacement media outside the host-approved input roots before publication", async () => {
    const root = await privateRoot("shellx-motion-edit-template-media-roots-");
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const outsideRoot = join(root, "outside");
    const packageRoot = join(inputRoot, "package");
    const assetPath = join(outsideRoot, "replacement.png");
    const outDir = join(outputRoot, "blocked");
    await Promise.all([
      mkdir(inputRoot, { mode: 0o700 }),
      mkdir(outputRoot, { mode: 0o700 }),
      mkdir(outsideRoot, { mode: 0o700 }),
    ]);
    await Promise.all([cp(fixture, packageRoot, { recursive: true }), writeFile(assetPath, "private media", "utf8")]);

    const result = await dispatchCallerSteeredCommand("motion.template.media.replace", {
      packageRoot,
      outDir,
      paramId: "headshot",
      assetPath,
    }, { tier: "edit_motion", authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
