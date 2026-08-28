import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJsonSha256, createGpuHybridTextureSourceSnapshot, deriveGpuHybridTextureStaticDescriptor, type MotionDocument } from "@shellx-motion/core";
import { gpuSegmentedHybridAdmissionIdentityProblem, type GpuSegmentedHybridAdmissionIdentity } from "@shellx-motion/renderer-browser";
import { gpuEnvironmentArenaEvidence } from "./gpu-final-receipt-provenance.js";
import { combinedSegmentProducerEvidence } from "./segmented-final-internal/render-segment-producer-evidence.js";
import {
  gpuRangeFramePlanSequenceSha256,
  gpuRangeFrameSequenceSha256,
  segmentFrameSequenceSha256
} from "./segmented-final-internal/render-segment-store-identity.js";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { createRenderSegmentStore, resumeRenderSegmentStore, type RenderSegmentStore } from "./segmented-final-internal/render-segment-store.js";
import type {
  CreateRenderSegmentStoreInput,
  RenderSegmentGpuHybridIdentity,
  RenderSegmentGpuHybridRangeProducerEvidence,
  RenderSegmentGpuStandardIdentity,
  RenderSegmentGpuRangeProducerEvidence
} from "./segmented-final-internal/render-segment-store-types.js";

const hashes = Array.from({ length: 32 }, (_, index) => "abcdef0123456789"[index % 16]!.repeat(64));
const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("internal GPU segmented identity", () => {
  it("creates a data-only GPU checkpoint and resumes the exact verified prefix", async () => {
    const input = await gpuInput();
    const created = await createRenderSegmentStore(input);
    await stageGpuRange(created, 0, input);

    const resumed = await resumeRenderSegmentStore(input);
    expect(resumed.manifest.schema).toBe("shellx-motion/gpu-render-segment-store@1");
    expect(resumed.verifiedPrefix).toHaveLength(1);
    expect(resumed.nextIndex).toBe(1);
    await stageGpuRange(resumed, 1, input);
    expect(resumed.verifiedPrefix).toHaveLength(2);
  });

  it("fails create before a durable store exists when the GPU identity is missing", async () => {
    const input = await gpuInput();
    await expect(createRenderSegmentStore({
      ...input,
      producer: { frameLane: "gpu" } as never
    })).rejects.toMatchObject({ code: "segment_plan_invalid" });
  });

  it("refuses a new range whose exact GPU producer evidence conflicts with the first range", async () => {
    const input = await gpuInput();
    const store = await createRenderSegmentStore(input);
    await stageGpuRange(store, 0, input);
    const changed = cloneGpuInput(input, { pipelineCatalogSha256: hashes[20]! });
    await writeFile(store.temporaryArtifactPath(1), "gpu-range-1");
    const range = store.manifest.plan.ranges[1]!;
    const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
    await expect(store.commit({
      index: 1,
      temporaryArtifactPath: store.temporaryArtifactPath(1),
      frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
      frameHashes,
      blankFrameCount: 0,
      producer: gpuRangeEvidence(changed.producer.identity, range, input.timeline, frameHashes)
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });
  });

  it("refuses a stored GPU prefix when a resume supplies a changed GPU identity", async () => {
    const input = await gpuInput();
    const store = await createRenderSegmentStore(input);
    await stageGpuRange(store, 0, input);
    await expect(resumeRenderSegmentStore(cloneGpuInput(input, {
      hostVerdict: { ...input.producer.identity.hostVerdict, adapterFingerprint: hashes[21]! }
    }))).rejects.toMatchObject({ code: "segment_plan_mismatch" });
  });

  it("accepts an unchanged identity and rejects missing ordered GPU plan evidence", async () => {
    const input = await gpuInput();
    const store = await createRenderSegmentStore(input);
    const range = store.manifest.plan.ranges[0]!;
    const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
    const evidence = gpuRangeEvidence(input.producer.identity, range, input.timeline, frameHashes);
    await writeFile(store.temporaryArtifactPath(0), "gpu-range-0");
    await expect(store.commit({
      index: 0,
      temporaryArtifactPath: store.temporaryArtifactPath(0),
      frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
      frameHashes,
      blankFrameCount: 0,
      producer: { ...evidence, framePlanFingerprints: [] }
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });
    await expect(resumeRenderSegmentStore(input)).resolves.toMatchObject({ completedCount: 0 });
  });

  it("keeps no-environment ranges key-free, but range-binds and aggregates every environment arena", async () => {
    const noEnvironment = await gpuInput();
    const noEnvironmentRange = noEnvironment.plan.ranges[0]!;
    const noEnvironmentEvidence = gpuRangeEvidence(noEnvironment.producer.identity, noEnvironmentRange, noEnvironment.timeline, rangeHashes(0, 2)) as RenderSegmentGpuRangeProducerEvidence;
    expect(noEnvironmentEvidence.environmentArena).toBeUndefined();
    expect(noEnvironmentEvidence.finalReceiptInputHashes["gpu-environment-arena"]).toBeUndefined();

    const input = await gpuInput(1);
    const store = await createRenderSegmentStore(input);
    const firstRange = store.manifest.plan.ranges[0]!;
    const firstHashes = rangeHashes(firstRange.startFrame, firstRange.endFrameExclusive);
    const firstEvidence = gpuRangeEvidence(input.producer.identity, firstRange, input.timeline, firstHashes);
    expect(firstEvidence.environmentArena).toMatchObject({ environmentDrawsRendered: 0, resourceBudget: { maxEnvironmentDrawsPerFrame: 0 } });
    await writeFile(store.temporaryArtifactPath(0), "gpu-range-0");
    const { environmentArena: _missingArena, ...missingArena } = firstEvidence;
    await expect(store.commit({
      index: 0, temporaryArtifactPath: store.temporaryArtifactPath(0), frameSequenceSha256: segmentFrameSequenceSha256({ range: firstRange, frameHashes: firstHashes }), frameHashes: firstHashes, blankFrameCount: 0,
      producer: missingArena
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });

    await writeFile(store.temporaryArtifactPath(0), "gpu-range-0");
    await expect(store.commit({
      index: 0, temporaryArtifactPath: store.temporaryArtifactPath(0), frameSequenceSha256: segmentFrameSequenceSha256({ range: firstRange, frameHashes: firstHashes }), frameHashes: firstHashes, blankFrameCount: 0,
      producer: { ...firstEvidence, finalReceiptInputHashes: { ...firstEvidence.finalReceiptInputHashes, "gpu-environment-arena": hashes[31]! } }
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });

    await stageGpuRange(store, 0, input);
    await stageGpuRange(store, 1, input);
    const combined = combinedSegmentProducerEvidence(store.manifest);
    if (combined.frameLane !== "gpu") throw new Error("GPU fixture must retain GPU combined evidence.");
    const rangeArenaHashes = store.manifest.completed.map((entry) => entry.producer.frameLane === "gpu" ? entry.producer.finalReceiptInputHashes["gpu-environment-arena"] : undefined);
    expect("environmentArena" in combined ? combined.environmentArena : undefined).toBeUndefined();
    expect(combined.finalReceiptInputHashes["gpu-environment-arena"]).toBe(canonicalJsonSha256(rangeArenaHashes));
  });

  it("rejects missing or forged GPU readback transport receipt identities before checkpointing", async () => {
    const input = await gpuInput();
    const store = await createRenderSegmentStore(input);
    const range = store.manifest.plan.ranges[0]!;
    const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
    const evidence = gpuRangeEvidence(input.producer.identity, range, input.timeline, frameHashes);
    await writeFile(store.temporaryArtifactPath(0), "gpu-range-0");
    const { ["gpu-readback-transport"]: _readbackTransport, ...missingReadbackTransport } = evidence.finalReceiptInputHashes;
    await expect(store.commit({
      index: 0,
      temporaryArtifactPath: store.temporaryArtifactPath(0),
      frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
      frameHashes,
      blankFrameCount: 0,
      producer: { ...evidence, finalReceiptInputHashes: missingReadbackTransport }
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });

    await writeFile(store.temporaryArtifactPath(0), "gpu-range-0");
    await expect(store.commit({
      index: 0,
      temporaryArtifactPath: store.temporaryArtifactPath(0),
      frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
      frameHashes,
      blankFrameCount: 0,
      producer: { ...evidence, finalReceiptInputHashes: { ...evidence.finalReceiptInputHashes, "gpu-readback-transport": "forged" } }
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });
  });

  it("stores, resumes, validates, and aggregates only exact hybrid range ledgers", async () => {
    const input = await hybridInput();
    const store = await createRenderSegmentStore(input);
    await stageHybridRange(store, 0, input);
    await expect(resumeRenderSegmentStore(input)).resolves.toMatchObject({ completedCount: 1 });
    await stageHybridRange(store, 1, input); // no active hybrid request in the second range
    const combined = combinedSegmentProducerEvidence(store.manifest);
    expect(combined).toMatchObject({
      schema: "shellx-motion/gpu-hybrid-segment-aggregate-producer@1",
      hybrid: { rangeCount: 2, captureCount: 2, captureSequenceSha256: canonicalJsonSha256(input.producer.identity.hybrid.capturePlan.entries.map((entry) => hybridLedgerEntry(input.producer.identity, entry))) }
    });
    if (combined.schema !== "shellx-motion/gpu-hybrid-segment-aggregate-producer@1") throw new Error("Hybrid fixture lost its final aggregate schema.");
    expect("ledger" in combined.hybrid).toBe(false);

    const tampered = await hybridInput();
    const tamperedStore = await createRenderSegmentStore(tampered);
    const range = tamperedStore.manifest.plan.ranges[0]!;
    const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
    const evidence = hybridRangeEvidence(tampered.producer.identity, range, tampered.timeline, frameHashes);
    await writeFile(tamperedStore.temporaryArtifactPath(0), "hybrid-tamper");
    await expect(tamperedStore.commit({
      index: 0, temporaryArtifactPath: tamperedStore.temporaryArtifactPath(0),
      frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }), frameHashes, blankFrameCount: 0,
      producer: { ...evidence, hybrid: { ...evidence.hybrid, ledger: { ...evidence.hybrid.ledger, entries: [...evidence.hybrid.ledger.entries].reverse() } } }
    })).rejects.toMatchObject({ code: "segment_entry_invalid" });
  });

  it("refuses every immutable hybrid substitution before prefix use and every required range receipt field before commit", async () => {
    const input = await hybridInput();
    const store = await createRenderSegmentStore(input);
    await stageHybridRange(store, 0, input);
    const substitutions: Array<[string, (identity: RenderSegmentGpuHybridIdentity) => RenderSegmentGpuHybridIdentity, "segment_plan_mismatch" | "segment_plan_invalid"]> = [
      ["source snapshot", replaceHybridSource, "segment_plan_mismatch"],
      ["runtime browser version", (identity) => ({ ...identity, hostVerdict: { ...identity.hostVerdict, browser: { ...identity.hostVerdict.browser, version: "141.0.0.0" } }, hybrid: { ...identity.hybrid, admission: { ...identity.hybrid.admission, browser: { ...identity.hybrid.admission.browser, version: "141.0.0.0" } } } }), "segment_plan_mismatch"],
      ["bootstrap pixels", (identity) => ({ ...identity, hybrid: { ...identity.hybrid, admission: { ...identity.hybrid.admission, bootstrap: { ...identity.hybrid.admission.bootstrap, pngSha256: hashes[30]! } } } }), "segment_plan_mismatch"],
      ["capture policy", (identity) => ({ ...identity, hybrid: { ...identity.hybrid, admission: { ...identity.hybrid.admission, policy: { ...identity.hybrid.admission.policy, network: "egress" as never } } } }), "segment_plan_invalid"],
      ["capture-plan digest", (identity) => ({ ...identity, hybrid: { ...identity.hybrid, capturePlan: { ...identity.hybrid.capturePlan, sha256: hashes[31]! } } }), "segment_plan_invalid"]
    ];
    for (const [name, mutate, code] of substitutions) {
      const identity = mutate(structuredClone(input.producer.identity));
      await expect(resumeRenderSegmentStore({ ...input, producer: { frameLane: "gpu", identity } })).rejects.toMatchObject({ code, message: expect.stringMatching(/Hybrid GPU|Segment store/) });
    }

    const rejectedRanges: Array<[string, (evidence: RenderSegmentGpuHybridRangeProducerEvidence) => RenderSegmentGpuHybridRangeProducerEvidence]> = [
      ["missing closed cleanup", (evidence) => ({ ...evidence, hybrid: { ...evidence.hybrid, cleanup: { ...evidence.hybrid.cleanup, scratch: "not-opened" } } })],
      ["forged admission digest", (evidence) => ({ ...evidence, finalReceiptInputHashes: { ...evidence.finalReceiptInputHashes, "gpu-hybrid-admission": hashes[30]! } })],
      ["missing capture-plan digest", (evidence) => {
        const { ["gpu-hybrid-capture-plan"]: _missing, ...hashesWithoutPlan } = evidence.finalReceiptInputHashes;
        return { ...evidence, finalReceiptInputHashes: hashesWithoutPlan };
      }],
      ["forged ordered ledger digest", (evidence) => ({ ...evidence, finalReceiptInputHashes: { ...evidence.finalReceiptInputHashes, "gpu-hybrid-range-ledger": hashes[31]! } })]
    ];
    for (const [name, mutate] of rejectedRanges) {
      const candidate = await hybridInput();
      const candidateStore = await createRenderSegmentStore(candidate);
      const range = candidateStore.manifest.plan.ranges[0]!;
      const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
      await writeFile(candidateStore.temporaryArtifactPath(0), `hybrid-${name}`);
      await expect(candidateStore.commit({
        index: 0, temporaryArtifactPath: candidateStore.temporaryArtifactPath(0),
        frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }), frameHashes, blankFrameCount: 0,
        producer: mutate(hybridRangeEvidence(candidate.producer.identity, range, candidate.timeline, frameHashes))
      })).rejects.toMatchObject({ code: "segment_entry_invalid" });
    }
  });
});

async function gpuInput(maxEnvironmentCount = 0): Promise<CreateRenderSegmentStoreInput & { producer: { frameLane: "gpu"; identity: RenderSegmentGpuStandardIdentity } }> {
  const rootPath = await mkdtemp(join(tmpdir(), "shellx-motion-gpu-segment-"));
  roots.push(rootPath);
  const plan = planRenderSegments({ frameCount: 4, segmentFrames: 2 });
  const identity: RenderSegmentGpuStandardIdentity = {
    schema: "shellx-motion/gpu-segmented-identity@1",
    packageContentSha256: hashes[2]!,
    pipelineCatalogSha256: hashes[3]!,
    staticPlan: { fingerprint: hashes[4]!, documentFingerprint: hashes[5]!, resourceReferencesSha256: hashes[6]!, canonicalFrameCount: 4, maxEnvironmentCount },
    staticScene: { sha256: hashes[7]!, inputHashesSha256: hashes[8]! },
    hostVerdict: {
      schema: "shellx-motion/gpu-segmented-host-verdict@1",
      platform: "linux",
      browser: { source: "path", executableSha256: hashes[9]!, version: "140.0.0.0" },
      launchProfileSha256: hashes[10]!,
      runtimeEvidenceSha256: hashes[11]!,
      adapterFingerprint: hashes[12]!,
      containment: { mode: "unix-process-group", memoryLimit: "rss-monitor", maxProcessTreeRssBytes: 512 * 1024 * 1024 },
      session: { purpose: "pre-store-identity", emittedFrames: 0, cleanup: "complete" }
    }
  };
  return {
    rootPath,
    plan,
    package: { id: "gpu-segment-test", manifestSha256: hashes[0]!, contentSha256: hashes[2]! },
    frameLane: "gpu",
    producer: { frameLane: "gpu", identity },
    timeline: { motionSha256: hashes[1]!, durationMs: 1000, fps: 4, width: 64, height: 36 },
    intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" },
    verifyReadback: ({ range }) => ({ ok: true, readback: { verified: true, frameCount: range.frameCount, width: 64, height: 36, fps: 4, durationMs: range.frameCount * 250 } })
  };
}

function cloneGpuInput(
  input: Awaited<ReturnType<typeof gpuInput>>,
  update: Partial<RenderSegmentGpuStandardIdentity>
): Awaited<ReturnType<typeof gpuInput>> {
  return { ...input, producer: { frameLane: "gpu", identity: { ...input.producer.identity, ...update } } };
}

async function stageGpuRange(store: RenderSegmentStore, index: number, input: Awaited<ReturnType<typeof gpuInput>>): Promise<void> {
  const range = store.manifest.plan.ranges[index]!;
  const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
  await writeFile(store.temporaryArtifactPath(index), `gpu-range-${index}`);
  await store.commit({
    index,
    temporaryArtifactPath: store.temporaryArtifactPath(index),
    frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
    frameHashes,
    blankFrameCount: 0,
    producer: gpuRangeEvidence(input.producer.identity, range, input.timeline, frameHashes)
  });
}

function gpuRangeEvidence(
  identity: RenderSegmentGpuStandardIdentity,
  range: { index: number; startFrame: number; endFrameExclusive: number; frameCount: number },
  timeline: { durationMs: number; fps: number },
  frameHashes: string[]
): RenderSegmentGpuRangeProducerEvidence {
  const framePlanFingerprints = frameHashes.map((_, offset) => hashes[13 + range.startFrame + offset]!);
  const frameSequenceSha256 = gpuRangeFrameSequenceSha256({ range, timeline, frameHashes });
  const framePlanSequenceSha256 = gpuRangeFramePlanSequenceSha256({ range, timeline, framePlanFingerprints });
  const environmentWork = identity.staticPlan.maxEnvironmentCount > 0 && range.index > 0;
  const environmentArena = identity.staticPlan.maxEnvironmentCount > 0
    ? gpuEnvironmentArenaEvidence({
      staticPlan: { fingerprint: identity.staticPlan.fingerprint, canonicalFrameCount: identity.staticPlan.canonicalFrameCount, maxima: { maxEnvironmentCount: identity.staticPlan.maxEnvironmentCount } },
      resourceBudget: { expectedFrames: range.frameCount, observedFrames: range.frameCount, maxima: { environmentCount: environmentWork ? 8 : 0, environmentUniformBytes: environmentWork ? 1_664 : 0 } },
      sessionResources: {
        frameArenaReconfigurations: 1, frameArenaReservations: range.frameCount, frameArenaLateAllocationRefusals: 0, frameArenaBytes: 8, frameArenaHighWaterBytes: 8,
        environmentUniformCapacitySlots: 36, environmentUniformBytes: 9_216, environmentUniformHighWaterSlots: 36, environmentUniformHighWaterBytes: 9_216,
        environmentUniformLateAllocationRefusals: 0, environmentDrawsRendered: environmentWork ? 16 : 0, environmentEnvelopeReservations: 1
      },
      range
    })
    : null;
  if (environmentArena === undefined) throw new Error("GPU range test fixture must derive valid environment evidence.");
  return {
    schema: "shellx-motion/gpu-segment-range-producer@1",
    frameLane: "gpu",
    identity,
    frameSequenceSha256,
    framePlanSequenceSha256,
    framePlanFingerprints,
    ...(environmentArena ? { environmentArena } : {}),
    finalReceiptInputHashes: {
      "gpu-pipeline-catalog": identity.pipelineCatalogSha256,
      "gpu-static-plan": identity.staticPlan.fingerprint,
      "gpu-static-plan-document": identity.staticPlan.documentFingerprint,
      "gpu-static-plan-resources": identity.staticPlan.resourceReferencesSha256,
      "gpu-static-scene": identity.staticScene.sha256,
      "gpu-static-inputs": identity.staticScene.inputHashesSha256,
      "gpu-adapter": identity.hostVerdict.adapterFingerprint,
      "gpu-runtime": identity.hostVerdict.runtimeEvidenceSha256,
      "gpu-containment": hashes[19]!,
      "gpu-resource-budget": hashes[20]!,
      "gpu-session-resources": hashes[21]!,
      "gpu-readback-transport": hashes[22]!,
      "gpu-frame-sequence": frameSequenceSha256,
      "gpu-frame-plan-sequence": framePlanSequenceSha256,
      ...(environmentArena ? { "gpu-environment-arena": canonicalJsonSha256(environmentArena) } : {})
    },
    warningUnion: [],
    warningsOmitted: 0
  };
}

function rangeHashes(start: number, end: number): string[] {
  return Array.from({ length: end - start }, (_, offset) => hashes[22 + start + offset]!);
}

async function hybridInput(): Promise<CreateRenderSegmentStoreInput & { producer: { frameLane: "gpu"; identity: RenderSegmentGpuHybridIdentity } }> {
  const standard = await gpuInput();
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1", id: "hybrid-motion", name: "hybrid", durationMs: 1_000, fps: 4, width: 64, height: 36,
    layers: [{ id: "surface", type: "html", source: "surface.html", startMs: 0, durationMs: 500 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" }
  };
  const descriptor = deriveGpuHybridTextureStaticDescriptor(motion, motion.layers[0]!);
  if (!descriptor) throw new Error("Hybrid fixture requires one Core descriptor.");
  const browser = { name: "chromium" as const, executableSha256: hashes[9]!, runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" as const };
  const policy = { scripts: "data-only-none" as const, network: "no-egress" as const, htmlClosure: "primary-self-contained" as const, capture: "one-borrowed-browser-context-per-bootstrap-or-range" as const };
  const sourceSnapshotSha256 = hashes[23]!;
  const captureContractSha256 = canonicalJsonSha256({ schema: "shellx-motion/gpu-segmented-hybrid-capture-contract@1", staticPlanFingerprint: standard.producer.identity.staticPlan.fingerprint, descriptorFingerprint: descriptor.descriptorFingerprint, sourceSnapshotSha256, sourceByteLength: 24, browser, policy });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({ descriptor, sourceSnapshotSha256, sourceByteLength: 24, captureContractSha256 });
  const id = `hybrid-${createHash("sha256").update(descriptor.descriptorFingerprint).digest("hex").slice(0, 24)}`;
  const dynamicTexture = { id, width: 64, height: 36, sourceSha256: captureContractSha256, bytes: 64 * 36 * 4 };
  const entries = [0, 1].map((index) => ({ index, atMs: index * 250, atUs: index * 250_000, requestFingerprint: hashes[24 + index]! }));
  const admission: GpuSegmentedHybridAdmissionIdentity = {
    schema: "shellx-motion/gpu-segmented-hybrid-admission@1", staticPlanFingerprint: standard.producer.identity.staticPlan.fingerprint,
    descriptor, sourceSnapshot, captureContractSha256, browser: { ...browser, version: "140.0.0.0" }, dynamicTexture, policy,
    bootstrap: { ...entries[0]!, resourceId: id, width: 64, height: 36, pngSha256: hashes[26]!, decodedRgbaSha256: hashes[27]!, cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: { id, width: 64, height: 36, sourceSha256: captureContractSha256 } } }
  };
  if (gpuSegmentedHybridAdmissionIdentityProblem(admission) !== null) throw new Error("Hybrid fixture admission must be Browser-valid.");
  const capturePlan = { schema: "shellx-motion/gpu-hybrid-capture-plan@1" as const, entries, sha256: canonicalJsonSha256({ schema: "shellx-motion/gpu-hybrid-capture-plan@1", entries }) };
  const identity: RenderSegmentGpuHybridIdentity = { ...standard.producer.identity, schema: "shellx-motion/gpu-hybrid-segmented-identity@1", hybrid: { admission, capturePlan } };
  return { ...standard, producer: { frameLane: "gpu", identity } };
}

function replaceHybridSource(identity: RenderSegmentGpuHybridIdentity): RenderSegmentGpuHybridIdentity {
  const admission = identity.hybrid.admission;
  const sourceSnapshotSha256 = hashes[28]!;
  const browser = {
    name: admission.browser.name,
    executableSha256: admission.browser.executableSha256,
    runtimePolicy: admission.browser.runtimePolicy
  };
  const captureContractSha256 = canonicalJsonSha256({
    schema: "shellx-motion/gpu-segmented-hybrid-capture-contract@1",
    staticPlanFingerprint: admission.staticPlanFingerprint,
    descriptorFingerprint: admission.descriptor.descriptorFingerprint,
    sourceSnapshotSha256,
    sourceByteLength: admission.sourceSnapshot.sourceByteLength,
    browser,
    policy: admission.policy
  });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({
    descriptor: admission.descriptor,
    sourceSnapshotSha256,
    sourceByteLength: admission.sourceSnapshot.sourceByteLength,
    captureContractSha256
  });
  return {
    ...identity,
    hybrid: {
      ...identity.hybrid,
      admission: {
        ...admission,
        captureContractSha256,
        sourceSnapshot,
        dynamicTexture: { ...admission.dynamicTexture, sourceSha256: captureContractSha256 },
        bootstrap: { ...admission.bootstrap, cleanup: { ...admission.bootstrap.cleanup, dynamicTexture: { ...admission.bootstrap.cleanup.dynamicTexture, sourceSha256: captureContractSha256 } } }
      }
    }
  };
}

async function stageHybridRange(store: RenderSegmentStore, index: number, input: Awaited<ReturnType<typeof hybridInput>>): Promise<void> {
  const range = store.manifest.plan.ranges[index]!;
  const frameHashes = rangeHashes(range.startFrame, range.endFrameExclusive);
  await writeFile(store.temporaryArtifactPath(index), `hybrid-range-${index}`);
  await store.commit({ index, temporaryArtifactPath: store.temporaryArtifactPath(index), frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }), frameHashes, blankFrameCount: 0, producer: hybridRangeEvidence(input.producer.identity, range, input.timeline, frameHashes) });
}

function hybridRangeEvidence(identity: RenderSegmentGpuHybridIdentity, range: { index: number; startFrame: number; endFrameExclusive: number; frameCount: number }, timeline: { durationMs: number; fps: number }, frameHashes: string[]): RenderSegmentGpuHybridRangeProducerEvidence {
  const framePlanFingerprints = frameHashes.map((_, offset) => hashes[13 + range.startFrame + offset]!);
  const entries = identity.hybrid.capturePlan.entries.filter((entry) => entry.index >= range.startFrame && entry.index < range.endFrameExclusive).map((entry) => hybridLedgerEntry(identity, entry));
  const ledger = { schema: "shellx-motion/gpu-segmented-hybrid-range-ledger@1" as const, rangeIndex: range.index, startFrameIndex: range.startFrame, endFrameIndexExclusive: range.endFrameExclusive, expectedCaptureCount: entries.length, captureCount: entries.length, entries, sequenceSha256: canonicalJsonSha256(entries) };
  const active = entries.length > 0;
  const cleanup = { captureContext: active ? "closed" as const : "not-opened" as const, scratch: active ? "released" as const : "not-opened" as const, dynamicTexture: { id: identity.hybrid.admission.dynamicTexture.id, width: 64, height: 36, sourceSha256: identity.hybrid.admission.captureContractSha256 } };
  const frameSequenceSha256 = gpuRangeFrameSequenceSha256({ range, timeline, frameHashes });
  const framePlanSequenceSha256 = gpuRangeFramePlanSequenceSha256({ range, timeline, framePlanFingerprints });
  return {
    schema: "shellx-motion/gpu-hybrid-segment-range-producer@1", frameLane: "gpu", identity, frameSequenceSha256, framePlanSequenceSha256, framePlanFingerprints,
    hybrid: { ledger, cleanup },
    finalReceiptInputHashes: {
      "gpu-pipeline-catalog": identity.pipelineCatalogSha256, "gpu-static-plan": identity.staticPlan.fingerprint, "gpu-static-plan-document": identity.staticPlan.documentFingerprint, "gpu-static-plan-resources": identity.staticPlan.resourceReferencesSha256,
      "gpu-static-scene": identity.staticScene.sha256, "gpu-static-inputs": identity.staticScene.inputHashesSha256, "gpu-adapter": identity.hostVerdict.adapterFingerprint, "gpu-runtime": identity.hostVerdict.runtimeEvidenceSha256,
      "gpu-containment": hashes[19]!, "gpu-resource-budget": hashes[20]!, "gpu-session-resources": hashes[21]!, "gpu-readback-transport": hashes[22]!, "gpu-frame-sequence": frameSequenceSha256, "gpu-frame-plan-sequence": framePlanSequenceSha256,
      "gpu-hybrid-admission": canonicalJsonSha256(identity.hybrid.admission), "gpu-hybrid-capture-plan": identity.hybrid.capturePlan.sha256, "gpu-hybrid-range-ledger": ledger.sequenceSha256
    }, warningUnion: [], warningsOmitted: 0
  };
}

function hybridLedgerEntry(identity: RenderSegmentGpuHybridIdentity, entry: RenderSegmentGpuHybridIdentity["hybrid"]["capturePlan"]["entries"][number]) {
  return { ...entry, resourceId: identity.hybrid.admission.dynamicTexture.id, width: 64, height: 36, pngSha256: hashes[26]!, decodedRgbaSha256: hashes[27]! };
}
