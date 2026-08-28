import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refuseUntrustedCallerRenderPaths } from "./caller-boundary.js";
import { dispatchCallerSteeredCommand, dispatchDebugCommand } from "./index.js";

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../fixtures/packages/lower-third");

describe("caller render-path boundary", () => {
  it("derives package admission from read, draft, and render command contracts without fencing direct dispatch", async () => {
    const approvedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-caller-render-approved-"));
    try {
      for (const testCase of [
        { command: "motion.timeline.inspect" as const, tier: "read_motion" as const, args: { packageRoot: PACKAGE_ROOT } },
        { command: "motion.timeline.playhead.set" as const, tier: "draft_motion" as const, args: { packageRoot: PACKAGE_ROOT } },
        { command: "motion.browser.workflow.capture" as const, tier: "render_motion" as const, args: { packageRoot: PACKAGE_ROOT } }
      ]) {
        const result = await dispatchCallerSteeredCommand(testCase.command, testCase.args, {
          tier: testCase.tier,
          enforceRenderRoots: true,
          renderPackageRoots: [approvedRoot]
        });
        expect(result).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
      }

      // `dispatchDebugCommand` remains the deliberately unfenced in-process API.
      const direct = await dispatchDebugCommand("motion.timeline.inspect", { packageRoot: PACKAGE_ROOT }, {
        tier: "read_motion",
        enforceRenderRoots: true,
        renderPackageRoots: [approvedRoot]
      });
      expect(direct).not.toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
    } finally {
      await rm(approvedRoot, { recursive: true, force: true });
    }
  });

  it("refuses preview output paths before preview code can create or render to them", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-preview-output-"));
    const approvedOutput = join(root, "approved-output");
    const outsideOutput = join(root, "outside-output");
    await mkdir(approvedOutput, { mode: 0o700 });
    try {
      const context = {
        tier: "render_motion" as const,
        enforceRenderRoots: true,
        renderPackageRoots: [PACKAGE_ROOT],
        renderOutputRoots: [approvedOutput]
      };
      for (const command of ["motion.preview.frame", "motion.preview.playhead", "motion.preview.strip"] as const) {
        const result = await dispatchCallerSteeredCommand(command, {
          packageRoot: PACKAGE_ROOT,
          outDir: join(outsideOutput, command)
        }, context);
        expect(result).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
      }
      for (const command of ["motion.preview.frame", "motion.preview.playhead"] as const) {
        const result = await dispatchCallerSteeredCommand(command, {
          packageRoot: PACKAGE_ROOT,
          outDir: approvedOutput,
          outputPath: join(outsideOutput, `${command}.png`)
        }, context);
        expect(result).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
      }
      await expect(rm(outsideOutput, { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an omitted preview outDir to the host-owned scratch default", async () => {
    const refusal = await refuseUntrustedCallerRenderPaths("motion.preview.frame", { packageRoot: PACKAGE_ROOT }, {
      tier: "render_motion",
      enforceRenderRoots: true,
      renderPackageRoots: [PACKAGE_ROOT]
    });
    expect(refusal).toBeNull();
  });

  it("fences cache-plan output and external identity inputs without creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-cache-plan-"));
    const approvedOutput = join(root, "approved-output");
    const approvedInput = join(root, "approved-input");
    const outsideOutput = join(root, "outside-output", "result.mp4");
    const outsideInput = join(root, "outside-input.json");
    await mkdir(approvedOutput, { mode: 0o700 });
    await mkdir(approvedInput, { mode: 0o700 });
    await writeFile(outsideInput, "{}", { mode: 0o600 });
    const context = {
      tier: "render_motion" as const,
      enforceRenderRoots: true,
      renderPackageRoots: [PACKAGE_ROOT],
      renderInputRoots: [approvedInput],
      renderOutputRoots: [approvedOutput]
    };
    try {
      const outputRefusal = await dispatchCallerSteeredCommand("motion.render.cache.plan", {
        packageRoot: PACKAGE_ROOT,
        outputPath: outsideOutput,
        preset: "mp4-h264"
      }, context);
      expect(outputRefusal).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });

      const inputRefusal = await dispatchCallerSteeredCommand("motion.render.cache.plan", {
        packageRoot: PACKAGE_ROOT,
        outputPath: join(approvedOutput, "result.mp4"),
        preset: "mp4-h264",
        workflowPath: outsideInput
      }, context);
      expect(inputRefusal).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
      await expect(rm(join(root, "outside-output"), { recursive: true })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits every browser alias and every packageRoots entry against render roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-browse-roots-"));
    const approvedRoot = join(root, "approved");
    const foreignRoot = join(root, "foreign");
    const acceptedRoots = ["from-array-a", "from-array-b", "direct", "plural", "browser", "root"]
      .map((name) => join(approvedRoot, name));
    await Promise.all([mkdir(approvedRoot, { recursive: true, mode: 0o700 }), mkdir(foreignRoot, { mode: 0o700 })]);
    await Promise.all(acceptedRoots.map(async (candidate) => await mkdir(candidate, { mode: 0o700 })));
    const context = { tier: "read_motion" as const, enforceRenderRoots: true, renderPackageRoots: [approvedRoot] };
    try {
      const refused = await dispatchCallerSteeredCommand("motion.packages.browse", {
        packageRoots: [acceptedRoots[0], foreignRoot],
        packageRoot: acceptedRoots[2],
        packagesRoot: acceptedRoots[3],
        packageBrowserRoot: acceptedRoots[4],
        root: acceptedRoots[5]
      }, context);
      expect(refused).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });

      const admitted = await dispatchCallerSteeredCommand("motion.packages.browse", {
        packageRoots: acceptedRoots.slice(0, 2),
        packageRoot: acceptedRoots[2],
        packagesRoot: acceptedRoots[3],
        packageBrowserRoot: acceptedRoots[4],
        root: acceptedRoots[5]
      }, context);
      expect(admitted).toMatchObject({ ok: true, result: { roots: expect.arrayContaining(acceptedRoots) } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps template catalog and plan roots separate from render roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-template-roots-"));
    const templateRoot = join(root, "templates");
    const foreignRoot = join(root, "foreign");
    const firstTemplate = join(templateRoot, "first");
    const secondTemplate = join(templateRoot, "second");
    await mkdir(templateRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      mkdir(firstTemplate, { mode: 0o700 }),
      mkdir(secondTemplate, { mode: 0o700 }),
      mkdir(foreignRoot, { mode: 0o700 })
    ]);
    const context = { tier: "read_motion" as const, enforceRenderRoots: true, templateRoots: [templateRoot] };
    try {
      for (const command of ["motion.template.catalog", "motion.template.plan"] as const) {
        const args = {
          packageRoots: [firstTemplate, foreignRoot],
          packageRoot: secondTemplate,
          templateRoot,
          templatesRoot: firstTemplate,
          root: secondTemplate,
          ...(command === "motion.template.plan" ? { request: "test template" } : {})
        };
        const refused = await dispatchCallerSteeredCommand(command, args, context);
        expect(refused).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
      }

      const catalog = await dispatchCallerSteeredCommand("motion.template.catalog", {
        packageRoots: [firstTemplate, secondTemplate], packageRoot: firstTemplate,
        templateRoot, templatesRoot: secondTemplate, root: templateRoot
      }, context);
      // The empty test directories intentionally produce an empty catalog; reaching that result
      // proves the caller boundary admitted every spelling without adding templateRoots to render.
      expect(catalog).toMatchObject({ ok: true, result: { ok: true } });

      const browseStillRefused = await dispatchCallerSteeredCommand("motion.packages.browse", { root: templateRoot }, context);
      expect(browseStillRefused).toMatchObject({ ok: false, error: { code: "render_path_not_approved" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
