import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startMotionDebugServer, type MotionDebugServerHandle } from "./index";

const TOKEN = `artifact-root-authority-${"0".repeat(32)}`;
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../fixtures/packages/editable-lower-third");

it("refuses a host-authorized review bundle when a configured artifact root is replaced after startup", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-review-root-"));
  const artifactRoot = join(tempRoot, "artifacts");
  const replacedRoot = join(tempRoot, "artifacts-original");
  const receiptsRoot = join(tempRoot, "receipts");
  const outDir = join(tempRoot, "review");
  const mediaPath = join(artifactRoot, "final.mp4");
  let server: MotionDebugServerHandle | undefined;
  try {
    await mkdir(artifactRoot, { mode: 0o700 });
    await mkdir(receiptsRoot, { mode: 0o700 });
    await writeFile(mediaPath, "trusted media", "utf8");
    await writeFile(join(receiptsRoot, "render.receipt.json"), `${JSON.stringify({
      schema: "shellx-motion/receipt@1", id: "render-final-debug-retained-root", operation: "render.final",
      status: "passed", packageId: "pkg_editable_lower_third", inputHashes: { "motion.json": "abc123" },
      createdAt: "2026-08-12T00:00:00.000Z", lane: "ffmpeg", output: { path: mediaPath },
      artifacts: [{ role: "rendered_media", path: mediaPath, status: "available", primary: true }], warnings: []
    })}\n`, "utf8");
    server = await startMotionDebugServer({
      port: 0, capabilityToken: TOKEN, grantedTier: "write_local", artifactRoots: [artifactRoot], context: {
        receiptsRoot,
        authoringInputRoots: [dirname(PACKAGE_ROOT)],
        authoringOutputRoots: [tempRoot]
      }
    });

    await rename(artifactRoot, replacedRoot);
    await mkdir(artifactRoot, { mode: 0o700 });
    await writeFile(mediaPath, "replacement media", "utf8");
    const response = await globalThis.fetch(new URL("/debug", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        command: "motion.review.html.bundle", requestedTier: "write_local",
        args: { packageRoot: PACKAGE_ROOT, receiptsRoot, outDir }
      })
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "review_html_bundle_failed" } });
    await expect(readdir(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await server?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
