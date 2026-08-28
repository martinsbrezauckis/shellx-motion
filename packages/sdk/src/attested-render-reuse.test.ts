/** Local SDK parity for the opt-in Debug-owned v2 attested-reuse route. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuffer } from "@shellx-motion/core";
import { createLocalMotionSdk } from "./local";

const tempRoots: string[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gJ+41Xk4QAAAABJRU5ErkJggg==", "base64");

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("local SDK attested render reuse", () => {
  it("delegates to the v2 Debug authority without creating or reading a legacy artifact descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-attested-reuse-"));
    tempRoots.push(root);
    const outputPath = join(root, "frame.png");
    await mkdir(join(root, ".shellx-motion", "receipts"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, ".shellx-motion", "render-reuse", "v2"), { recursive: true, mode: 0o700 });
    let browserCalls = 0;
    const sdk = createLocalMotionSdk({
      browserFrameRenderer: async (pkg, options) => {
        browserCalls += 1;
        const path = options.outputPath ?? join(options.outDir, "frame.png");
        await writeFile(path, PNG);
        const output = {
          path,
          sha256: hashBuffer(PNG),
          format: "png" as const,
          width: pkg.motion.width,
          height: pkg.motion.height,
          atMs: options.atMs,
          browser: { name: "chromium", version: "sdk-attested-reuse-test" },
          viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
        };
        return {
          ok: true,
          output,
          receipt: {
            schema: "shellx-motion/receipt@1",
            id: `preview-${options.atMs}`,
            operation: "preview.frame",
            status: "passed",
            packageId: pkg.manifest.id,
            inputHashes: { motion: "a".repeat(64) },
            createdAt: "2026-08-09T00:00:00.000Z",
            lane: "browser",
            output,
            warnings: []
          }
        };
      }
    });
    const input = { packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame" as const, reuseAttested: true };

    const first = await sdk.render(input);
    const second = await sdk.render(input);

    expect(first).toMatchObject({ ok: true, output: { outputPath, artifact: { schema: "shellx-motion/artifact-handle@1" } } });
    expect(second).toMatchObject({ ok: true, output: { outputPath, artifact: { schema: "shellx-motion/artifact-handle@1" } } });
    expect(browserCalls).toBe(1);
    const v2Entries = await readdir(join(root, ".shellx-motion", "render-reuse", "v2"));
    expect(v2Entries.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".producer.json"))).toHaveLength(1);
    expect(v2Entries.filter((entry) => entry.endsWith(".producer.json"))).toHaveLength(1);
    await expect(readdir(join(root, ".shellx-motion", "artifacts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(outputPath))).toContain("frame.png");
  });
});
