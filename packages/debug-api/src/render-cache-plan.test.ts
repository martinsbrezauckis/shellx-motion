import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, encodeRgbaPng, hashBuffer } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionDebugContext } from "./index.js";
import { createEphemeralAttestedRenderReuseProducerAuthority, dispatchDebugCommand } from "./index.js";
import {
  MAX_RENDER_CACHE_PLAN_BYTES,
  dispatchRenderCachePlanCommand,
  projectRenderCachePlan,
  type RenderCachePlanResult,
} from "./domains/render-cache-plan.js";
import { deriveAttestedRenderReuseIdentity } from "./domains/attested-render-reuse-identity.js";
import { MOTION_ENGINE_VERSION } from "./version.js";

const tempRoots: string[] = [];
const PNG = encodeRgbaPng(1, 1, Buffer.from([255, 0, 0, 255]));
const packageRoot = resolve("../../fixtures/packages/lower-third");
const producerAuthority = createEphemeralAttestedRenderReuseProducerAuthority();

afterEach(async () => await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("motion.render.cache.plan", () => {
  it("reports an unmaterialized-root miss without creating an output root, reuse directory, lock, or receipt", async () => {
    const parent = await scratch();
    const outputPath = join(parent, "not-created", "frame.png");

    const result = await dispatchDebugCommand("motion.render.cache.plan", { packageRoot, outputPath, preset: "png-frame" }, { tier: "render_motion", attestedRenderReuseProducerAuthority: producerAuthority });

    expect(result).toMatchObject({ ok: true, result: { decision: { kind: "miss", reason: "output_root_unmaterialized" }, authorization: "none" } });
    await expect(pathExists(join(parent, "not-created"))).resolves.toBe(false);
    await expect(pathExists(join(parent, ".shellx-motion"))).resolves.toBe(false);
  });

  it("returns a path-free verified hit without starting a renderer or changing the v2 reuse directory", async () => {
    const outputRoot = await scratch();
    const outputPath = join(outputRoot, "frame.png");
    let browserCalls = 0;
    const stored = await dispatchDebugCommand("motion.render.final", {
      packageRoot, outputPath, preset: "png-frame", reuseAttested: true,
    }, browserContext(() => { browserCalls += 1; }));
    expect(stored).toMatchObject({ ok: true, result: { reuseAttested: { status: "stored" } } });
    const reuseDirectory = join(outputRoot, ".shellx-motion", "render-reuse", "v2");
    const before = await readdir(reuseDirectory);

    const unauthenticated = await dispatchDebugCommand(
      "motion.render.cache.plan",
      { packageRoot, outputPath, preset: "png-frame" },
      { tier: "render_motion" },
    );
    expect(unauthenticated).toMatchObject({ ok: true, result: {
      decision: { kind: "refused", reason: "producer_authority_unavailable" },
    } });

    const result = await dispatchDebugCommand("motion.render.cache.plan", { packageRoot, outputPath, preset: "png-frame" }, { tier: "render_motion", attestedRenderReuseProducerAuthority: producerAuthority });

    expect(result).toMatchObject({ ok: true, result: {
      decision: { kind: "hit", reason: "verified_attested_entry" },
      source: { receipt: { role: "render", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, artifact: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    } });
    expect(browserCalls).toBe(1);
    expect(await readdir(reuseDirectory)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(outputRoot);
  });

  it("refuses existing output and busy fill states instead of calling either a miss", async () => {
    const root = await scratch();
    const outputPath = join(root, "frame.png");
    await writeFile(outputPath, PNG);
    const existing = await dispatchDebugCommand("motion.render.cache.plan", { packageRoot, outputPath, preset: "png-frame" }, { tier: "render_motion", attestedRenderReuseProducerAuthority: producerAuthority });
    expect(existing).toMatchObject({ ok: true, result: { decision: { kind: "refused", reason: "output_exists_without_entry" } } });
    await rm(outputPath);
    const identity = await deriveAttestedRenderReuseIdentity({
      request: { packageRoot, outputPath, preset: "png-frame", frameLane: "browser" },
      packageRoot: await realpath(packageRoot), outputRootRelativePath: "frame.png", engineVersion: MOTION_ENGINE_VERSION,
    });
    await mkdir(join(root, ".shellx-motion", "render-reuse", "v2"), { recursive: true });
    await writeFile(join(root, ".shellx-motion", "render-reuse", "v2", `${identity.cacheKey}.lock`), "busy\n");
    const busy = await dispatchDebugCommand("motion.render.cache.plan", { packageRoot, outputPath, preset: "png-frame" }, { tier: "render_motion", attestedRenderReuseProducerAuthority: producerAuthority });
    expect(busy).toMatchObject({ ok: true, result: { decision: { kind: "refused", reason: "fill_busy" } } });
  });

  it("rejects inherited, accessor, and unknown request data without reading a getter", async () => {
    let getterRead = false;
    const args = Object.create({ outputPath: "/inherited/frame.png" }) as Record<string, unknown>;
    Object.defineProperty(args, "packageRoot", { enumerable: true, value: packageRoot });
    Object.defineProperty(args, "preset", { enumerable: true, get() { getterRead = true; return "png-frame"; } });
    const accessor = await dispatchRenderCachePlanCommand("motion.render.cache.plan", args, {});
    const unknown = await dispatchRenderCachePlanCommand("motion.render.cache.plan", { packageRoot, outputPath: "/tmp/frame.png", unexpected: true }, {});
    const oversized = await dispatchRenderCachePlanCommand("motion.render.cache.plan", {
      packageRoot, outputPath: "😀".repeat(1_025), preset: "png-frame", atMs: Number.MAX_SAFE_INTEGER + 1,
    }, {});

    expect(accessor).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(oversized).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(getterRead).toBe(false);
  });

  it("refuses GPU because post-render identity is evidence only", async () => {
    const result = await dispatchRenderCachePlanCommand("motion.render.cache.plan", {
      packageRoot, outputPath: "/tmp/gpu-final.mp4", frameLane: "gpu",
    }, {});

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("keeps v2 digest independent of observedAt and fails closed below the fixed response budget", async () => {
    const root = await scratch();
    const args = { packageRoot, outputPath: join(root, "frame.png"), preset: "png-frame" };
    const first = await dispatchRenderCachePlanCommand("motion.render.cache.plan", args, { now: () => new Date("2026-08-09T00:00:00.000Z") });
    const second = await dispatchRenderCachePlanCommand("motion.render.cache.plan", args, { now: () => new Date("2026-08-09T00:00:01.000Z") });
    expect(first?.ok && second?.ok).toBe(true);
    if (!first || !second || !first.ok || !second.ok) throw new Error("expected bounded plan observations");
    const firstPlan = first.result as RenderCachePlanResult;
    const secondPlan = second.result as RenderCachePlanResult;
    expect(firstPlan.observedAt).not.toBe(secondPlan.observedAt);
    expect(firstPlan.identity?.digest).toBe(secondPlan.identity?.digest);

    const publicProjection = projectRenderCachePlan(firstPlan.observedAt, firstPlan.decision, firstPlan.checked, firstPlan.identity);
    expect(publicProjection).toMatchObject({ ok: true });
    if (publicProjection.ok) expect(Buffer.byteLength(canonicalJson(publicProjection.result), "utf8")).toBeLessThanOrEqual(MAX_RENDER_CACHE_PLAN_BYTES);
    const forcedOverflow = projectRenderCachePlan(firstPlan.observedAt, firstPlan.decision, firstPlan.checked, firstPlan.identity, undefined, 16);
    expect(forcedOverflow).toMatchObject({ ok: false, error: { code: "cache_plan_too_large" } });
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-cache-plan-"));
  tempRoots.push(root);
  return root;
}

function browserContext(onCall: () => void): MotionDebugContext {
  return {
    tier: "render_motion",
    attestedRenderReuseProducerAuthority: producerAuthority,
    browserFrameRenderer: async (pkg, options) => {
      onCall();
      const path = options.outputPath ?? join(options.outDir, "frame.png");
      await writeFile(path, PNG);
      const output = {
        path, sha256: hashBuffer(PNG), format: "png" as const, width: pkg.motion.width, height: pkg.motion.height,
        atMs: options.atMs, browser: { name: "chromium", version: "cache-plan-test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
      };
      return { ok: true as const, output, receipt: {
        schema: "shellx-motion/receipt@1", id: `preview-${options.atMs}`, operation: "preview.frame", status: "passed" as const,
        packageId: pkg.manifest.id, inputHashes: { motion: "a".repeat(64) }, createdAt: "2026-08-09T00:00:00.000Z",
        lane: "browser", output, warnings: [],
      } };
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
}
