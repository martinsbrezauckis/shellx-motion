import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonSha256, compileGpuHybridTextureRequests, createGpuHybridTextureSourceSnapshot, deriveGpuHybridTextureStaticDescriptor, type MotionPackage } from "@shellx-motion/core";
import { fingerprintResolvedMotionPackageContent } from "./segmented-final-internal/package-content-fingerprint.js";
import { GpuSegmentedHybridAdmission, GpuSegmentedHybridPreparation } from "@shellx-motion/renderer-browser";
import { afterEach, describe, expect, it, vi } from "vitest";

const bootstrap = vi.hoisted(() => ({ implementation: undefined as undefined | ((input: any) => Promise<any>), prepare: undefined as undefined | ((input: any) => Promise<any>) }));
vi.mock("@shellx-motion/renderer-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/renderer-browser")>();
  return {
    ...actual,
    prepareGpuSegmentedHybridAdmission: async (input: any) => bootstrap.prepare ? await bootstrap.prepare(input) : await actual.prepareGpuSegmentedHybridAdmission(input),
    bootstrapGpuSegmentedHybridAdmission: async (input: any) => bootstrap.implementation ? await bootstrap.implementation(input) : await actual.bootstrapGpuSegmentedHybridAdmission(input)
  };
});
import { prepareAdmittedSegmentedGpuHost } from "./segmented-final-gpu-host.js";

const roots: string[] = [];
afterEach(async () => { bootstrap.implementation = undefined; bootstrap.prepare = undefined; await Promise.allSettled(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

describe("segmented B2 hybrid host admission", () => {
  it.each(["html", "web", "canvas"] as const)("admits strict data-only %s through one pre-store no-pixel Core topology runtime", async (type) => {
    const fixture = await fixtureFor("<div>strict surface</div>", type);
    let opened = 0, closed = 0;
    bootstrap.prepare = preparation;
    bootstrap.implementation = async ({ preparation }) => admission(preparation, fixture.pkg);
    try {
      const prepared = await prepareAdmittedSegmentedGpuHost({
        pkg: fixture.pkg, packageContentSha256: fixture.contentSha256, timeline: fixture.timeline, job: fixture.job(), maxProcessTreeRssBytes: 512 * 1024 * 1024,
        runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        policy: { openRuntime: async (_images, _fonts, options) => {
          opened += 1; expect(options.dynamicImages).toHaveLength(1);
          return runtime(options.finalBrowser.maxProcessTreeRssBytes, () => { closed += 1; });
        } }
      });
      expect(prepared.producer.identity.schema).toBe("shellx-motion/gpu-hybrid-segmented-identity@1");
      expect(opened).toBe(1); expect(closed).toBe(1);
      await prepared.release();
    } finally { await fixture.dispose(); }
  });

  it("refuses malformed HTML before runtime or durable-store admission", async () => {
    const fixture = await fixtureFor("<script>forbidden()</script>"); let opened = 0;
    bootstrap.prepare = async () => { throw new Error("GPU segmented hybrid strict data-only HTML refusal: script is not admitted"); };
    try {
      await expect(prepareAdmittedSegmentedGpuHost({
        pkg: fixture.pkg, packageContentSha256: fixture.contentSha256, timeline: fixture.timeline, job: fixture.job(), maxProcessTreeRssBytes: 512 * 1024 * 1024,
        runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }), policy: { openRuntime: async () => { opened += 1; throw new Error("must not open"); } }
      })).rejects.toThrow(/strict data-only HTML refusal/);
      expect(opened).toBe(0);
    } finally { await fixture.dispose(); }
  });

  it("refuses H0 to H1 to H0 source swapping before the durable store exists", async () => {
    const fixture = await fixtureFor("<div>H0</div>");
    try {
      await writeFile(join(fixture.root, "surface.html"), "<div>H1</div>", { mode: 0o600 });
      bootstrap.prepare = preparation;
      await expect(prepareAdmittedSegmentedGpuHost({
        pkg: fixture.pkg, packageContentSha256: fixture.contentSha256, timeline: fixture.timeline, job: fixture.job(), maxProcessTreeRssBytes: 512 * 1024 * 1024,
        runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        testAfterHybridSourceFreeze: async () => await writeFile(join(fixture.root, "surface.html"), "<div>H0</div>", { mode: 0o600 })
      })).rejects.toThrow(/loaded input changed before fingerprinting/);
    } finally { await fixture.dispose(); }
  });

  it("retains both bootstrap and runtime-close failures before any durable store can exist", async () => {
    const fixture = await fixtureFor("<div>strict surface</div>");
    bootstrap.prepare = preparation;
    bootstrap.implementation = async () => { throw new Error("controlled bootstrap failure"); };
    try {
      let error: unknown;
      try {
        await prepareAdmittedSegmentedGpuHost({
          pkg: fixture.pkg, packageContentSha256: fixture.contentSha256, timeline: fixture.timeline, job: fixture.job(), maxProcessTreeRssBytes: 512 * 1024 * 1024,
          runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          policy: { openRuntime: async (_images, _fonts, options) => runtime(options.finalBrowser.maxProcessTreeRssBytes, () => { throw new Error("controlled runtime close failure"); }) }
        });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(AggregateError);
      const causes = (error as AggregateError).errors.map((cause) => cause instanceof Error ? cause.message : String(cause));
      expect(causes).toEqual(expect.arrayContaining(["controlled bootstrap failure", "controlled runtime close failure"]));
    } finally { await fixture.dispose(); }
  });
});

async function fixtureFor(html: string, type: "html" | "web" | "canvas" = "html") {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-b2-hybrid-host-")); roots.push(root);
  const browser = join(root, "chromium"); await writeFile(join(root, "surface.html"), html, { mode: 0o600 }); await writeFile(browser, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await chmod(browser, 0o700);
  const prior = process.env.SHELLX_MOTION_BROWSER; process.env.SHELLX_MOTION_BROWSER = browser;
  const pkg: MotionPackage = {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "b2-host", name: "B2 host", motion: "motion.json", assets: ["surface.html"], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "b2-host-motion", name: "B2 host", durationMs: 1_000, fps: 4, width: 16, height: 16, layers: [{ id: "surface", type, source: "surface.html", startMs: 0, durationMs: 500 }], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }
  };
  const source = await fingerprintResolvedMotionPackageContent(root);
  return {
    root, pkg, contentSha256: source.sha256, timeline: { motionSha256: "a".repeat(64), frameCount: 4, durationMs: 1_000, fps: 4, width: 16, height: 16 },
    job: () => ({ jobId: "b2-hybrid-host", scratchRoot: root, signal: new AbortController().signal, watchProcess() {}, reportProcessContainment() {}, reportSandbox() {} }),
    dispose: async () => { if (prior === undefined) delete process.env.SHELLX_MOTION_BROWSER; else process.env.SHELLX_MOTION_BROWSER = prior; }
  };
}

function admission(preparation: any, pkg: MotionPackage) {
  const snapshot = preparation.identity.sourceSnapshot;
  const planned = compileGpuHybridTextureRequests({ motion: pkg.motion, atUs: 0, snapshots: new Map([[snapshot.layerId, snapshot]]) });
  if (!planned.ok || planned.requests.length !== 1) throw new Error("fixture could not mint bootstrap request");
  const request = planned.requests[0]!; const dynamic = preparation.dynamicTexture;
  return new GpuSegmentedHybridAdmission({
    ...preparation.identity, browser: { ...preparation.identity.browser, version: "test-chromium/1" },
    bootstrap: { index: 0, atMs: 0, atUs: 0, requestFingerprint: request.requestFingerprint, resourceId: dynamic.id, width: dynamic.width, height: dynamic.height, pngSha256: "b".repeat(64), decodedRgbaSha256: "c".repeat(64), cleanup: { captureContext: "closed", scratch: "released", dynamicTexture: { ...dynamic } } }
  }, dynamic);
}

async function preparation(input: { pkg: MotionPackage; staticPlan: { fingerprint: string; hybridTextures?: readonly unknown[] }; browser: { name: "chromium"; executableSha256: string; runtimePolicy: "borrowed-precontained-chromium-data-only-no-network" } }) {
  const descriptor = deriveGpuHybridTextureStaticDescriptor(input.pkg.motion, input.pkg.motion.layers[0]!);
  if (!descriptor) throw new Error("fixture lacks a Core strict HTML descriptor");
  const bytes = await readFile(join(input.pkg.root, descriptor.assetRef));
  const sourceSnapshotSha256 = createHash("sha256").update(bytes).digest("hex");
  const policy = { scripts: "data-only-none" as const, network: "no-egress" as const, htmlClosure: "primary-self-contained" as const, capture: "one-borrowed-browser-context-per-bootstrap-or-range" as const };
  const captureContractSha256 = canonicalJsonSha256({ schema: "shellx-motion/gpu-segmented-hybrid-capture-contract@1", staticPlanFingerprint: input.staticPlan.fingerprint, descriptorFingerprint: descriptor.descriptorFingerprint, sourceSnapshotSha256, sourceByteLength: bytes.byteLength, browser: input.browser, policy });
  const sourceSnapshot = createGpuHybridTextureSourceSnapshot({ descriptor, sourceSnapshotSha256, sourceByteLength: bytes.byteLength, captureContractSha256 });
  const dynamicTexture = { id: `hybrid-${createHash("sha256").update(descriptor.descriptorFingerprint).digest("hex").slice(0, 24)}`, width: descriptor.width, height: descriptor.height, sourceSha256: captureContractSha256 };
  return new GpuSegmentedHybridPreparation({ schema: "shellx-motion/gpu-segmented-hybrid-preparation@1", staticPlanFingerprint: input.staticPlan.fingerprint, descriptor, sourceSnapshot, captureContractSha256, browser: input.browser, dynamicTexture: { ...dynamicTexture, bytes: descriptor.width * descriptor.height * 4 }, policy }, dynamicTexture);
}

function runtime(maxProcessTreeRssBytes: number, close: () => void) {
  return {
    ok: true as const,
    session: {
      browserProcess: { pid: 4_242, launcher: "precontained-direct-chromium", containment: { rootPid: 4_242, mode: "unix-process-group", status: "enforced", killTree: true, memoryLimit: "rss-monitor", maxProcessTreeRssBytes } },
      browserVersion: "test-chromium/1",
      runtimeEvidence: { schema: "shellx-motion/gpu-runtime-evidence@1", backend: "webgpu-browser", browserSource: "override", webgpuFeatureStatus: "enabled", adapterFingerprint: "d".repeat(64), adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "test", cdpDevice: "test", vendor: "test", device: "test", architecture: null, description: null }, limits: { maxTextureDimension2D: 4096, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 } },
      async uploadImages() { return { ok: true as const, uploaded: 0 }; }, async render() { throw new Error("not a pixel test"); }, async close() { close(); }
    }
  } as never;
}
