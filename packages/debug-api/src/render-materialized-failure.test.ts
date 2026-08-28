import { createHash } from "node:crypto";
import type { OperationReceipt } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import { materializedFinalEncodeFailure } from "./render-materialized-failure.js";

describe("materializedFinalEncodeFailure", () => {
  it("persists a path-free failed receipt when publication will abort the encoded stage", async () => {
    const stagingPath = "/private/stage.shellx-motion-stage.mp4";
    const stageHash = createHash("sha256").update("encoded-stage", "utf8").digest("hex");
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: "failed-stage",
      operation: "render.final",
      status: "failed",
      packageId: "pkg",
      inputHashes: {},
      createdAt: "2026-08-10T00:00:00.000Z",
      lane: "ffmpeg",
      output: { path: stagingPath, sha256: stageHash },
      artifacts: [{ role: "rendered_media", path: stagingPath, status: "failed", primary: true }],
      warnings: []
    };
    let persisted: OperationReceipt | undefined;
    const result = await materializedFinalEncodeFailure({
      encoded: {
        ok: false,
        error: { code: "audio_master_quality_failed", message: "Delivered readback failed." },
        command: { executable: "ffmpeg", args: [stagingPath], shell: false },
        receipt
      },
      framePass: { frameReceipt: null, warnings: [], applyTo: () => undefined },
      receiptsRoot: "/receipts",
      persistReceipt: async (_root, candidate) => {
        persisted = candidate;
        return "/receipts/failed.json";
      },
      frameLane: "browser",
      preset: "mp4-h264",
      packageId: "pkg",
      outputPath: "/public/out.mp4",
      transport: { delivery: "materialized", reason: "explicit_frame_retention" },
      warnings: []
    });

    expect(result).toMatchObject({ ok: false, error: { code: "audio_master_quality_failed", message: "Delivered readback failed." } });
    expect(persisted).toMatchObject({ status: "failed", output: { publication: "aborted", failure: { code: "audio_master_quality_failed", message: "Delivered readback failed." } }, artifacts: [] });
    const serialized = JSON.stringify({ result, persisted });
    expect(serialized).not.toContain(stagingPath);
    expect(serialized).not.toContain(stageHash);
    expect(serialized).not.toContain("rendered_media");
  });
});
