import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { remapPrivatePublicationResultPaths, renderQualityManifestFailure } from "./render-delivery-publication-support.js";

const receiptWriter = vi.hoisted(() => vi.fn(async (_receipt: unknown, receiptPath: string) => receiptPath));

vi.mock("./render-receipt-file.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./render-receipt-file.js")>(),
  writeRenderReceiptFile: receiptWriter
}));

describe("render delivery public path projection", () => {
  it("rebinds only paths inside the private publication root", () => {
    const privateRoot = join(process.cwd(), ".scratch", "private-sequence");
    const publicRoot = join(process.cwd(), "out", "sequence");
    const outside = join(process.cwd(), ".scratch", "quality", "diff.png");

    expect(remapPrivatePublicationResultPaths({
      inputPath: privateRoot,
      samples: [{ framePath: join(privateRoot, "000002.png"), diffPath: outside }],
      status: "passed"
    }, privateRoot, publicRoot)).toEqual({
      inputPath: publicRoot,
      samples: [{ framePath: join(publicRoot, "000002.png"), diffPath: outside }],
      status: "passed"
    });
  });
});

describe("quality-gated render failure receipts", () => {
  it("redacts aborted still and media delivery evidence before persisting the failed receipt", async () => {
    receiptWriter.mockClear();
    const root = join(process.cwd(), ".scratch", "quality-receipt-fixture");
    const outputPath = join(root, "final.png");
    const frameHash = "a".repeat(64);
    const mediaHash = "b".repeat(64);
    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: "quality-gated-still",
      operation: "render.final",
      status: "failed",
      createdAt: "2026-08-27T00:00:00.000Z",
      lane: "image",
      inputHashes: {
        frame: frameHash,
        qualityManifest: "c".repeat(64),
        qualityInputs: "d".repeat(64)
      },
      output: {
        path: outputPath,
        sha256: frameHash,
        qualityManifestPath: join(root, "quality-manifest.json"),
        qualityCheck: { status: "failed" }
      },
      warnings: ["quality warning"],
      artifacts: [
        { role: "still_frame", path: join(root, "alternate-still.png"), status: "available", mediaType: "image/png", primary: true },
        { role: "rendered_media", path: join(root, "final.mp4"), status: "available", mediaType: "video/mp4", primary: true },
        { role: "quality_receipt", path: join(root, "quality.receipt.json"), status: "available", mediaType: "application/json" }
      ]
    } as unknown as OperationReceipt;
    const frameReceipt = {
      schema: "shellx-motion/receipt@1", id: "quality-gated-frame", operation: "preview.frame", status: "passed",
      packageId: "pkg_quality_receipt", createdAt: "2026-08-27T00:00:00.000Z", lane: "image",
      inputHashes: { frame: frameHash }, output: { path: outputPath, sha256: frameHash }, warnings: [],
      artifacts: [{ role: "still_frame", path: outputPath, status: "available", mediaType: "image/png", primary: true }]
    } as unknown as OperationReceipt;

    const result = await renderQualityManifestFailure({
      packageId: "pkg_quality_receipt",
      lane: "image",
      frameLane: "native",
      preset: "png-frame",
      outputPath,
      receipt,
      frameReceipt,
      qualityManifestPath: join(root, "quality-manifest.json"),
      qualityCheck: {
        ok: false,
        error: { code: "visual_quality_failed", message: "The quality sample regressed." }
      },
      force: false
    });

    expect(result).toMatchObject({ error: { code: "visual_quality_failed", message: "The quality sample regressed." } });
    expect(receipt).toMatchObject({
      status: "failed",
      output: { publication: "aborted", failure: { code: "visual_quality_failed", message: "The quality sample regressed." } },
      inputHashes: { qualityManifest: "c".repeat(64), qualityInputs: "d".repeat(64) },
      warnings: ["quality warning"]
    });
    expect(receipt.inputHashes.frame).toBeUndefined();
    expect(receipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "quality_receipt" })
    ]));
    expect(receipt.artifacts?.some((artifact) => artifact.role === "still_frame" || artifact.role === "rendered_media" || artifact.path === outputPath)).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(frameHash);
    expect(JSON.stringify(receipt)).not.toContain(mediaHash);
    expect(result).toMatchObject({ frameReceipt: { output: { publication: "aborted" } } });
    expect(JSON.stringify(result.frameReceipt)).not.toContain(frameHash);
    expect(JSON.stringify(result.frameReceipt)).not.toContain(outputPath);
    expect(receiptWriter).toHaveBeenCalledOnce();
    expect(receiptWriter).toHaveBeenCalledWith(
      receipt,
      join(root, "final.png.receipt.json"),
      { force: false }
    );
  });
});
