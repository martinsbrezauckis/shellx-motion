/**
 * Pins the boundary between "this operation worked" and "here is what the content looks like" on
 * `motion.preview.strip`.
 *
 * A successful deliverable must not be reported as `warning` merely because an advisory note was
 * pushed into the same `warnings` array that derives receipt status. The motion-density probe
 * is exactly such an advisory — a deliberately static title card is legitimate output — so it must
 * ride `warnings` (where authors, the debug API response and the MCP surface already look) WITHOUT
 * ever moving the receipt off `passed`. Warnings that describe the preview render itself keep their
 * existing power to downgrade.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";
import { encodeRgbaPng, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";

const dirs: string[] = [];

/** A real, decodable PNG so the motion probe measures rather than reporting "unavailable". */
function solidPng(rgb: [number, number, number]): Buffer {
  const width = 8;
  const height = 8;
  const rgba = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = rgb[0];
    rgba[offset + 1] = rgb[1];
    rgba[offset + 2] = rgb[2];
    rgba[offset + 3] = 255;
  }
  return encodeRgbaPng(width, height, rgba);
}

/**
 * Drive a strip with a stubbed frame renderer.
 *
 * @param frameColor Colour for the frame at a given index — vary it for a moving piece, hold it
 *   constant for a frozen one.
 * @param frameWarnings Warnings the stubbed frame receipts carry (i.e. problems with the preview
 *   render itself, as opposed to observations about the content).
 */
async function runStrip(
  frameColor: (index: number) => [number, number, number],
  frameWarnings: string[] = []
): Promise<{ status: string; warnings: string[]; motion: Record<string, unknown> }> {
  const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-strip-motion-"));
  dirs.push(outDir);
  let index = 0;
  const dispatched = await dispatchDebugCommand(
    "motion.preview.strip",
    { packageRoot: "../../fixtures/packages/keyframed-lower-third", outDir, frameCount: 6, startMs: 0, endMs: 2500, createdAt: "2026-08-03T00:00:00.000Z" },
    {
      tier: "render_motion",
      browserFrameRenderer: async (pkg: MotionPackage, options: { atMs: number; outDir: string; outputPath?: string }) => {
        const outputPath = options.outputPath ?? join(options.outDir, `strip-${options.atMs}.png`);
        await writeFile(outputPath, solidPng(frameColor(index)));
        index += 1;
        return {
          ok: true as const,
          output: {
            path: outputPath, sha256: "a".repeat(64), width: 8, height: 8, atMs: options.atMs,
            browser: { name: "chromium", version: "test" },
            viewport: { width: 8, height: 8, deviceScaleFactor: 1 }
          },
          receipt: {
            schema: "shellx-motion/receipt@1", id: `frame-${options.atMs}`, operation: "preview.frame",
            status: frameWarnings.length > 0 ? "warning" : "passed", packageId: pkg.manifest.id,
            inputHashes: { motion: "c".repeat(64) }, createdAt: "2026-08-03T00:00:00.000Z", lane: "browser",
            output: { path: outputPath, atMs: options.atMs }, warnings: frameWarnings
          } as OperationReceipt
        };
      }
    }
  );
  expect(dispatched.ok).toBe(true);
  if (!dispatched.ok) throw new Error("strip dispatch failed");
  const result = dispatched.result as { receipt: OperationReceipt; motion: Record<string, unknown> };
  return { status: result.receipt.status, warnings: dispatched.warnings, motion: result.motion };
}

describe("preview strip motion density and receipt status", () => {
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reports passed with no warnings for a strip whose every sample moves", async () => {
    const { status, warnings, motion } = await runStrip((index) => [index * 40, 30, 90]);

    expect(status).toBe("passed");
    expect(warnings).toEqual([]);
    expect(motion).toMatchObject({ status: "analyzed", coverage: "sampled", stillIntervalRatio: 0 });
  });

  it("still reports passed for a fully static piece, and says so in the warnings", async () => {
    const { status, warnings, motion } = await runStrip(() => [24, 80, 160]);

    // The observation is delivered...
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Preview strip saw no visible change across 5 of 5 sampled intervals");
    expect(motion).toMatchObject({ status: "analyzed", coverage: "sampled", stillIntervalRatio: 1 });
    // ...without claiming the operation failed. A static title card is legitimate output.
    expect(status).toBe("passed");
  });

  it("keeps a real preview-render problem downgrading the receipt", async () => {
    const { status, warnings } = await runStrip((index) => [index * 40, 30, 90], ["Native renderer used fallback block glyphs."]);

    expect(status).toBe("warning");
    expect(warnings).toContain("Native renderer used fallback block glyphs.");
  });

  it("never reports a frozen percentage or frozen ranges from sampled strip frames", async () => {
    const { motion } = await runStrip(() => [24, 80, 160]);

    expect(motion).not.toHaveProperty("frozenRatio");
    expect(motion).not.toHaveProperty("frozenRanges");
    expect(motion).not.toHaveProperty("frozenMs");
  });
});
