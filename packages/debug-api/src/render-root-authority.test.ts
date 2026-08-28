/** R4: host-admitted render roots survive from command parsing to the rows open. */
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchRenderBatchCommand } from "./domains/render-batch";
import { dispatchDebugCommand } from "./index";

const PACKAGE_ROOT = resolve("../../fixtures/packages/batch-card");

describe("R4 render root authority", () => {
  it("does not let an approved packageRoot become caller-selected external file authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-root-package-input-"));
    const inputRoot = join(root, "host-inputs");
    const outputRoot = join(root, "output-root");
    const outDir = join(outputRoot, "batch");
    const packageRowsPath = join(PACKAGE_ROOT, "data", "rows.json");
    const hostRowsPath = join(inputRoot, "rows.json");
    const requests: unknown[] = [];
    const services = {
      renderRootPolicy: {
        enforce: true,
        packageRoots: [dirname(PACKAGE_ROOT)],
        inputRoots: [inputRoot],
        outputRoots: [outputRoot]
      },
      executeBatchPlan: async (request: unknown) => {
        requests.push(request);
        return { ok: true as const, warnings: [] };
      }
    };
    try {
      await mkdir(inputRoot, { mode: 0o700 });
      await mkdir(outputRoot, { mode: 0o700 });
      await chmod(inputRoot, 0o700);
      await chmod(outputRoot, 0o700);

      for (const field of ["rowsPath", "workflowPath", "qualityManifestPath"] as const) {
        const unauthorized = await dispatchRenderBatchCommand(
          "motion.render.batch",
          { packageRoot: PACKAGE_ROOT, [field]: packageRowsPath, outDir, preset: "mp4-h264", dryRun: true },
          services
        );

        expect(unauthorized).toMatchObject({
          ok: false,
          error: { code: "invalid_args", message: expect.stringMatching(new RegExp(`${field}.*approved render input root`, "i")) }
        });
        await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(requests).toEqual([]);
      await writeFile(hostRowsPath, '[{"id":"ada","values":{"title":"Ada"}}]\n', "utf8");

      const hostAuthorizedRows = await dispatchRenderBatchCommand(
        "motion.render.batch",
        { packageRoot: PACKAGE_ROOT, rowsPath: hostRowsPath, outDir, preset: "mp4-h264", dryRun: true },
        services
      );

      expect(hostAuthorizedRows).toMatchObject({ ok: true });
      expect(requests).toMatchObject([{ packageRoot: PACKAGE_ROOT, rowsPath: hostRowsPath }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("retains the admitted rows root through stable open and refuses a replacement race before output admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-root-race-"));
    const rowsRoot = join(root, "rows-root");
    const movedRowsRoot = join(root, "rows-root-replaced");
    const outputRoot = join(root, "output-root");
    const rowsPath = join(rowsRoot, "rows.json");
    const outDir = join(outputRoot, "batch");
    try {
      await mkdir(rowsRoot, { mode: 0o700 });
      await mkdir(outputRoot, { mode: 0o700 });
      await chmod(rowsRoot, 0o700);
      await chmod(outputRoot, 0o700);
      await writeFile(rowsPath, '[{"id":"ada","values":{"title":"Ada"}}]\n', "utf8");

      const result = await dispatchDebugCommand(
        "motion.render.batch",
        { packageRoot: PACKAGE_ROOT, rowsPath, outDir, preset: "mp4-h264", dryRun: true },
        {
          tier: "render_motion",
          enforceRenderRoots: true,
          renderPackageRoots: [dirname(PACKAGE_ROOT)],
          renderInputRoots: [rowsRoot],
          renderOutputRoots: [outputRoot],
          batchRowsPathAfterAdmission: async () => {
            await rename(rowsRoot, movedRowsRoot);
            await mkdir(rowsRoot, { mode: 0o700 });
            await chmod(rowsRoot, 0o700);
            await writeFile(rowsPath, '[{"id":"foreign","values":{"title":"Foreign"}}]\n', "utf8");
          }
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "render_batch_failed", message: expect.stringMatching(/trusted workspace anchor changed/i) }
      });
      await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a request widen a configured final output root", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-root-final-"));
    const outputRoot = join(root, "allowed");
    const outside = join(root, "outside", "render.mp4");
    try {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      const result = await dispatchDebugCommand(
        "motion.render.final",
        { packageRoot: PACKAGE_ROOT, outputPath: outside, preset: "mp4-h264", dryRun: true },
        {
          tier: "render_motion",
          enforceRenderRoots: true,
          renderPackageRoots: [dirname(PACKAGE_ROOT)],
          renderInputRoots: [dirname(PACKAGE_ROOT)],
          renderOutputRoots: [outputRoot]
        }
      );
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringMatching(/approved render output root/i) } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
