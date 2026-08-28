import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileGpuHybridTextureRequests,
  compileGpuSceneStaticPlan,
  streamingFrameTimestampMs,
  type MotionPackage,
} from "@shellx-motion/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindGpuSegmentedHybridPrivateState, prepareGpuSegmentedHybridAdmission } from "./gpu-segmented-hybrid-admission";
import { openGpuSegmentedHybridRangeCapture } from "./gpu-segmented-hybrid-range";
import { GpuSegmentedHybridAdmission, type GpuSegmentedHybridPreparation } from "./gpu-segmented-hybrid-types";

const SOURCE = Buffer.from("vec4 motionMain(vec2 uv) { return vec4(uv.x, uv.y, 0.0, 1.0); }");
const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const HASH = "a".repeat(64);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=", "base64");

const mocks = vi.hoisted(() => ({
  acquireScratch: vi.fn(),
  createSession: vi.fn(),
  render: vi.fn(),
  assertRestrictedShaderEvidence: vi.fn(),
}));

vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/core")>(),
  readVerifiedPackageAsset: async () => ({ bytes: Buffer.from(SOURCE), byteLength: SOURCE.byteLength, canonicalPath: "/opaque/source.glsl", sha256: SOURCE_SHA256 }),
}));

vi.mock("./gpu-hybrid-capture-scratch", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gpu-hybrid-capture-scratch")>(),
  acquireGpuHybridCaptureScratch: mocks.acquireScratch,
}));

vi.mock("./browser-streaming-session-registry", () => ({
  markBrowserStreamingSessionOptions: vi.fn(),
  renderBrowserStreamingFrame: mocks.render,
}));

vi.mock("./gpu-restricted-shader-hybrid", () => ({
  assertRestrictedShaderCaptureEvidence: mocks.assertRestrictedShaderEvidence,
}));

vi.mock("./index", () => ({
  createMotionBrowserRenderSession: mocks.createSession,
}));

describe("GPU segmented hybrid active-range scratch lifecycle", () => {
  const temporaryRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.render.mockImplementation(async (_session: unknown, options: { readonly outputPath: string }) => {
      await writeFile(options.outputPath, PNG);
      return capturedFrame();
    });
    mocks.createSession.mockResolvedValue({ close: vi.fn(async () => undefined) });
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("removes the frozen source and PNG from only its exact owned scratch child after an active capture", async () => {
    const scratch = await ownedScratch(temporaryRoots);
    const close = vi.fn(async () => undefined);
    mocks.createSession.mockResolvedValue({ close });
    const capture = await activeCapture(scratch);

    await expect(capture.capture(canonicalSchedule(capture.identity)[0]!)).resolves.toMatchObject({
      resourceId: capture.identity.dynamicTexture.id,
      width: 2,
      height: 2,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      motion: expect.objectContaining({
        width: 2,
        height: 2,
        background: "transparent",
        layers: [expect.objectContaining({ transform: { width: 2, height: 2 }, width: 2, height: 2 })],
      }),
    }), expect.any(Object));
    await expect(stat(join(scratch.child, "source.glsl"))).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(stat(join(scratch.child, "capture.png"))).resolves.toMatchObject({ isFile: expect.any(Function) });

    await expect(capture.close()).resolves.toMatchObject({ captureContext: "closed", scratch: "released" });
    await expect(stat(join(scratch.child, "source.glsl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(scratch.child, "capture.png"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(scratch.child)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(scratch.root)).isDirectory()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a foreign child remains, without deleting it or the caller scratch", async () => {
    const scratch = await ownedScratch(temporaryRoots);
    const capture = await activeCapture(scratch);
    await capture.capture(canonicalSchedule(capture.identity)[0]!);
    const foreign = join(scratch.child, "foreign-owner");
    await mkdir(foreign);

    await expect(capture.close()).rejects.toMatchObject({ code: expect.stringMatching(/^ENOTEMPTY|EEXIST$/) });
    await expect(stat(join(scratch.child, "source.glsl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(scratch.child, "capture.png"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(foreign)).isDirectory()).toBe(true);
    expect((await stat(scratch.child)).isDirectory()).toBe(true);
    expect((await stat(scratch.root)).isDirectory()).toBe(true);
  });

  it("aggregates a capture failure with close failure and exposes no completed ledger", async () => {
    const scratch = await ownedScratch(temporaryRoots);
    const close = vi.fn(async () => { throw new Error("session close broke"); });
    mocks.createSession.mockResolvedValue({ close });
    mocks.render.mockImplementation(async (_session: unknown, options: { readonly outputPath: string }) => {
      await writeFile(options.outputPath, PNG);
      throw new Error("capture broke");
    });
    let replacements = 0;
    const capture = await activeCapture(scratch, { async replaceDynamicImages() { replacements += 1; return { ok: true as const, replaced: 1 }; } });

    const failure = await capture.capture(canonicalSchedule(capture.identity)[0]!).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as unknown[];
    expect(errors.map((error) => error instanceof Error ? error.message : String(error))).toEqual(expect.arrayContaining(["capture broke", "session close broke"]));
    expect(replacements).toBe(0);
    expect(() => capture.finish()).toThrow(/did not complete/i);
    await expect(stat(scratch.child)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(scratch.root)).isDirectory()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

async function ownedScratch(roots: string[]): Promise<{ readonly root: string; readonly child: string }> {
  const root = await mkdtemp(join(tmpdir(), "motion-gpu-segmented-hybrid-lifecycle-"));
  const child = join(root, "owned-capture");
  await mkdir(child, { mode: 0o700 });
  roots.push(root);
  const authority = Object.freeze({ path: child, async assertCurrent() {} });
  mocks.acquireScratch.mockResolvedValue({ authority, root: child, pngPath: join(child, "capture.png"), async release() {} });
  return { root, child };
}

async function activeCapture(
  scratch: { readonly root: string; readonly child: string },
  runtime?: { replaceDynamicImages(): Promise<{ ok: true; replaced: number }> }
) {
  const preparation = await prepare();
  const admission = finalized(preparation);
  const range = { index: 0, startFrameIndex: 0, endFrameIndexExclusive: 1 };
  return openGpuSegmentedHybridRangeCapture({
    admission,
    runtime: {
      browserVersion: "123.0.0",
      borrowGpuBrowser: () => ({}) as never,
      replaceDynamicImages: runtime?.replaceDynamicImages ?? (async () => ({ ok: true as const, replaced: 1 })),
    } as never,
    job: { admission: "pre-acquired", scratchRoot: scratch.root, maxProcessTreeRssBytes: 1, signal: new AbortController().signal, watchProcess() {} } as never,
    range,
    schedule: canonicalSchedule(preparation.identity),
  });
}

async function prepare(): Promise<GpuSegmentedHybridPreparation> {
  const pkg = testPackage();
  const compiled = compileGpuSceneStaticPlan(pkg.motion);
  if (!compiled.ok) throw new Error(compiled.failure.message);
  return await prepareGpuSegmentedHybridAdmission({
    pkg,
    staticPlan: compiled.plan,
    browser: { name: "chromium", executableSha256: HASH, runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" },
  });
}

function finalized(preparation: GpuSegmentedHybridPreparation): GpuSegmentedHybridAdmission {
  const admission = new GpuSegmentedHybridAdmission({
    schema: "shellx-motion/gpu-segmented-hybrid-admission@1",
    staticPlanFingerprint: preparation.identity.staticPlanFingerprint,
    descriptor: preparation.identity.descriptor,
    sourceSnapshot: preparation.identity.sourceSnapshot,
    captureContractSha256: preparation.identity.captureContractSha256,
    browser: { ...preparation.identity.browser, version: "123.0.0" },
    dynamicTexture: preparation.identity.dynamicTexture,
    policy: preparation.identity.policy,
    bootstrap: { index: 0, atMs: 0, atUs: 0, requestFingerprint: HASH, resourceId: preparation.dynamicTexture.id, width: preparation.dynamicTexture.width, height: preparation.dynamicTexture.height, pngSha256: HASH, decodedRgbaSha256: HASH, cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: preparation.dynamicTexture } },
  }, preparation.dynamicTexture);
  bindGpuSegmentedHybridPrivateState(admission, preparation);
  return admission;
}

function canonicalSchedule(identity: { readonly sourceSnapshot: GpuSegmentedHybridPreparation["identity"]["sourceSnapshot"] }) {
  const motion = testPackage().motion;
  const atMs = streamingFrameTimestampMs(0, motion.fps, motion.durationMs);
  const planned = compileGpuHybridTextureRequests({ motion, atUs: Math.round(atMs * 1_000), snapshots: new Map([[identity.sourceSnapshot.layerId, identity.sourceSnapshot]]) });
  if (!planned.ok || planned.requests.length !== 1) throw new Error("test did not mint one active Core request");
  return [{ index: 0, atMs, request: planned.requests[0]! }];
}

function testPackage(): MotionPackage {
  return {
    root: "/opaque/package-root",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_b2_range_lifecycle", name: "B2 range lifecycle", motion: "motion.json", assets: ["assets/surface.glsl"], sourceApp: "shellx-motion", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_b2_range_lifecycle", name: "B2 range lifecycle", durationMs: 1_000, fps: 30, width: 4, height: 3, background: "#000000",
      layers: [{ id: "shader-surface", type: "shader", startMs: 0, durationMs: 1_000, transform: { x: 1, y: 1, width: 2, height: 2 }, shader: { schema: "shellx-motion/shader-plugin@1", language: "glsl-es-100-expression", fragmentAssetId: "surface-fragment", seed: 7, fallbackColor: "#000000" } }],
      assets: [{ id: "surface-fragment", type: "shader", source: { path: "assets/surface.glsl", mimeType: "text/x-shellx-motion-glsl" } }],
    },
  } as MotionPackage;
}

function capturedFrame() {
  return {
    png: PNG,
    result: {
      output: {
        network: { approvedOrigins: [], pins: [], allowPrivateNetwork: false },
        scriptExecution: { activeMode: "data-only", sources: [] },
      },
      receipt: { inputHashes: { "source.glsl": SOURCE_SHA256 } },
    },
  };
}
