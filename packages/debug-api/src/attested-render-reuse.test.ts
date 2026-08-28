import { appendFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256, deriveAttestedRenderPackageFingerprint, encodeRgbaPng, hashBuffer, loadStableRenderPackage, packageRenderLineageInputHashes, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import type { MotionDebugContext } from "./index";
import { createEphemeralAttestedRenderReuseProducerAuthority, dispatchDebugCommand as dispatchDebugCommandUnsafe } from "./index";
import { executeWithAttestedRenderReuse } from "./domains/attested-render-reuse";
import { dispatchRenderFinalCommand } from "./domains/render-final";
import { MOTION_ENGINE_VERSION } from "./version";

const tempRoots: string[] = [];
const PNG = encodeRgbaPng(1, 1, Buffer.from([255, 0, 0, 255]));
const producerAuthority = createEphemeralAttestedRenderReuseProducerAuthority();

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

/**
 * Final rendering retains a POSIX workspace anchor through output publication.
 * Keep this suite's host-owned test root explicit rather than relying on the
 * process temp directory, whose ancestors are not necessarily owned by this
 * test principal on WSL.
 */
async function dispatchDebugCommand(...input: Parameters<typeof dispatchDebugCommandUnsafe>) {
  const workspaceAuthority = await createTrustedWorkspaceAnchor(resolve("../.."));
  return await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await dispatchDebugCommandUnsafe(...input));
}

describe("motion.render.final attested reuse", () => {
  it("stores a v2 artifact on the first render and reuses it without a browser producer on the second", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    let browserCalls = 0;
    const context = { ...browserContext(() => { browserCalls += 1; }), scratchRoot: root };

    const first = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, context);
    expect(first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    expect(browserCalls).toBe(1);

    const second = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", atMs: 0, reuseAttested: true
    }, browserContext(() => { throw new Error("a verified hit must not start a current browser/tool probe"); }));
    expect(second).toMatchObject({
      ok: true,
      result: {
        lane: "attested-reuse",
        reuseAttested: { status: "hit" },
        receipt: { operation: "render.reuse", lane: "attested-reuse" },
        sourceRender: { lane: "image" }
      }
    });
    expect(browserCalls).toBe(1);
  });

  it("fails closed instead of overwriting an output that has no matching descriptor", async () => {
    const root = await scratch();
    const outputPath = join(root, "existing.png");
    await writeFile(outputPath, PNG);
    let browserCalls = 0;
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, { ...browserContext(() => { browserCalls += 1; }), scratchRoot: root });

    expect(result).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(0);
    expect(await readFile(outputPath)).toEqual(PNG);
  });

  it("fails closed on a tampered descriptor without starting a renderer", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    let browserCalls = 0;
    const context = browserContext(() => { browserCalls += 1; });
    const first = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, context);
    expect(first.ok).toBe(true);
    const descriptorDir = join(root, ".shellx-motion", "render-reuse", "v2");
    const [descriptor] = (await readdir(descriptorDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".producer.json"));
    await writeFile(join(descriptorDir, descriptor!), "{}\n");

    const second = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, context);
    expect(second).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(1);
  });

  it("refuses a self-consistent public entry when its host producer proof is absent", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    let browserCalls = 0;
    const context = browserContext(() => { browserCalls += 1; });
    const request = {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true,
    } as const;
    const first = await dispatchDebugCommand("motion.render.final", request, context);
    expect(first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    const descriptorDir = join(root, ".shellx-motion", "render-reuse", "v2");
    const [producerProof] = (await readdir(descriptorDir)).filter((name) => name.endsWith(".producer.json"));
    await rm(join(descriptorDir, producerProof!));

    const second = await dispatchDebugCommand("motion.render.final", request, context);
    expect(second).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(1);
  });

  it("refuses a public entry under a different host producer authority", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    let browserCalls = 0;
    const request = {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true,
    } as const;
    const first = await dispatchDebugCommand("motion.render.final", request, browserContext(() => { browserCalls += 1; }));
    expect(first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });

    const second = await dispatchDebugCommand("motion.render.final", request, {
      ...browserContext(() => { browserCalls += 1; }),
      attestedRenderReuseProducerAuthority: createEphemeralAttestedRenderReuseProducerAuthority(),
    });
    expect(second).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(1);
  });

  it("keeps a host-written source receipt eligible for attested reuse", async () => {
    const result = await directReuseWithSourceReceiptWriter(false);

    expect(result.first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    expect(result.second).toMatchObject({ ok: true, result: { reuseAttested: { status: "hit" } } });
    expect(result.producerCalls()).toBe(1);
  });

  it("refuses a co-writer's substituted self-consistent output and source receipt before producer-proof issuance", async () => {
    const result = await directReuseWithSourceReceiptWriter(true);

    expect(result.first).toMatchObject({
      ok: false,
      error: { code: "cache_integrity_failed", message: expect.stringContaining("host-persisted source render receipt changed") }
    });
    expect(result.producerCalls()).toBe(1);
    await expect(hasJsonDescriptor(result.root)).resolves.toBe(false);
    await expect(hasProducerProof(result.root)).resolves.toBe(false);
  });

  it("returns cache_busy without starting a renderer when an exact fill lock already exists", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    const packageRoot = resolve("../../fixtures/packages/lower-third");
    const lockPath = await exactLockPath(packageRoot, outputPath);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "host inspection required\n", "utf8");
    let browserCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath, preset: "png-frame", reuseAttested: true
    }, browserContext(() => { browserCalls += 1; }));

    expect(result).toMatchObject({ ok: false, error: { code: "cache_busy" } });
    expect(browserCalls).toBe(0);
    await expect(readFile(lockPath, "utf8")).resolves.toContain("host inspection");
  });

  it("does not publish a descriptor after a cancelled producer failure", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    let browserCalls = 0;
    const context: MotionDebugContext = {
      tier: "render_motion",
      attestedRenderReuseProducerAuthority: producerAuthority,
      browserFrameRenderer: async () => {
        browserCalls += 1;
        throw new Error("cancelled before a frame was produced");
      }
    };

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, context);

    expect(result).toMatchObject({ ok: false });
    expect(browserCalls).toBe(1);
    await expect(hasJsonDescriptor(root)).resolves.toBe(false);
    expect(await pathExists(join(root, ".shellx-motion", "render-reuse", "v2"))).toBe(true);
  });

  it("does not publish a descriptor after a quality-gated miss fails", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    const qualityManifestPath = join(root, "quality.json");
    await writeFile(qualityManifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "must-fail", atMs: 0, minBrightPixels: 999 }]
    }), "utf8");
    let browserCalls = 0;
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true, qualityManifestPath
    }, { ...browserContext(() => { browserCalls += 1; }), scratchRoot: root });

    expect(result).toMatchObject({ ok: false });
    expect(browserCalls).toBe(1);
    await expect(hasJsonDescriptor(root)).resolves.toBe(false);
  });

  it("binds every bounded root-contained quality baseline so a baseline mutation becomes a cache miss", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    const qualityRoot = join(root, "quality-inputs");
    const baselinePath = join(qualityRoot, "baseline.png");
    const qualityManifestPath = join(qualityRoot, "quality.json");
    await mkdir(qualityRoot, { recursive: true, mode: 0o700 });
    await writeFile(baselinePath, PNG);
    await writeFile(qualityManifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "baseline", atMs: 0, baseline: "baseline.png" }]
    }), "utf8");
    let browserCalls = 0;
    const context = { ...browserContext(() => { browserCalls += 1; }), scratchRoot: root };
    const request = {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true, qualityManifestPath
    };

    const first = await dispatchDebugCommand("motion.render.final", request, context);
    expect(first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    // The decoder intentionally stops at IEND, so this changes attested source bytes while
    // preserving the visual baseline and allows the second normal quality gate to pass.
    await writeFile(baselinePath, Buffer.concat([PNG, Buffer.from([0])]));
    await rm(outputPath);

    const second = await dispatchDebugCommand("motion.render.final", request, context);
    expect(second).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    expect(browserCalls).toBe(2);
  });

  it.each(["missing", "symlinked", "oversize", "escaping"] as const)("refuses a %s quality baseline before lookup or rendering", async (kind) => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    const qualityRoot = join(root, "quality-inputs");
    const baselinePath = join(qualityRoot, "baseline.png");
    const qualityManifestPath = join(qualityRoot, "quality.json");
    await mkdir(qualityRoot, { recursive: true });
    await writeFile(qualityManifestPath, JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "baseline", atMs: 0, baseline: kind === "escaping" ? "../outside.png" : "baseline.png" }]
    }), "utf8");
    if (kind === "symlinked") {
      const outside = await scratch();
      const externalBaseline = join(outside, "baseline.png");
      await writeFile(externalBaseline, PNG);
      await symlink(externalBaseline, baselinePath, "file");
    } else if (kind === "oversize") {
      await writeFile(baselinePath, Buffer.alloc(4 * 1024 * 1024 + 1));
    } else if (kind === "escaping") {
      await writeFile(join(root, "outside.png"), PNG);
    }
    let browserCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true, qualityManifestPath
    }, { ...browserContext(() => { browserCalls += 1; }), scratchRoot: root });

    expect(result).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(0);
    await expect(hasJsonDescriptor(root)).resolves.toBe(false);
  });

  it("uses a new key after current package-source bytes change instead of accepting the old entry", async () => {
    const root = await scratch();
    const packageRoot = join(root, "package");
    const outputRoot = await scratch();
    await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
    const outputPath = join(outputRoot, "frame.png");
    let browserCalls = 0;
    const context = browserContext(() => { browserCalls += 1; });
    const first = await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath, preset: "png-frame", reuseAttested: true
    }, context);
    expect(first).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    await appendFile(join(packageRoot, "expected-preview.json"), "\n", "utf8");
    await rm(outputPath);

    const second = await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath, preset: "png-frame", reuseAttested: true
    }, context);

    expect(second).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    expect(browserCalls).toBe(2);
  });

  it("does not create an external receipts root or renderer work for an escaped root", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    const escapedReceiptsRoot = join(dirname(root), `${root.split("/").at(-1)!}-escaped-receipts`);
    let browserCalls = 0;
    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true,
      receiptsRoot: escapedReceiptsRoot
    }, browserContext(() => { browserCalls += 1; }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(browserCalls).toBe(0);
    await expect(pathExists(escapedReceiptsRoot)).resolves.toBe(false);
  });

  it("refuses an output root inside the package before creating it or starting a renderer", async () => {
    const root = await scratch();
    const packageRoot = join(root, "package");
    await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
    const outputDirectory = join(packageRoot, "must-not-create");
    let browserCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath: join(outputDirectory, "frame.png"), preset: "png-frame", reuseAttested: true
    }, browserContext(() => { browserCalls += 1; }));

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(browserCalls).toBe(0);
    await expect(pathExists(outputDirectory)).resolves.toBe(false);
  });

  it("refuses a symlinked output root before writing through it", async () => {
    const root = await scratch();
    const outside = await scratch();
    const linkedOutputRoot = join(root, "linked-output");
    await symlink(outside, linkedOutputRoot, "dir");
    let browserCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath: join(linkedOutputRoot, "frame.png"), preset: "png-frame", reuseAttested: true
    }, browserContext(() => { browserCalls += 1; }));

    expect(result).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(0);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("refuses a symlinked cache/receipt ancestor without creating work outside the output root", async () => {
    const root = await scratch();
    const outside = await scratch();
    const outputPath = join(root, "frame.png");
    await symlink(outside, join(root, ".shellx-motion"), "dir");
    let browserCalls = 0;

    const result = await dispatchDebugCommand("motion.render.final", {
      packageRoot: resolve("../../fixtures/packages/lower-third"), outputPath, preset: "png-frame", reuseAttested: true
    }, browserContext(() => { browserCalls += 1; }));

    expect(result).toMatchObject({ ok: false, error: { code: "cache_integrity_failed" } });
    expect(browserCalls).toBe(0);
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("keeps the opt-in flag data-only in the direct final-render parser", async () => {
    let getterRead = false;
    const args: Record<string, unknown> = { packageRoot: "/trusted/package", outputPath: "/trusted/final.mp4" };
    Object.defineProperty(args, "reuseAttested", {
      enumerable: true,
      get() {
        getterRead = true;
        return true;
      }
    });
    const result = await dispatchRenderFinalCommand("motion.render.final", args, {
      executeFfmpegFinalRender: async (request) => {
        expect(request.reuseAttested).toBe(false);
        return { ok: true, result: { ok: true }, warnings: [] };
      }
    });
    expect(result).toMatchObject({ ok: true });
    expect(getterRead).toBe(false);
  });

  it.each([
    { dryRun: true },
    { keepFrames: true, preset: "mp4-h264" },
    { preset: "png-sequence" }
  ])("refuses unsupported reuse selector %o before an executor runs", async (extra) => {
    let executorCalls = 0;
    const result = await dispatchRenderFinalCommand("motion.render.final", {
      packageRoot: "/trusted/package", outputPath: "/trusted/output", reuseAttested: true, ...extra
    }, {
      executeStillFinalRender: async () => { executorCalls += 1; return { ok: true, warnings: [] }; },
      executeSequenceFinalRender: async () => { executorCalls += 1; return { ok: true, warnings: [] }; },
      executeFfmpegFinalRender: async () => { executorCalls += 1; return { ok: true, warnings: [] }; }
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(executorCalls).toBe(0);
  });
});

function browserContext(onCall: () => void): MotionDebugContext {
  return {
    tier: "render_motion",
    attestedRenderReuseProducerAuthority: producerAuthority,
    browserFrameRenderer: async (pkg, options) => {
      onCall();
      const path = options.outputPath ?? join(options.outDir, "frame.png");
      await writeFile(path, PNG);
      const output = {
        path,
        sha256: hashBuffer(PNG),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "reuse-test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      };
      return {
        ok: true as const,
        output,
        receipt: {
          schema: "shellx-motion/receipt@1",
          id: `preview-${options.atMs}`,
          operation: "preview.frame",
          status: "passed" as const,
          packageId: pkg.manifest.id,
          inputHashes: { motion: "a".repeat(64) },
          createdAt: "2026-08-09T00:00:00.000Z",
          lane: "browser",
          output,
          warnings: []
        }
      };
    }
  };
}

async function exactLockPath(packageRoot: string, outputPath: string): Promise<string> {
  const inputs = {
    schema: "shellx-motion/attested-render-inputs@2" as const,
    packageSha256: await deriveAttestedRenderPackageFingerprint(packageRoot)
  };
  const plan = {
    schema: "shellx-motion/attested-render-plan@2" as const,
    outputRootRelativePath: "frame.png",
    preset: "png-frame",
    frameLane: "browser" as const,
    engineVersion: MOTION_ENGINE_VERSION,
    atMs: 0,
    workflow: "none" as const,
    qualityManifest: false
  };
  const key = canonicalJsonSha256({ schema: "shellx-motion/attested-render-reuse@2", plan, inputs });
  return join(dirname(outputPath), ".shellx-motion", "render-reuse", "v2", `${key}.lock`);
}

async function hasJsonDescriptor(root: string): Promise<boolean> {
  const directory = join(root, ".shellx-motion", "render-reuse", "v2");
  try {
    return (await readdir(directory)).some((entry) => entry.endsWith(".json") && !entry.endsWith(".producer.json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function hasProducerProof(root: string): Promise<boolean> {
  const directory = join(root, ".shellx-motion", "render-reuse", "v2");
  try {
    return (await readdir(directory)).some((entry) => entry.endsWith(".producer.json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}

async function directReuseWithSourceReceiptWriter(coWriterSubstitutes: boolean): Promise<{
  root: string;
  first: Awaited<ReturnType<typeof executeWithAttestedRenderReuse>>;
  second: Awaited<ReturnType<typeof executeWithAttestedRenderReuse>> | undefined;
  producerCalls: () => number;
}> {
  const workspace = await scratch();
  const root = join(workspace, "output");
  await mkdir(root, { mode: 0o700 });
  const outputPath = join(root, "frame.png");
  const packageRoot = join(workspace, "package");
  await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
  const workspaceAuthority = await createTrustedWorkspaceAnchor(workspace);
  const { pkg, lineage } = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await loadStableRenderPackage(packageRoot));
  const sourceReceiptPath = join(root, ".shellx-motion", "receipts", "render-source.receipt.json");
  const legitimate = PNG;
  const substituted = encodeRgbaPng(1, 1, Buffer.from([0, 0, 255, 255]));
  let producerCalls = 0;

  const execute = async () => {
    producerCalls += 1;
    await writeFile(outputPath, legitimate);
    return {
      ok: true as const,
      result: {
        receipt: {
          schema: "shellx-motion/receipt@1" as const,
          id: "render-source",
          operation: "render.final",
          status: "passed" as const,
          packageId: pkg.manifest.id,
          inputHashes: packageRenderLineageInputHashes(lineage),
          createdAt: "2026-08-26T00:00:00.000Z",
          lane: "image",
          output: { path: outputPath, sha256: hashBuffer(legitimate), preset: "png-frame" },
          warnings: []
        },
        receiptPath: sourceReceiptPath
      },
      warnings: []
    };
  };
  const services = {
    engineVersion: MOTION_ENGINE_VERSION,
    producerAuthority,
    staticAdmission: async () => null,
    execute,
    writeReceipt: async (receiptsRoot: string, receipt: OperationReceipt) => {
      const receiptPath = join(receiptsRoot, `${String(receipt.id)}.receipt.json`);
      await mkdir(receiptsRoot, { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      if (coWriterSubstitutes && receipt.id === "render-source") {
        await writeFile(outputPath, substituted);
        const forged = structuredClone(receipt) as OperationReceipt & { output: Record<string, unknown> };
        forged.output = { ...forged.output, sha256: hashBuffer(substituted) };
        await writeFile(receiptPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
      }
      return receiptPath;
    }
  };
  const request = {
    packageRoot,
    outputPath,
    frameLane: "browser" as const,
    preset: "png-frame" as const,
    dryRun: false,
    reuseAttested: true
  };
  const first = await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await executeWithAttestedRenderReuse(request, services));
  const second = first.ok && !coWriterSubstitutes
    ? await withTrustedWorkspaceAnchor(workspaceAuthority, async () => await executeWithAttestedRenderReuse(request, { ...services, execute: async () => { throw new Error("verified reuse must not execute a fresh producer"); } }))
    : undefined;
  return { root, first, second, producerCalls: () => producerCalls };
}

async function scratch(): Promise<string> {
  const base = resolve("../../.scratch/attested-reuse-tests");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "case-"));
  tempRoots.push(root);
  return root;
}
