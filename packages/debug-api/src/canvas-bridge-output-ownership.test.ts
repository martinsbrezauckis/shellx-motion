import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("Canvas bridge Debug output ownership", () => {
  it("keeps receipt publication fail-closed even when force is supplied", async () => {
    const canvasRoot = await writeCanvasBridgeRoot();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-bridge-receipt-"));
    const outPath = join(outDir, "frame-selection.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    const previousTrustedRoots = process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
    process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = canvasRoot;
    await writeFile(receiptPath, "MY RECEIPT", "utf8");
    try {
      const result = await dispatchDebugCommand(
        "motion.canvas.bridge_export",
        { canvasRoot, outPath, force: true },
        { tier: "write_local", authoringOutputRoots: [outDir] }
      );

      expect(result).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
      expect(await readFile(receiptPath, "utf8")).toBe("MY RECEIPT");
      await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousTrustedRoots === undefined) delete process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS;
      else process.env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS = previousTrustedRoots;
      await rm(outDir, { recursive: true, force: true });
      await rm(canvasRoot, { recursive: true, force: true });
    }
  });
});

async function writeCanvasBridgeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-root-"));
  await mkdir(join(root, "app", "server"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
  await writeFile(
    join(root, "app", "server", "motion-package.mjs"),
    `
      import { mkdir, writeFile } from "node:fs/promises";
      import { dirname } from "node:path";
      export function buildMotionFrameSelection() {
        return { schema: "shellx-canvas/frame-selection@1", selectedFrameId: "frame_debug", frames: [] };
      }
      export async function writeMotionFrameSelection(selection, options) {
        await mkdir(dirname(options.outPath), { recursive: true, mode: 0o700 });
        await writeFile(options.outPath, JSON.stringify(selection), "utf8");
        return { path: options.outPath, schema: selection.schema };
      }
    `,
    "utf8"
  );
  return root;
}
