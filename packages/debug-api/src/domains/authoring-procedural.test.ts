import { hashBuffer, loadMotionPackage } from "@shellx-motion/core";
import type { FfmpegCommand } from "@shellx-motion/renderer-ffmpeg";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import { dispatchProceduralAuthoringCommand } from "./authoring-procedural.js";

const roots: string[] = [];

describe("procedural relationship authoring commands", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("sets, reads, disables, enables, bakes, and detaches through atomic package revisions", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const setRoot = join(root, "set");
    const disabledRoot = join(root, "disabled");
    const enabledRoot = join(root, "enabled");
    const bakedRoot = join(root, "baked");
    const detachedRoot = join(root, "detached");
    await writePackage(sourceRoot);
    const sourceText = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const services = authoringServices(root);

    const set = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: setRoot, relationship: relationship() },
      services,
    );
    expect(set).toMatchObject({
      ok: true,
      result: {
        changedPaths: ["/relationships/relationships/drift"],
        state: {
          relationships: [{
            id: "drift",
            enabled: true,
            target: { layerId: "target", property: "transform.x" },
            sources: [{ layerId: "driver", property: "opacity" }],
            nodeCount: 6,
          }],
          validation: { ok: true },
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        receipt: { operation: "procedural.relationship.set", status: "passed" },
      },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceText);

    const inspect = await dispatchProceduralAuthoringCommand(
      "motion.procedural.inspect",
      { packageRoot: setRoot, atMs: 500 },
      services,
    );
    expect(inspect).toMatchObject({
      ok: true,
      result: { state: { evaluation: { atMs: 500, values: { drift: 50 } } } },
    });

    const disabled = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.enabled.set",
      { packageRoot: setRoot, outDir: disabledRoot, relationshipId: "drift", enabled: false },
      services,
    );
    expect(disabled).toMatchObject({
      ok: true,
      result: {
        state: { relationships: [{ id: "drift", enabled: false }] },
        receipt: { operation: "procedural.relationship.enabled.set" },
      },
    });

    const enabled = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.enabled.set",
      { packageRoot: disabledRoot, outDir: enabledRoot, relationshipId: "drift", enabled: true },
      services,
    );
    expect(enabled).toMatchObject({ ok: true });

    const baked = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.bake",
      {
        packageRoot: enabledRoot,
        outDir: bakedRoot,
        relationshipIds: ["drift"],
        startMs: 0,
        endMs: 1_000,
        sampleEveryFrames: 15,
      },
      services,
    );
    expect(baked).toMatchObject({
      ok: true,
      result: {
        state: { graph: null, relationships: [] },
        bake: {
          relationshipIds: ["drift"],
          sampleCount: 3,
          keyframeCount: 3,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        receipt: { operation: "procedural.relationship.bake" },
      },
    });
    const bakedMotion = (await loadMotionPackage(bakedRoot)).motion;
    expect(bakedMotion.relationships).toBeUndefined();
    expect(bakedMotion.layers.find((layer) => layer.id === "target")?.keyframes?.["transform.x"])
      .toMatchObject([{ atMs: 0 }, { atMs: 500 }, { atMs: 1_000 }]);

    const detached = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.detach",
      { packageRoot: setRoot, outDir: detachedRoot, relationshipId: "drift" },
      services,
    );
    expect(detached).toMatchObject({
      ok: true,
      result: {
        state: { graph: null, relationships: [] },
        receipt: { operation: "procedural.relationship.detach" },
      },
    });
  });

  it("rejects executable fields and invalid destinations before publishing output", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const invalidRoot = join(root, "invalid");
    const occupiedRoot = join(root, "occupied");
    await writePackage(sourceRoot);
    const unsafe = { ...relationship(), expression: "time * 20" };
    const rejected = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: invalidRoot, relationship: unsafe },
      authoringServices(root),
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "procedural_relationship_set_failed",
        message: expect.stringMatching(/unsupported field|invalid/i),
      },
    });
    expect(await stat(invalidRoot).catch(() => null)).toBeNull();

    await mkdir(occupiedRoot, { mode: 0o700 });
    await writeFile(join(occupiedRoot, "keep.txt"), "user-owned", "utf8");
    const occupied = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: occupiedRoot, relationship: relationship() },
      authoringServices(root),
    );
    expect(occupied).toMatchObject({ ok: false, error: { code: "output_not_empty" } });
    expect(await readFile(join(occupiedRoot, "keep.txt"), "utf8")).toBe("user-owned");
  });

  it("confines configured inspect and mutation paths without disclosing rejected paths", async () => {
    const root = await fixtureRoot();
    const inputRoot = join(root, "approved-input");
    const outputRoot = join(root, "approved-output");
    const outsideRoot = join(root, "outside");
    const sourceRoot = join(inputRoot, "source");
    const outsideSource = join(outsideRoot, "source");
    const linkedSource = join(inputRoot, "linked-source");
    const linkedOutputParent = join(outputRoot, "linked-output");
    await Promise.all([mkdir(outputRoot, { mode: 0o700 }), mkdir(outsideRoot, { mode: 0o700 })]);
    await Promise.all([writePackage(sourceRoot), writePackage(outsideSource)]);
    await symlink(outsideSource, linkedSource, process.platform === "win32" ? "junction" : "dir");
    await symlink(outsideRoot, linkedOutputParent, process.platform === "win32" ? "junction" : "dir");
    const services = {
      packageLoader: loadMotionPackage,
      authoringInputRoots: [inputRoot],
      authoringOutputRoots: [outputRoot],
    };

    const allowedInspect = await dispatchProceduralAuthoringCommand(
      "motion.procedural.inspect",
      { packageRoot: sourceRoot },
      services,
    );
    expect(allowedInspect).toMatchObject({ ok: true });
    const allowedMutation = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: join(outputRoot, "allowed"), relationship: relationship() },
      services,
    );
    expect(allowedMutation).toMatchObject({ ok: true });

    const rejectedInspect = await dispatchProceduralAuthoringCommand(
      "motion.procedural.inspect",
      { packageRoot: outsideSource },
      services,
    );
    expect(rejectedInspect).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    expect(rejectedInspect && !rejectedInspect.ok ? rejectedInspect.error.message : "").not.toContain(outsideSource);

    const rejectedTraversal = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: join(outputRoot, "..", "escaped"), relationship: relationship() },
      services,
    );
    expect(rejectedTraversal).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    expect(rejectedTraversal && !rejectedTraversal.ok ? rejectedTraversal.error.message : "").not.toContain(join(root, "escaped"));
    expect(await stat(join(root, "escaped")).catch(() => null)).toBeNull();

    const rejectedInputSymlink = await dispatchProceduralAuthoringCommand(
      "motion.procedural.inspect",
      { packageRoot: linkedSource },
      services,
    );
    expect(rejectedInputSymlink).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    const rejectedOutputSymlink = await dispatchProceduralAuthoringCommand(
      "motion.procedural.relationship.set",
      { packageRoot: sourceRoot, outDir: join(linkedOutputParent, "escaped"), relationship: relationship() },
      services,
    );
    expect(rejectedOutputSymlink).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    expect(await stat(join(outsideRoot, "escaped")).catch(() => null)).toBeNull();
  });

  it("produces a bounded data-only audio envelope and preserves only supplied decoder evidence", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const evidencedRoot = join(root, "evidenced");
    const unevidencedRoot = join(root, "unevidenced");
    await writeAudioEnvelopePackage(sourceRoot);
    const resources = localDecodeResources();
    const commands: Array<{ args: string[]; shell: false }> = [];
    const result = await dispatchProceduralAuthoringCommand(
      "motion.procedural.audio-envelope.produce",
      { packageRoot: sourceRoot, outDir: evidencedRoot, sourceLayerId: "music", envelopeId: "music-rms", sampleEveryMs: 50 },
      withTestAuthoringRoots({
        packageLoader: loadMotionPackage,
        ffmpegRunner: async (command: FfmpegCommand) => {
          commands.push(command);
          return {
            exitCode: 0,
            stdout: "lavfi.astats.Overall.RMS_level=-20.0\n",
            stderr: "",
            resources,
          };
        },
      }, { inputRoots: [root], outputRoots: [root] }),
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        envelope: { id: "music-rms", sourceLayerId: "music", sampleCount: 1, samplesSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        resources,
        receipt: { output: { resources } },
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ shell: false });
    expect(commands[0]?.args).toEqual(expect.arrayContaining([
      "-protocol_whitelist", "file", "-format_whitelist", "wav", "-t", "1", "-vn", "-sn", "-dn"
    ]));

    const withoutEvidence = await dispatchProceduralAuthoringCommand(
      "motion.procedural.audio-envelope.produce",
      { packageRoot: sourceRoot, outDir: unevidencedRoot, sourceLayerId: "music", envelopeId: "music-rms-plain", sampleEveryMs: 50 },
      withTestAuthoringRoots({
        packageLoader: loadMotionPackage,
        ffmpegRunner: async () => ({ exitCode: 0, stdout: "lavfi.astats.Overall.RMS_level=-20.0\n", stderr: "" }),
      }, { inputRoots: [root], outputRoots: [root] }),
    );
    expect(withoutEvidence).toMatchObject({ ok: true, result: { envelope: { id: "music-rms-plain" } } });
    if (!withoutEvidence || !withoutEvidence.ok) throw new Error("audio envelope fixture should succeed");
    const output = withoutEvidence.result as Record<string, unknown>;
    expect(output.resources).toBeUndefined();
    expect((output.receipt as { output: Record<string, unknown> }).output.resources).toBeUndefined();
  });

  it("binds procedural envelope decoding and its source receipt hash to one private audio snapshot after RED substitution", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "output");
    const sourcePath = join(sourceRoot, "assets", "tone.wav");
    const admittedBytes = Buffer.from("fixture audio bytes", "utf8");
    await writeAudioEnvelopePackage(sourceRoot);
    const commands: Array<{ args: string[] }> = [];
    const result = await dispatchProceduralAuthoringCommand(
      "motion.procedural.audio-envelope.produce",
      { packageRoot: sourceRoot, outDir: outputRoot, sourceLayerId: "music", envelopeId: "snapshot-envelope", sampleEveryMs: 50 },
      withTestAuthoringRoots({
        packageLoader: loadMotionPackage,
        ffmpegRunner: async (command: FfmpegCommand) => {
          commands.push(command);
          await writeFile(sourcePath, "RED replacement bytes", "utf8");
          return { exitCode: 0, stdout: "lavfi.astats.Overall.RMS_level=-20.0\n", stderr: "" };
        }
      }, { inputRoots: [root], outputRoots: [root] })
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        receipt: { inputHashes: { "audio-source:music": hashBuffer(admittedBytes) } }
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).not.toContain(sourcePath);
    expect(commands[0]?.args).toEqual(expect.arrayContaining([
      "-format_whitelist", "wav", "-i",
      expect.stringMatching(/\/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.wav$/)
    ]));
  });

  it("refuses an envelope decode before runner invocation when its duration would exceed the sample budget", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "long-source");
    await writeAudioEnvelopePackage(sourceRoot, 4_096_001);
    let runnerCalls = 0;
    const result = await dispatchProceduralAuthoringCommand(
      "motion.procedural.audio-envelope.produce",
      { packageRoot: sourceRoot, outDir: join(root, "rejected"), sourceLayerId: "music", envelopeId: "too-long", sampleEveryMs: 1_000 },
      withTestAuthoringRoots({
        packageLoader: loadMotionPackage,
        ffmpegRunner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }, { inputRoots: [root], outputRoots: [root] }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "procedural_audio_envelope_produce_failed", message: expect.stringMatching(/4096 samples/) } });
    expect(runnerCalls).toBe(0);
  });

  it("refuses reference-bearing procedural audio containers before the decoder or output transaction starts", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "hostile-source");
    const outDir = join(root, "rejected");
    await writeAudioEnvelopePackage(sourceRoot, 1_000, "attack.mp4");
    let runnerCalls = 0;
    const result = await dispatchProceduralAuthoringCommand(
      "motion.procedural.audio-envelope.produce",
      { packageRoot: sourceRoot, outDir, sourceLayerId: "music", envelopeId: "rejected", sampleEveryMs: 50 },
      withTestAuthoringRoots({
        packageLoader: loadMotionPackage,
        ffmpegRunner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }, { inputRoots: [root], outputRoots: [root] }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "procedural_audio_envelope_produce_failed", message: expect.stringMatching(/WAV, FLAC, MP3, Ogg, or Opus/) },
    });
    expect(runnerCalls).toBe(0);
    expect(await stat(outDir).catch(() => null)).toBeNull();
  });
});

function relationship() {
  return {
    id: "drift",
    enabled: true,
    target: { layerId: "target", property: "transform.x" as const },
    nodes: [
      { id: "source", type: "property" as const, ref: { layerId: "driver", property: "opacity" as const } },
      { id: "time", type: "time" as const, unit: "seconds" as const },
      { id: "speed", type: "constant" as const, value: 20 },
      { id: "motion", type: "multiply" as const, left: "time", right: "speed" },
      { id: "gain", type: "constant" as const, value: 0.5 },
      { id: "output", type: "add" as const, left: "source", right: "motion" },
    ],
    outputNodeId: "output",
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-procedural-authoring-"));
  roots.push(root);
  return root;
}

function authoringServices(root: string) {
  return withTestAuthoringRoots({ packageLoader: loadMotionPackage }, {
    inputRoots: [root],
    outputRoots: [root],
  });
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "procedural-fixture",
    name: "Procedural fixture",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "procedural-motion",
    name: "Procedural fixture",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [
      {
        id: "driver",
        type: "shape",
        shape: "rectangle",
        startMs: 0,
        durationMs: 1_000,
        width: 10,
        height: 10,
        fill: "#ffffff",
        opacity: 40,
      },
      {
        id: "target",
        type: "shape",
        shape: "rectangle",
        startMs: 0,
        durationMs: 1_000,
        width: 20,
        height: 20,
        fill: "#336699",
        transform: { x: 0, y: 0 },
      },
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  });
}

async function writeAudioEnvelopePackage(root: string, durationMs = 1_000, sourceFileName = "tone.wav"): Promise<void> {
  await writePackage(root);
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", sourceFileName), "fixture audio bytes", "utf8");
  const motion = JSON.parse(await readFile(join(root, "motion.json"), "utf8")) as Record<string, unknown>;
  motion.durationMs = durationMs;
  const layers = motion.layers as Array<Record<string, unknown>>;
  for (const layer of layers) layer.durationMs = durationMs;
  layers.push({ id: "music", type: "audio", source: `assets/${sourceFileName}`, startMs: 0, durationMs });
  await writeJson(join(root, "motion.json"), motion);
}

function localDecodeResources() {
  return {
    schema: "shellx-motion/local-job-resources@1" as const,
    jobId: "audio-envelope-test",
    lane: "ffmpeg" as const,
    operation: "ffmpeg",
    state: "passed" as const,
    queueWaitMs: 0,
    durationMs: 1,
    policy: {
      maxConcurrentJobs: 1,
      maxQueueDepth: 1,
      maxQueueWaitMs: 1_000,
      maxWallClockMs: 1_000,
      minFreeScratchBytes: 0,
      scratchReservationBytes: 0,
      maxProcessTreeRssBytes: 1_024,
      rssPollIntervalMs: 50,
    },
    scratch: { pathSafety: "canonical-no-symlink" as const, freeBytesAtStart: 1, reservedBytes: 0, minFreeBytes: 0 },
    peakProcessTreeRssBytes: 0,
    watchedProcessCount: 1,
    rssScope: "process-tree" as const,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
