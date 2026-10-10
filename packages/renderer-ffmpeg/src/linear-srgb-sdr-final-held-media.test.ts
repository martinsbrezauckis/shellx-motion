import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDerivedOutputPublication, canonicalJsonSha256, type DerivedOutputPublication, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import {
  claimCurrentStrictSdrCandidateHeldPairRendererBinding,
  commitStrictSdrCandidateHeldPair,
  consumeCurrentStrictSdrCandidateHeldPairRendererBinding,
  consumeStrictSdrCandidateHeldPair,
  createStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  stageStrictSdrCandidateFinalReceipt,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import {
  LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER,
  linearSrgbSdrFinalEncodeCommand,
  linearSrgbSdrFinalInverseDecodeCommand,
} from "./linear-srgb-sdr-final-ffmpeg-contract.js";
import {
  assertLinearSrgbSdrHeldMediaWitness,
  openLinearSrgbSdrHeldMedia,
  type LinearSrgbSdrHeldMediaSuccess,
} from "./linear-srgb-sdr-final-held-media.js";
import { heldMediaCommands } from "./linear-srgb-sdr-final-held-media-command.js";
import { copyHeldMediaToPublication } from "./linear-srgb-sdr-final-held-media-publication.js";
import { createExclusiveHeldLeaf, hashHeldLeaf, heldDirectoryFacts } from "./linear-srgb-sdr-final-held-media-files.js";
import { heldAllDeliveredFramesInverseCommand } from "./linear-srgb-sdr-final-held-media-command.js";
import { resolveFfmpegExecutable } from "./index.js";
import { rethrowHeldMediaPublicationFailureForTest } from "./linear-srgb-sdr-final-held-media-publication.js";

describe("strict SDR held-media command delta", () => {
  it("derives only the accepted Linux-owned descriptor operands from current strict builders", () => {
    const timeline = { width: 16, height: 16, fps: 2, frameCount: 2 };
    const commands = heldMediaCommands(timeline);
    const ordinary = linearSrgbSdrFinalEncodeCommand(timeline, "/strict-sdr-held-dummy.mp4");
    const expectedEncode = ordinary.args.map((value) => value === "-n" ? "-y" : value).slice(0, -1);
    expectedEncode.push("-f", "mp4", "/proc/self/fd/4");
    expect(commands.encode).toStrictEqual({ executable: "/proc/self/fd/3", shell: false, args: expectedEncode });
    expect(commands.encode.args).toContain("+faststart");
    expect(commands.encode.args.filter((value) => value === "-y")).toHaveLength(1);
    expect(commands.encode.args).not.toContain("-n");
    expect(commands.encode.args.slice(-3)).toEqual(["-f", "mp4", "/proc/self/fd/4"]);
    expect(canonicalJsonSha256(commands.encode)).not.toBe(canonicalJsonSha256(ordinary));

    const inverse = linearSrgbSdrFinalInverseDecodeCommand("/strict-sdr-held-dummy.mp4", "/strict-sdr-held-decoded.rgba");
    expect(commands.inverse).toStrictEqual({
      executable: "/proc/self/fd/3",
      shell: false,
      args: inverse.args.map((value) => value === "-n" ? "-y" : value === "/strict-sdr-held-dummy.mp4" ? "/proc/self/fd/4" : value === "/strict-sdr-held-decoded.rgba" ? "/proc/self/fd/5" : value),
    });
    expect(commands.probe).toStrictEqual({
      executable: "/proc/self/fd/3",
      shell: false,
      args: ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-protocol_whitelist", "file", "-i", "/proc/self/fd/4"],
    });
  });

  it("preserves Core staging failure and reports unclosed writer cleanup uncertainty", async () => {
    const primary = new Error("source staging failed"), cleanup = new Error("writer abandonment failed");
    await expect(rethrowHeldMediaPublicationFailureForTest(primary, false, async () => undefined)).rejects.toBe(primary);

    let abandonCalls = 0;
    await expect(rethrowHeldMediaPublicationFailureForTest(primary, true, async () => { abandonCalls += 1; })).rejects.toBe(primary);
    expect(abandonCalls).toBe(0);

    try {
      await rethrowHeldMediaPublicationFailureForTest(primary, false, async () => { throw cleanup; });
      throw new Error("expected staged writer cleanup aggregation");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, cleanup]);
    }
  });

  it("derives the same-parent raw inverse without a frame-output cap so EOF proves full delivery", () => {
    const command = heldAllDeliveredFramesInverseCommand(resolveFfmpegExecutable());
    expect(command).toMatchObject({ executable: "/proc/self/fd/3", shell: false });
    expect(command.args).toContain("/proc/self/fd/4");
    expect(command.args.at(-1)).toBe("pipe:1");
    expect(command.args).not.toContain("-frames:v");
    expect(command.args).not.toContain("-n");
    expect(command.args[command.args.indexOf("-vf") + 1]).toBe(LINEAR_SRGB_SDR_FINAL_INVERSE_FILTER.slice("select=eq(n\\,0),".length));
    expect(command.args.slice(-7)).toEqual(["-fps_mode", "passthrough", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
  });

  it("refuses caller-made and pre-copy successes at the private adoption boundary", () => {
    const forged = Object.freeze({ evidence: { output: { sha256: "a".repeat(64), byteLength: 4 }, commands: { encodeSha256: "a", probeSha256: "b", inverseSha256: "c" } } }) as LinearSrgbSdrHeldMediaSuccess;
    expect(() => assertLinearSrgbSdrHeldMediaWitness(forged, forged.evidence.output)).toThrow(/no completed operation witness/);
    expect(() => assertLinearSrgbSdrHeldMediaWitness({ ...forged }, forged.evidence.output)).toThrow(/no completed operation witness/);
  });

  it.skipIf(process.platform !== "linux")("consumes one real held encode, validation, and Core stage-copy witness", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-held-witness-operation-"));
    const privateRoot = join(root, "held");
    await mkdir(privateRoot, { mode: 0o700 });
    const publication = await acquireDerivedOutputPublication({ outputPath: join(root, "candidate.mp4"), kind: "file" });
    let operation: Awaited<ReturnType<typeof openLinearSrgbSdrHeldMedia>> | undefined;
    try {
      const width = 64, height = 64;
      const rgba8Srgb = Buffer.alloc(width * height * 4);
      for (let offset = 0; offset < rgba8Srgb.length; offset += 4) {
        rgba8Srgb[offset] = 96; rgba8Srgb[offset + 1] = 128; rgba8Srgb[offset + 2] = 160; rgba8Srgb[offset + 3] = 255;
      }
      const route = { canvas: { width, height, fps: 2, durationMs: 1_000 } } as LinearSrgbSdrFinalRoute;
      const frame = { rgba8Srgb } as LinearSrgbSdrFinalWebGpuFrame;
      operation = await openLinearSrgbSdrHeldMedia({
        route, privateRoot, outputPath: join(privateRoot, "verified.mp4"), decodedPath: join(privateRoot, "decoded.rgba"),
        job: { admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: root,
          maxProcessTreeRssBytes: 512 * 1024 * 1024, watchProcess: () => undefined, reportProcessContainment: () => undefined },
      });
      const success = await operation.execute(frame);
      expect(() => assertLinearSrgbSdrHeldMediaWitness(success, success.evidence.output)).toThrow(/no completed operation witness/);
      const staged = await success.copyToPublication(publication);
      expect(() => assertLinearSrgbSdrHeldMediaWitness(success, staged)).not.toThrow();
      expect(() => assertLinearSrgbSdrHeldMediaWitness(success, { ...staged, sha256: "0".repeat(64) })).toThrow(/changed after its operation witness/);
      await expect(success.copyToPublication(publication)).rejects.toThrow(/already attempted/);
    } finally {
      await operation?.close();
      await publication.abort();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(process.platform !== "linux")("joins one real held encode and copy to Core's final receipt and consumed public pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-held-core-pair-operation-"));
    const privateRoot = join(root, "held");
    const preparation = "a".repeat(64);
    await mkdir(privateRoot, { mode: 0o700 });
    let operation: Awaited<ReturnType<typeof openLinearSrgbSdrHeldMedia>> | undefined;
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        const workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        await withStrictSdrCandidateHeldWorkspace(workspace, preparation, async () => {
          const pair = await openStrictSdrCandidateHeldPair(workspace);
          const publication = strictSdrCandidateOutputPublication(pair);
          const bindingPath = strictSdrCandidateTerminalBinding(pair);
          const rgba8Srgb = Buffer.alloc(64 * 64 * 4);
          for (let offset = 0; offset < rgba8Srgb.length; offset += 4) {
            rgba8Srgb[offset] = 96; rgba8Srgb[offset + 1] = 128; rgba8Srgb[offset + 2] = 160; rgba8Srgb[offset + 3] = 255;
          }
          const route = { canvas: { width: 64, height: 64, fps: 2, durationMs: 1_000 } } as LinearSrgbSdrFinalRoute;
          operation = await openLinearSrgbSdrHeldMedia({
            route, privateRoot, outputPath: join(privateRoot, "verified.mp4"), decodedPath: join(privateRoot, "decoded.rgba"),
            job: { admission: "pre-acquired", signal: new AbortController().signal, scratchRoot: root,
              maxProcessTreeRssBytes: 512 * 1024 * 1024, watchProcess: () => undefined, reportProcessContainment: () => undefined },
          });
          let staged!: Readonly<{ sha256: string; byteLength: number }>;
          await withStrictSdrCandidateHeldPairRendering(pair, preparation, async () => {
            const binding = claimCurrentStrictSdrCandidateHeldPairRendererBinding(publication, preparation, bindingPath.outputPath)!;
            consumeCurrentStrictSdrCandidateHeldPairRendererBinding(binding);
            const success = await operation!.execute({ rgba8Srgb } as LinearSrgbSdrFinalWebGpuFrame);
            staged = await success.copyToPublication(publication, binding);
            expect(() => assertLinearSrgbSdrHeldMediaWitness(success, staged)).not.toThrow();
          });
          await operation.close();
          operation = undefined;
          const receipt: OperationReceipt = {
            schema: "shellx-motion/receipt@1", id: "held-core-operation", operation: "render.final", status: "passed", packageId: "pkg_held_core",
            inputHashes: { motion: "b".repeat(64), "linear-srgb-sdr-route": "c".repeat(64), "linear-srgb-sdr-preparation": preparation,
              "linear-srgb-sdr-ffmpeg-contract": "d".repeat(64), "linear-srgb-sdr-webgpu-producer": "e".repeat(64),
              "linear-srgb-sdr-producer-frame": "f".repeat(64), "linear-srgb-sdr-comparison-policy": "0".repeat(64),
              "linear-srgb-sdr-execution": "1".repeat(64) },
            createdAt: "2026-09-24T00:00:00.000Z", lane: "ffmpeg", warnings: [],
            output: { path: publication.stagingPath, ...staged,
              frameTransport: { schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
                privateOutputAdoption: { schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
                  verifiedOutput: staged, privatePublicationStage: staged } } },
          };
          await stageStrictSdrCandidateFinalReceipt(pair, receipt);
          await commitStrictSdrCandidateHeldPair(pair);
          await consumeStrictSdrCandidateHeldPair(pair, async (observation) => {
            expect(observation.media).toEqual(staged);
            expect((await observation.readReceipt()).toString("utf8")).toContain("held-core-operation");
          });
        });
      });
    } finally {
      await operation?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(process.platform !== "linux")("refuses a held source mutated while Core staging verifies its copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-held-witness-"));
    let rootHandle: FileHandle | undefined;
    let sourceHandle: FileHandle | undefined;
    try {
      rootHandle = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const rootIdentity = await heldDirectoryFacts(rootHandle, root, "witness test root");
      const source = await createExclusiveHeldLeaf(rootHandle, rootIdentity, join(root, "verified.mp4"), "witness test source");
      sourceHandle = source.handle;
      const original = Buffer.from("held-source-original");
      await source.handle.write(original, 0, original.length, 0);
      const sourceFacts = await hashHeldLeaf(rootHandle, rootIdentity, source, 1024, "witness source before copy");
      const staged: Buffer[] = [];
      const publication = {
        createPrivateFileChunkWriter: async () => ({ writeChunk: async (bytes: Buffer) => { staged.push(Buffer.from(bytes)); }, close: async () => undefined }),
        verifyIncrementalPrivateFile: async () => {
          await source.handle.write(Buffer.from("X"), 0, 1, 0);
          const bytes = Buffer.concat(staged);
          return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
        },
        abandonPrivateFileChunkWriter: async () => undefined,
      } as unknown as DerivedOutputPublication;
      await expect(copyHeldMediaToPublication({ root: rootHandle, rootIdentity, source, sourceFacts, publication })).rejects.toThrow(/did not preserve one exact identity/);
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await rootHandle?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
