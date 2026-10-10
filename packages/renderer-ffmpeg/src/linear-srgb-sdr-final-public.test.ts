import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DerivedOutputPublication, LocalMotionJobEvidence, LocalMotionJobGovernor, MotionPackage } from "@shellx-motion/core";
import {
  abortStrictSdrCandidateHeldPair,
  closeStrictSdrCandidateHeldWorkspace,
  createStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  withStrictSdrCandidateHeldWorkspace,
  type StrictSdrCandidateHeldPair,
  type StrictSdrCandidateHeldWorkspace,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { claimLinearSrgbSdrFinalPreparation, prepareLinearSrgbSdrFinalForTest } from "./linear-srgb-sdr-final-adapter.js";
import { compareLinearSrgbSdrFinalFrames } from "./linear-srgb-sdr-final-compare.js";
import { validateLinearSrgbSdrFinalMedia } from "./linear-srgb-sdr-final-media.js";
import {
  preflightLinearSrgbSdrFinalRender,
  preflightLinearSrgbSdrFinalRenderForTest,
  planLinearSrgbSdrFinalRender,
  renderLinearSrgbSdrFinalUnpublishedForTest,
} from "./linear-srgb-sdr-final-public.js";
import { closeHeldMediaAfterPublication } from "./linear-srgb-sdr-final-held-media-publication.js";
import type { RenderStreamingFinalInput } from "./streaming-final-adapter-types.js";
import { LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER, LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";

describe("public linear-sRGB SDR final activation", () => {
  it("retains held publication failures when private held-media closure is uncertain", async () => {
    const primary = new Error("Core staging failed"), cleanup = new Error("held root cleanup failed");
    try {
      await closeHeldMediaAfterPublication({ async close() { throw cleanup; } }, async () => { throw primary; });
      throw new Error("expected held publication cleanup aggregation");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, cleanup]);
    }

    await expect(closeHeldMediaAfterPublication({ async close() { throw cleanup; } }, async () => "adopted")).rejects.toBe(cleanup);
  });

  it("keeps strict preparation test authority outside package export surfaces", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
      publishConfig: { exports: Record<string, unknown> };
    };
    expect(manifest.exports).not.toHaveProperty("./internal/linear-srgb-sdr-final");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/linear-srgb-sdr-final");
    expect(await readFile(new URL("./index.ts", import.meta.url), "utf8")).not.toMatch(/prepareLinearSrgbSdrFinal|linear-srgb-sdr-final-adapter/u);
  });

  it("performs exact tool preflight before any output publication and refuses incompatible strict controls", async () => {
    const events: string[] = [];
    const input = renderInput(events);
    const planned = planLinearSrgbSdrFinalRender(input);
    expect(planned).toMatchObject({ kind: "strict", command: { args: expect.arrayContaining(["libx264", "yuv420p", input.outputPath]) } });
    expect(events).toEqual([]);
    const strict = await testPreflight(input, events);
    expect(strict.kind).toBe("strict");
    expect(events).toEqual(["ffmpeg-version", "ffprobe-version", "exact-zscale-libx264"]);

    events.length = 0;
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, keepFrames: true })).resolves.toMatchObject({
      kind: "refused",
      error: { code: "linear_srgb_sdr_final_unsupported", message: expect.stringContaining("frame retention") },
    });
    expect(events).toEqual([]);
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, outputPath: join(tmpdir(), "wrong.mov") })).resolves.toMatchObject({ kind: "refused" });
    expect(events).toEqual([]);

    const injectedPolicies: RenderStreamingFinalInput["toolPolicy"][] = [
      { ...input.toolPolicy, processFactory: (() => undefined) as never },
      { ...input.toolPolicy, cache: {} as never },
      { ...input.toolPolicy, verifyDeliveredColor: false },
      { ...input.toolPolicy, browser: { networkAccess: {} as never } },
      { ...input.toolPolicy, native: { now: () => "2026-08-29T00:00:00.000Z" } },
      { ...input.toolPolicy, gpu: { frameTimeoutMs: 1_000 } },
    ];
    for (const toolPolicy of injectedPolicies) {
      await expect(preflightLinearSrgbSdrFinalRender({ ...input, toolPolicy })).resolves.toMatchObject({ kind: "refused" });
    }
    let injectedRunnerCalls = 0;
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, toolPolicy: { runner: async () => { injectedRunnerCalls += 1; return { exitCode: 0, stdout: "forged", stderr: "" }; } } })).resolves.toMatchObject({ kind: "refused" });
    expect(injectedRunnerCalls).toBe(0);
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, outputRoots: [join(tmpdir(), "different-output-root")] })).resolves.toMatchObject({ kind: "refused", error: { message: expect.stringContaining("trusted output root") } });
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, outputPath: "pipe:0.mp4" })).resolves.toMatchObject({ kind: "refused" });
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, outputPublication: { outputPath: input.outputPath, kind: "file" } as never })).resolves.toMatchObject({ kind: "refused", error: { message: expect.stringContaining("identity-bound") } });
    expect(events).toEqual([]);
  });

  it("refuses fake and stale preparations before output work without consuming a valid preparation", async () => {
    const events: string[] = [];
    const input = renderInput(events);
    const prepared = await testPreflight(input, events);
    if (prepared.kind !== "strict") throw new Error("expected strict preflight");
    events.length = 0;

    const fake = Object.freeze({
      ...prepared.preparation,
      route: prepared.preparation.route,
      ffmpeg: prepared.preparation.ffmpeg,
    });
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, linearSrgbSdrFinalPreparation: fake })).resolves.toMatchObject({
      kind: "refused",
      error: { message: expect.stringContaining("authority is absent") },
    });
    const stalePackage = { ...input.pkg, motion: { ...input.pkg.motion, background: "#111820" } };
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, pkg: stalePackage, linearSrgbSdrFinalPreparation: prepared.preparation })).resolves.toMatchObject({
      kind: "refused",
      error: { message: expect.stringContaining("stale") },
    });
    await expect(preflightLinearSrgbSdrFinalRender({ ...input, linearSrgbSdrFinalPreparation: prepared.preparation })).resolves.toMatchObject({ kind: "strict" });
    claimLinearSrgbSdrFinalPreparation(input.pkg.motion, prepared.preparation);
    expect(() => claimLinearSrgbSdrFinalPreparation(input.pkg.motion, prepared.preparation)).toThrow(/absent or already consumed/u);
    expect(events).toEqual([]);
  });

  it("refuses a document mutation during asynchronous tool preflight before issuing authority", async () => {
    const events: string[] = [];
    const input = renderInput(events);
    const result = await preflightLinearSrgbSdrFinalRenderForTest(input, async (motion) => await prepareLinearSrgbSdrFinalForTest(motion, async (command) => {
      const response = await runner(events)(command);
      if (command.args[0] !== "-version") (input.pkg.motion as { name: string }).name = "mutated during preflight";
      return response;
    }));
    expect(result).toMatchObject({ kind: "refused", error: { message: expect.stringContaining("stale during tool preflight") } });
  });

  it.skipIf(process.platform !== "linux")("accepts descriptor-relative publication paths only for the exact live Core-held candidate triple during plan and preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-held-plan-"));
    let workspace: StrictSdrCandidateHeldWorkspace | undefined;
    let pair: StrictSdrCandidateHeldPair | undefined;
    try {
      const ordinaryInput = { ...renderInput([]), outputPath: join(root, "ordinary.mp4"), outputRoots: [root] };
      const sealed = await testPreflight(ordinaryInput, []);
      if (sealed.kind !== "strict") throw new Error("expected sealed strict preparation");
      const anchor = await createTrustedWorkspaceAnchor(root);
      await withTrustedWorkspaceAnchor(anchor, async () => {
        workspace = await createStrictSdrCandidateHeldWorkspace(anchor, root);
        try {
          await withStrictSdrCandidateHeldWorkspace(workspace, sealed.preparation.fingerprint, async () => {
            pair = await openStrictSdrCandidateHeldPair(workspace!);
            const outputPublication = strictSdrCandidateOutputPublication(pair);
            const binding = strictSdrCandidateTerminalBinding(pair);
            const candidateInput = {
              ...ordinaryInput,
              outputPublication,
              outputPath: binding.outputPath,
              outputRoots: [dirname(binding.outputPath)],
              linearSrgbSdrFinalPreparation: sealed.preparation,
            };
            expect(outputPublication.outputPath).not.toBe(resolve(binding.outputPath));
            await withStrictSdrCandidateHeldPairRendering(pair, sealed.preparation.fingerprint, async () => {
              expect(planLinearSrgbSdrFinalRender(candidateInput)).toMatchObject({ kind: "strict" });
              await expect(preflightLinearSrgbSdrFinalRenderForTest(candidateInput, async () => {
                throw new Error("the sealed candidate preparation must avoid a second preflight");
              })).resolves.toMatchObject({ kind: "strict", preparation: sealed.preparation });
              expect(planLinearSrgbSdrFinalRender({ ...candidateInput, outputPath: join(dirname(binding.outputPath), "different.mp4") })).toMatchObject({ kind: "refused" });
            });
          });
        } finally {
          if (pair) {
            await abortStrictSdrCandidateHeldPair(pair);
            pair = undefined;
          } else if (workspace) {
            await closeStrictSdrCandidateHeldWorkspace(workspace);
            workspace = undefined;
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adopts only the verified MP4 into the private publication stage and binds strict receipt evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-public-"));
    const outputPath = join(root, "strict-public.mp4");
    const input = { ...renderInput([]), outputPath, outputRoots: [root] }, preflight = await testPreflight(input, []);
    if (preflight.kind !== "strict") throw new Error("expected strict preflight");
    claimLinearSrgbSdrFinalPreparation(input.pkg.motion, preflight.preparation);
    const adopted: Buffer[] = [];
    const publication = {
      outputPath, kind: "file", stagingPath: join(root, "publication-stage"),
      async writePrivateFile(bytes: Buffer) { adopted.push(Buffer.from(bytes)); return { sha256: sha256(bytes), byteLength: bytes.byteLength }; },
    } as unknown as DerivedOutputPublication;
    let admittedScratch = "";
    const result = await renderLinearSrgbSdrFinalUnpublishedForTest({
      ...input,
      scratchRoot: root,
      governor: governor(root),
      outputPublication: publication,
      linearSrgbSdrFinalPreparation: preflight.preparation,
    }, async ({ outputPath, preparation }) => {
      admittedScratch = dirname(outputPath);
      const bytes = Buffer.from("verified strict mp4 bytes");
      await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
      const rgba = Buffer.from([16, 24, 32, 255, 255, 0, 64, 255, 0, 102, 255, 255, 235, 235, 235, 255]);
      const comparison = compareLinearSrgbSdrFinalFrames({ width: 2, height: 2, source: rgba, decoded: rgba });
      const media = validateLinearSrgbSdrFinalMedia({
        media: { ok: true, path: outputPath, codec: "h264", width: 2, height: 2, durationMs: 1_000, fps: 2, container: "mov,mp4", color: { pixelFormat: "yuv420p", space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" }, alpha: { present: false, mode: null, pixelFormat: "yuv420p", decoder: null }, audio: { present: false, streamCount: 0, streams: [] } },
        width: 2, height: 2, fps: 2, frameCount: 2,
      });
      const producer = producerEvidence(preparation.route.fingerprint, preparation.route.documentFingerprint, rgba);
      return { ok: true as const, privateOutputPath: outputPath, evidence: {
        schema: "shellx-motion/linear-srgb-sdr-final-execution@1" as const,
        routeFingerprint: preparation.route.fingerprint,
        documentFingerprint: preparation.route.documentFingerprint,
        preparationFingerprint: preparation.fingerprint,
        ffmpegContractSha256: "a".repeat(64), producerEvidenceSha256: producer.fingerprint!, producer,
        retainedFrame: { sha256: sha256(rgba), byteLength: rgba.byteLength, repeatedFrames: 2, sequenceSha256: "b".repeat(64) },
        commands: { encodeSha256: "c".repeat(64), probeSha256: "d".repeat(64), inverseSha256: "e".repeat(64) },
        media, comparison, output: { sha256: sha256(bytes), byteLength: bytes.byteLength },
        cleanup: { browserTerminal: true as const, encoderExitCode: 0 as const, probeExitCode: 0 as const, inverseExitCode: 0 as const, decodedFrameRemoved: true as const },
        fingerprint: "f".repeat(64),
      } };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(adopted).toEqual([Buffer.from("verified strict mp4 bytes")]);
    expect(result.transport).toMatchObject({
      schema: "shellx-motion/linear-srgb-sdr-final-transport@2",
      delivery: "streamed", frameLane: "gpu", retainedFrameCount: 0,
      privateOutputAdoption: {
        schema: "shellx-motion/linear-srgb-sdr-final-private-output-adoption@1",
        verifiedOutput: { sha256: sha256(Buffer.from("verified strict mp4 bytes")), byteLength: Buffer.byteLength("verified strict mp4 bytes") },
        privatePublicationStage: { sha256: sha256(Buffer.from("verified strict mp4 bytes")), byteLength: Buffer.byteLength("verified strict mp4 bytes") },
      },
      producer: { frameLane: "gpu-linear-srgb-sdr", evidence: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-producer@1" } },
      colorPipeline: { requested: { intent: "linear-srgb-sdr@1" }, actual: { comparison: { accepted: true } } },
    });
    expect(result.receipt).toMatchObject({
      status: "passed", lane: "ffmpeg",
      output: { path: publication.stagingPath, byteLength: Buffer.byteLength("verified strict mp4 bytes"), encoder: "libx264", encoderSource: "software", color: { transfer: "bt709", range: "tv" }, tools: { ffmpeg: { tool: "ffmpeg" }, ffprobe: { tool: "ffprobe" } } },
    });
    const adoption = (result.transport as Extract<typeof result.transport, { schema: "shellx-motion/linear-srgb-sdr-final-transport@2" }>).privateOutputAdoption;
    expect(Object.isFrozen(adoption)).toBe(true);
    expect(Object.isFrozen(adoption.verifiedOutput)).toBe(true);
    expect(Object.isFrozen(adoption.privatePublicationStage)).toBe(true);
    expect(JSON.stringify(adoption)).not.toContain(admittedScratch);
    expect(JSON.stringify(result.receipt)).not.toContain(admittedScratch);
    await expect(lstat(admittedScratch)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["the verified-file rehash disagrees with executor evidence", async (outputPath: string) => {
      const bytes = Buffer.from("verified strict mp4 bytes");
      await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
      return { sha256: sha256(Buffer.from("forged executor hash")), byteLength: bytes.byteLength };
    }, async (bytes: Buffer) => ({ sha256: sha256(bytes), byteLength: bytes.byteLength }), "verified output changed"],
    ["the private publication stage reports a different identity", async (outputPath: string) => {
      const bytes = Buffer.from("verified strict mp4 bytes");
      await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
      return { sha256: sha256(bytes), byteLength: bytes.byteLength };
    }, async (bytes: Buffer) => ({ sha256: sha256(Buffer.from("forged stage identity")), byteLength: bytes.byteLength }), "publication stage did not preserve"],
  ])("refuses success when %s", async (_label, executeEvidence, stageEvidence, message) => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-linear-sdr-adoption-hostile-"));
    const outputPath = join(root, "strict-public.mp4");
    const input = { ...renderInput([]), outputPath, outputRoots: [root] };
    const preflight = await testPreflight(input, []);
    if (preflight.kind !== "strict") throw new Error("expected strict preflight");
    claimLinearSrgbSdrFinalPreparation(input.pkg.motion, preflight.preparation);
    const publication = {
      outputPath, kind: "file", stagingPath: join(root, "publication-stage"),
      async writePrivateFile(bytes: Buffer) { return await stageEvidence(bytes); },
    } as unknown as DerivedOutputPublication;
    const result = await renderLinearSrgbSdrFinalUnpublishedForTest({
      ...input,
      scratchRoot: root,
      governor: governor(root),
      outputPublication: publication,
      linearSrgbSdrFinalPreparation: preflight.preparation,
    }, async ({ outputPath: privateOutputPath }) => {
      const output = await executeEvidence(privateOutputPath);
      return {
        ok: true as const,
        privateOutputPath,
        evidence: { output },
      } as never;
    });
    expect(result).toMatchObject({ ok: false, error: { code: "linear_srgb_sdr_final_failed", message: expect.stringContaining(message) } });
    await rm(root, { recursive: true, force: true });
  });
});

function renderInput(_events: string[]): RenderStreamingFinalInput {
  return {
    pkg: strictPackage(), frameLane: "gpu", outputPath: join(tmpdir(), "strict-public.mp4"), preset: "mp4-h264",
    transport: { delivery: "streamed", reason: "stream_default" },
  };
}

async function testPreflight(input: RenderStreamingFinalInput, events: string[]) {
  return await preflightLinearSrgbSdrFinalRenderForTest(input, async (motion) => await prepareLinearSrgbSdrFinalForTest(motion, runner(events)));
}

function runner(events: string[]) {
  return async (command: import("./index.js").FfmpegCommand) => {
    if (command.args[0] === "-version") {
      const ffprobe = command.executable.includes("ffprobe");
      events.push(ffprobe ? "ffprobe-version" : "ffmpeg-version");
      return { exitCode: 0, stdout: `${ffprobe ? "ffprobe" : "ffmpeg"} version test\n`, stderr: "" };
    }
    events.push("exact-zscale-libx264");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function strictPackage(): MotionPackage {
  const motion = {
    schema: "shellx-motion/motion@1" as const, id: "strict-public", name: "Strict public", durationMs: 1_000, fps: 2, width: 2, height: 2, background: "#101820",
    colorPipeline: { schema: "shellx-motion/color-pipeline@1" as const, intent: "linear-srgb-sdr@1" as const }, assets: [], provenance: { sourceApp: "test", createdBy: "strict-public-test" },
    layers: [{ id: "rect", type: "shape" as const, shape: "rect" as const, startMs: 0, durationMs: 1_000, fill: "#ff0040", opacity: 0.5, transform: { x: 0, y: 0, width: 1, height: 1 } }],
  };
  return { root: "/package", manifest: { schema: "shellx-motion/package-manifest@1", id: motion.id, name: motion.name, motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["local"] } }, motion };
}

function governor(root: string): LocalMotionJobGovernor {
  const resources = resourceEvidence(root);
  return {
    policy: resources.policy,
    async run(_request: unknown, operation: (job: Record<string, unknown>) => Promise<unknown>) {
      const scratchRoot = root;
      const value = await operation({ jobId: resources.jobId, signal: new AbortController().signal, scratchRoot, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} });
      return { value, evidence: resources };
    },
  } as unknown as LocalMotionJobGovernor;
}

function resourceEvidence(root: string): LocalMotionJobEvidence {
  return { schema: "shellx-motion/local-job-resources@1", jobId: "strict-public-job", lane: "ffmpeg", operation: "ffmpeg.linear-srgb-sdr-final", state: "passed", queueWaitMs: 0, durationMs: 1, policy: { maxConcurrentJobs: 1, maxQueueDepth: 1, maxQueueWaitMs: 1_000, maxWallClockMs: 10_000, minFreeScratchBytes: 0, scratchReservationBytes: 0, maxProcessTreeRssBytes: 512 * 1024 * 1024, rssPollIntervalMs: 1_000 }, scratch: { pathSafety: "canonical-no-symlink", freeBytesAtStart: 1_000_000_000, reservedBytes: 0, minFreeBytes: 0 }, peakProcessTreeRssBytes: 0, watchedProcessCount: 0, rssScope: "unavailable" };
}

function producerEvidence(routeFingerprint: string, documentFingerprint: string, frame: Buffer) {
  return {
    schema: "shellx-motion/linear-srgb-sdr-final-webgpu-producer@1" as const, routeFingerprint, documentFingerprint,
    pipeline: { schema: "shellx-motion/linear-srgb-sdr-final-webgpu-pipeline@1" as const, implementationSha256: LINEAR_SRGB_SDR_FINAL_WEBGPU_PIPELINE.implementationSha256, workingTarget: "rgba16float" as const, publicationTarget: "rgba8unorm" as const, publicationUsage: "COPY_SRC" as const, composition: "premultiplied-linear-srgb-normal-source-over" as const, frameBoundary: "straight-srgb-rgba8" as const, publicationDither: LINEAR_SRGB_SDR_FINAL_PUBLICATION_DITHER },
    runtime: null, readback: { bytesPerRow: 256, paddedByteLength: 512, tightByteLength: frame.byteLength, mapOperations: 1, mappedBufferUnmapped: true, mappedBufferDestroyed: true }, retainedFrame: { bytes: frame.byteLength, sha256: sha256(frame) }, cleanup: { state: "complete" as const, resourcesReleased: true, pageClosed: true, runtimeClosed: true }, fingerprint: "2".repeat(64),
  };
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
