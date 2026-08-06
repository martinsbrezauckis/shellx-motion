import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReceiptActor,
  createPreviewReceipt,
  createRenderReceipt,
  hashBuffer,
  hashFile,
  readReceiptActor,
  receiptClaimedActorLabel
} from "./receipts";
import type { OperationReceipt, ReceiptActor } from "./types";

describe("receipts", () => {
  it("hashes buffers with sha256", () => {
    expect(hashBuffer(Buffer.from("motion\n"))).toBe("13d453bdb82f04880edd159c806b6020794cdeff911b47eab7e5b3a1b84ed5cd");
  });

  it("streams regular files and refuses symlink hash inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-hash-file-"));
    try {
      const target = join(root, "target.bin");
      const link = join(root, "link.bin");
      await writeFile(target, Buffer.from("motion\n"));
      expect(await hashFile(target)).toBe("13d453bdb82f04880edd159c806b6020794cdeff911b47eab7e5b3a1b84ed5cd");
      try {
        await symlink(target, link, "file");
        await expect(hashFile(link)).rejects.toThrow("regular non-symlink");
      } catch (error) {
        if (!isWindowsSymlinkPrivilegeError(error)) throw error;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates preview receipts with frame hash evidence", () => {
    const receipt = createPreviewReceipt({
      id: "receipt_preview_1",
      packageId: "pkg_lower_third",
      lane: "native",
      inputHashes: { "motion.json": "abc" },
      outputFrame: { path: ".scratch/frame.png", sha256: "def", width: 1920, height: 1080, atMs: 0 },
      warnings: []
    });

    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      id: "receipt_preview_1",
      operation: "preview.frame",
      status: "passed",
      lane: "native",
      packageId: "pkg_lower_third",
      output: { path: ".scratch/frame.png", sha256: "def", width: 1920, height: 1080, atMs: 0 },
      warnings: []
    });
  });

  it("marks preview receipts with warnings as warning status", () => {
    const receipt = createPreviewReceipt({
      id: "receipt_preview_warning",
      packageId: "pkg_degraded_preview",
      lane: "native",
      inputHashes: { "motion.json": "abc" },
      outputFrame: { path: ".scratch/degraded-frame.png", sha256: "def", width: 1280, height: 720, atMs: 0 },
      warnings: ["Native renderer used fallback block glyphs."]
    });

    expect(receipt).toMatchObject({
      operation: "preview.frame",
      status: "warning",
      warnings: ["Native renderer used fallback block glyphs."]
    });
  });

  it("marks preview receipts with failed quality evidence as failed", () => {
    const receipt = createPreviewReceipt({
      id: "receipt_preview_failed_quality",
      packageId: "pkg_blank_preview",
      lane: "browser",
      inputHashes: { "motion.json": "abc" },
      outputFrame: { path: ".scratch/blank-frame.png", sha256: "def", width: 1280, height: 720, atMs: 0 },
      quality: {
        status: "failed",
        code: "blank_frame",
        message: "Preview frame is visually empty."
      },
      warnings: []
    });

    expect(receipt).toMatchObject({
      operation: "preview.frame",
      status: "failed",
      output: {
        path: ".scratch/blank-frame.png",
        quality: {
          status: "failed",
          code: "blank_frame",
          message: "Preview frame is visually empty."
        }
      }
    });
  });

  it("creates failed render receipts without output hashes", () => {
    const receipt = createRenderReceipt({
      id: "receipt_render_1",
      packageId: "pkg_lower_third",
      lane: "ffmpeg",
      status: "failed",
      inputHashes: { "motion.json": "abc" },
      output: null,
      warnings: ["ffmpeg exited 1"]
    });

    expect(receipt.status).toBe("failed");
    expect(receipt.output).toBeNull();
    expect(receipt.warnings).toEqual(["ffmpeg exited 1"]);
  });

  it("preserves timeline audio placement in render receipt output", () => {
    const receipt = createRenderReceipt({
      id: "receipt_render_audio_timeline",
      packageId: "pkg_audio_timeline",
      lane: "ffmpeg",
      status: "passed",
      inputHashes: { "motion.json": "abc" },
      output: {
        path: ".scratch/render.mp4",
        sha256: "def",
        width: 1920,
        height: 1080,
        durationMs: 4000,
        codec: "h264",
        container: "mp4",
        audio: {
          codec: "aac",
          pan: -0.35,
          mix: "amix",
          tracks: [
            { path: "music.wav", startMs: 250, trimStartMs: 100, trimDurationMs: 500, playbackRate: 1.25, pan: -0.25 },
            { path: "voice.wav", startMs: 1000, volume: 0.8, pan: 0.5 }
          ]
        }
      },
      warnings: []
    });

    expect(receipt.output).toMatchObject({
      audio: {
        pan: -0.35,
        tracks: [
          { path: "music.wav", startMs: 250, playbackRate: 1.25, pan: -0.25 },
          { path: "voice.wav", startMs: 1000, volume: 0.8, pan: 0.5 }
        ]
      }
    });
  });

  it("preserves audio ducking metadata in render receipt output", () => {
    const receipt = createRenderReceipt({
      id: "receipt_render_audio_ducking",
      packageId: "pkg_audio_ducking",
      lane: "ffmpeg",
      status: "passed",
      inputHashes: { "motion.json": "abc" },
      output: {
        path: ".scratch/render.mp4",
        sha256: "def",
        width: 1920,
        height: 1080,
        durationMs: 4000,
        codec: "h264",
        container: "mp4",
        audio: {
          codec: "aac",
          ducking: {
            triggerLayerIds: ["voice"],
            duckToVolume: 0.3,
            attackMs: 120,
            releaseMs: 240
          },
          volumeKeyframes: [
            { atMs: 0, value: 1 },
            { atMs: 120, value: 0.3 }
          ]
        }
      },
      warnings: []
    });

    expect(receipt.output).toMatchObject({
      audio: {
        ducking: {
          triggerLayerIds: ["voice"],
          duckToVolume: 0.3,
          attackMs: 120,
          releaseMs: 240
        }
      }
    });
  });
});

/** Build a minimal template.apply-shaped receipt for actor-stamping tests. */
function baseReceipt(output: unknown = {}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: "receipt-actor-test",
    operation: "template.apply",
    status: "passed",
    packageId: "pkg_test",
    inputHashes: {},
    createdAt: "2026-07-22T00:00:00.000Z",
    lane: "template",
    output,
    warnings: []
  };
}

const HTTP_ACTOR: ReceiptActor = {
  kind: "unknown",
  label: "http client",
  transport: "http",
  sessionId: "srv-abc",
  grantedTier: "render_motion"
};

describe("receipt actor attribution", () => {
  it("stamps the inferred transport actor when the caller made no claim", () => {
    const receipt = applyReceiptActor(baseReceipt(), HTTP_ACTOR);
    expect(receipt.actor).toEqual({
      kind: "unknown",
      label: "http client",
      transport: "http",
      sessionId: "srv-abc",
      grantedTier: "render_motion"
    });
  });

  it("lets an explicit createdBy claim win the label while observed transport facts still ride along", () => {
    const receipt = applyReceiptActor(baseReceipt({ createdBy: "launch-bot" }), HTTP_ACTOR);
    // The claim wins the label...
    expect(receipt.actor?.label).toBe("launch-bot");
    // ...but the observed, non-spoofable transport facts are recorded regardless of the claim.
    expect(receipt.actor?.transport).toBe("http");
    expect(receipt.actor?.sessionId).toBe("srv-abc");
    expect(receipt.actor?.grantedTier).toBe("render_motion");
  });

  it("mutates in place and returns the same reference so disk and inline result stay consistent", () => {
    const receipt = baseReceipt();
    const returned = applyReceiptActor(receipt, HTTP_ACTOR);
    expect(returned).toBe(receipt);
    expect(receipt.actor?.transport).toBe("http");
  });

  it("is a no-op when no transport was observed, keeping legacy receipts byte-for-byte valid", () => {
    const receipt = applyReceiptActor(baseReceipt({ createdBy: "launch-bot" }), undefined);
    expect(receipt.actor).toBeUndefined();
  });

  it("preserves a prior stamp's observed facts when re-stamped by a factless actor", () => {
    const receipt = applyReceiptActor(baseReceipt(), HTTP_ACTOR);
    applyReceiptActor(receipt, { kind: "agent", label: "connector" });
    // A later stamp without transport facts must not erase the originally observed transport.
    expect(receipt.actor?.transport).toBe("http");
    expect(receipt.actor?.sessionId).toBe("srv-abc");
  });

  it("reads the caller-claimed label from an explicit actor label or output.createdBy", () => {
    expect(receiptClaimedActorLabel(baseReceipt({ createdBy: "launch-bot" }))).toBe("launch-bot");
    const stamped = baseReceipt();
    stamped.actor = { kind: "agent", label: "already-set" };
    expect(receiptClaimedActorLabel(stamped)).toBe("already-set");
    expect(receiptClaimedActorLabel(baseReceipt())).toBeUndefined();
  });

  it("parses valid persisted actors and rejects malformed ones", () => {
    expect(readReceiptActor({ kind: "mcp-agent", label: "x" })).toBeUndefined(); // bad kind
    expect(readReceiptActor({ kind: "agent", label: "" })).toBeUndefined(); // empty label
    expect(readReceiptActor({ kind: "agent", label: "claude", transport: "carrier-pigeon" }))
      .toEqual({ kind: "agent", label: "claude" }); // unknown transport dropped, rest kept
    expect(readReceiptActor({
      kind: "agent", label: "claude-code/1.0", transport: "mcp",
      clientInfo: "claude-code/1.0", sessionId: "srv:ws-1", grantedTier: "render_motion"
    })).toEqual({
      kind: "agent", label: "claude-code/1.0", transport: "mcp",
      clientInfo: "claude-code/1.0", sessionId: "srv:ws-1", grantedTier: "render_motion"
    });
  });
});

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return process.platform === "win32"
    && Boolean(error && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String((error as { code?: unknown }).code)));
}
