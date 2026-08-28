import { encodeRgbaPng } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  GPU_POINTS_QUALIFICATION_SESSION_SCHEMA,
  assertWindowsGpuQualificationHost,
  preparePrivateQualificationOutputRoot,
  renderGpuPointsQualificationEvidence,
  writeGpuPointsQualificationEvidence
} from "./gpu-points-qualification-evidence.test-support";
import {
  assertSameCleanSource,
  assertSameGpuQualificationSourceBundle,
  collectGpuQualificationSourceIdentity,
  createGpuQualificationSourceBundle,
  readGpuQualificationSourceBundle,
  type GpuQualificationSourceIdentity
} from "./gpu-qualification-source-bundle.test-support";

const execFileAsync = promisify(execFile);
const source: GpuQualificationSourceIdentity = Object.freeze({ gitCommit: "a".repeat(40), gitTree: "b".repeat(40), version: "0.2.65", gitDirty: false });
const testScratchRoot = fileURLToPath(new URL("../../../.scratch/", import.meta.url));

describe("GPU points qualification evidence", () => {
  it("requires clean, unchanged source identities before a raw evidence bundle can be written", () => {
    expect(() => assertSameCleanSource(source, { ...source, gitTree: "c".repeat(40) })).toThrow("changed during the native render");
    expect(() => assertSameCleanSource(source, { ...source, gitDirty: true } as never)).toThrow("clean full commit/tree/version identity");
  });

  it("refuses this source/hardware oracle before evidence writes on a non-Windows host", () => {
    expect(() => assertWindowsGpuQualificationHost("linux")).toThrow("requires a native Windows host");
    expect(() => assertWindowsGpuQualificationHost("win32")).not.toThrow();
  });

  it("makes the raw-evidence writer refuse a non-Windows host before reading or writing artifacts", async () => {
    await expect(writeGpuPointsQualificationEvidence({ platform: "linux" } as never)).rejects.toThrow("requires a native Windows host");
  });

  it.skipIf(process.platform === "win32")("does not create an evidence root when its Windows-only runner is refused", async () => {
    const root = await mkdtemp(join(testScratchRoot, "gpu-qualification-non-windows-"));
    const outputRoot = join(root, "evidence");
    try {
      const result = await renderGpuPointsQualificationEvidence({} as never, { sourceDir: root, outputRoot });
      expect(result).toMatchObject({ ok: false, error: { code: "gpu_qualification_source_refused", message: expect.stringContaining("requires a native Windows host") } });
      await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects full source identity and rejects a dirty checkout", async () => {
    const root = await mkdtemp(join(testScratchRoot, "gpu-qualification-source-"));
    const evidenceRoot = await mkdtemp(join(testScratchRoot, "gpu-qualification-source-evidence-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.65" }));
      await git(root, ["init"]);
      await git(root, ["add", "package.json"]);
      await git(root, ["-c", "user.name=Motion Test", "-c", "user.email=motion-test@example.test", "commit", "-m", "fixture"]);
      const identity = await collectGpuQualificationSourceIdentity(root);
      expect(identity).toMatchObject({ gitCommit: expect.stringMatching(/^[a-f0-9]{40}$/), gitTree: expect.stringMatching(/^[a-f0-9]{40}$/), version: "0.2.65", gitDirty: false });
      const outputRoot = await withinTestWorkspace(() => preparePrivateQualificationOutputRoot(evidenceRoot, root));
      const bundle = await createGpuQualificationSourceBundle(root, identity, outputRoot);
      expect(bundle).toMatchObject({ path: "source.bundle", mediaType: "application/vnd.git.bundle", bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), gitCommit: identity.gitCommit, gitTree: identity.gitTree, version: identity.version });
      await expect(git(root, ["bundle", "list-heads", join(evidenceRoot, "source.bundle")])).resolves.toContain(`${identity.gitCommit} HEAD`);
      const rechecked = await readGpuQualificationSourceBundle(identity, outputRoot);
      expect(() => assertSameGpuQualificationSourceBundle(bundle, rechecked)).not.toThrow();
      await writeFile(join(root, "changed.txt"), "dirty\n");
      await expect(collectGpuQualificationSourceIdentity(root)).rejects.toThrow("clean source tree");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("writes immutable, caller-rooted PNG and Motion-receipt bindings without source-tree output", async () => {
    const root = await mkdtemp(join(testScratchRoot, "gpu-qualification-evidence-"));
    const sourceRoot = await mkdtemp(join(testScratchRoot, "gpu-qualification-evidence-source-"));
    try {
      const outputRoot = await withinTestWorkspace(() => preparePrivateQualificationOutputRoot(root, sourceRoot));
      const bundleBytes = Buffer.from("git bundle fixture\n");
      await writeFile(join(root, "source.bundle"), bundleBytes, { flag: "wx" });
      const rgba = Buffer.alloc(96 * 64 * 4);
      for (let pixel = 0; pixel < 128; pixel += 1) {
        const offset = pixel * 4;
        rgba[offset] = pixel < 64 ? 60 : 240;
        rgba[offset + 1] = pixel < 64 ? 180 : 80;
        rgba[offset + 2] = pixel < 64 ? 240 : 60;
        rgba[offset + 3] = 128;
      }
      const png = encodeRgbaPng(96, 64, rgba);
      const pngPath = join(root, "points-preview.png");
      await writeFile(pngPath, png, { flag: "wx" });
      const pngSha256 = createHash("sha256").update(png).digest("hex");
      const result = {
        ok: true as const,
        frame: {
          path: pngPath,
          sha256: pngSha256,
          width: 96,
          height: 64,
          atMs: 500,
          gpu: gpuEvidence(),
          resources: {} as never
        },
        receipt: { schema: "shellx-motion/receipt@1", operation: "preview.gpu.frame", lane: "gpu", status: "passed", createdAt: "2026-08-27T00:00:00.000Z" } as never
      };
      const written = await writeGpuPointsQualificationEvidence({
        outputRoot,
        platform: "win32",
        sourceBefore: source,
        sourceAfter: source,
        sourceBundle: qualificationSourceBundle(bundleBytes),
        session: qualificationSession(bundleBytes),
        browserIdentity: browserIdentity(),
        preview: result,
        generatedAt: "2026-08-27T00:00:00.000Z"
      });
      expect(written.evidence).toMatchObject({
        schema: "shellx-motion/gpu-points-qualification-evidence@2",
        host: { platform: "win32" },
        source: { before: source, after: source },
        session: qualificationSession(bundleBytes),
        browser: { identity: { name: "Chrome", version: "149.0.0.0", userAgent: "test-agent", executableSha256: "c".repeat(64) }, args: ["--enable-gpu"], ignoredDefaultArgs: ["--enable-unsafe-swiftshader"], sandbox: { enabled: true, status: "enabled" } },
        gpu: result.frame.gpu,
        pointsPreview: { artifact: { path: "points-preview.png", mediaType: "image/png", bytes: png.byteLength, sha256: pngSha256 }, png: { width: 96, height: 64, transparentPixels: 96 * 64 - 128, nonTransparentPixels: 128, opaquePixels: 0 } },
        motionPreviewReceipt: { path: "motion-preview.receipt.json", mediaType: "application/json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
      });
      expect(JSON.parse(await readFile(join(root, "motion-preview.receipt.json"), "utf8"))).toEqual(result.receipt);
      await expect(readFile(written.path, "utf8")).resolves.toContain("gpu-points-qualification-evidence@2");
      await expect(writeGpuPointsQualificationEvidence({ outputRoot, platform: "win32", sourceBefore: source, sourceAfter: source, sourceBundle: qualificationSourceBundle(bundleBytes), session: qualificationSession(bundleBytes), browserIdentity: browserIdentity(), preview: result, generatedAt: "2026-08-27T00:00:00.000Z" })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("refuses a missing root inside source without creating a candidate subdirectory", async () => {
    const root = await mkdtemp(join(testScratchRoot, "gpu-qualification-root-"));
    try {
      const missingRoot = join(root, "evidence");
      await expect(preparePrivateQualificationOutputRoot(missingRoot, root)).rejects.toThrow("must already exist");
      await expect(lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a pre-populated private root before native evidence capture", async () => {
    const root = await mkdtemp(join(testScratchRoot, "gpu-qualification-prepopulated-"));
    const sourceRoot = await mkdtemp(join(testScratchRoot, "gpu-qualification-prepopulated-source-"));
    try {
      await writeFile(join(root, "old-artifact.json"), "{}\n");
      await expect(withinTestWorkspace(() => preparePrivateQualificationOutputRoot(root, sourceRoot)))
        .rejects.toThrow("must be empty before");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("retains Core output-root identity and authority through evidence publication", async () => {
    const parent = await mkdtemp(join(testScratchRoot, "gpu-qualification-retained-"));
    const sourceRoot = await mkdtemp(join(testScratchRoot, "gpu-qualification-retained-source-"));
    const outputRoot = join(parent, "evidence");
    const movedRoot = join(parent, "moved-evidence");
    try {
      await mkdir(outputRoot, { mode: 0o700 });
      const retained = await withinTestWorkspace(() => preparePrivateQualificationOutputRoot(outputRoot, sourceRoot));
      await rename(outputRoot, movedRoot);
      await mkdir(outputRoot, { mode: 0o700 });
      await expect(retained.assertCurrent()).rejects.toThrow("changed after Motion captured its identity");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

function browserIdentity() {
  return {
    name: "Chrome",
    version: "149.0.0.0",
    userAgent: "test-agent",
    executableSha256: "c".repeat(64),
    source: "path" as const,
    args: ["--enable-gpu"],
    ignoredDefaultArgs: ["--enable-unsafe-swiftshader"],
    sandbox: { enabled: true as const, status: "enabled" as const }
  };
}

function qualificationSourceBundle(bytes: Buffer) {
  return {
    path: "source.bundle" as const,
    mediaType: "application/vnd.git.bundle" as const,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitCommit: source.gitCommit,
    gitTree: source.gitTree,
    version: source.version
  };
}

function qualificationSession(bytes: Buffer) {
  return {
    schema: GPU_POINTS_QUALIFICATION_SESSION_SCHEMA,
    id: "0b6d97b9-1f28-45bd-af1d-f64bf70c6a1a",
    sourceBundle: qualificationSourceBundle(bytes)
  };
}

function gpuEvidence() {
  return {
    schema: "shellx-motion/gpu-runtime-evidence@1" as const,
    backend: "webgpu-browser" as const,
    browserSource: "path",
    webgpuFeatureStatus: "enabled",
    adapterFingerprint: "d".repeat(64),
    adapter: { cdpVendorId: 1, cdpDeviceId: 2, cdpVendor: "NVIDIA", cdpDevice: "RTX", vendor: "NVIDIA", device: "RTX", architecture: null, description: null },
    limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_000_000, maxStorageBufferBindingSize: 1_000_000 }
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function withinTestWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(testScratchRoot), operation);
}
