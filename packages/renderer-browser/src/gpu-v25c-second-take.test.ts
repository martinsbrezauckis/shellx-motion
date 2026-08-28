import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSchema, validateDocument, validateMotionDocumentInStages, type MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "./effect-module-registry.js";
import { resolveGpuEffectModuleStaticPlanForUse } from "./gpu-effect-module-use-authority.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../../fixtures/packages/gpu-v25c-second-take", import.meta.url));
const GENERATOR = fileURLToPath(new URL("../../../templates/generators/second-take/generate.py", import.meta.url));
const INSTALL_MANIFEST = fileURLToPath(new URL("../../../templates/generators/second-take/effect-module-manifest.json", import.meta.url));
const hasImplementationGenerator = existsSync(GENERATOR) && existsSync(INSTALL_MANIFEST);
const runFile = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

/**
 * C3 source admission only. It intentionally invokes no Browser runtime, GPU,
 * preview, final render, receipt, or native-host surface; C4 owns those claims.
 */
describe("Second Take V25-C3 source fixture", () => {
  it.runIf(hasImplementationGenerator)("keeps generator parity and resolves its one installed afterimage descriptor while the scratch baseline resolves none", async () => {
    const generated = await generateScratchPackages();
    const fixture = await readPackage(FIXTURE_ROOT);
    const moduleOn = await readPackage(generated.moduleOn);
    const moduleOff = await readPackage(generated.moduleOff);

    // `generate.py` validates recipe hashes before writing. Byte equality proves
    // the committed package has not drifted from that source of truth.
    await expectGeneratedParity(FIXTURE_ROOT, generated.moduleOn);
    expect(await validateDocument(await loadSchema("packageManifest"), fixture.manifest)).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(fixture.motion)).toMatchObject({ ok: true });
    expect(fixture.motion).toMatchObject({ durationMs: 8_000, fps: 30, width: 1_080, height: 1_920 });
    expect(fixture.manifest.assets).toEqual([
      "assets/second-take-subject.svg",
      "assets/second-take-copy.svg"
    ]);
    expect(fixture.motion.layers.filter((layer) => layer.type === "text" || layer.type === "caption")).toHaveLength(0);
    const [subjectSvg, copySvg] = await Promise.all([
      readFile(join(FIXTURE_ROOT, "assets/second-take-subject.svg"), "utf8"),
      readFile(join(FIXTURE_ROOT, "assets/second-take-copy.svg"), "utf8")
    ]);
    expect(copySvg).not.toMatch(/<text|font|script|foreignObject|<image|href="https?:\/\/|url\(http/i);
    expect(subjectSvg).toMatch(/^<svg[^>]*width="720"[^>]*height="1080"[^>]*viewBox="0 0 720 1080"/);
    expect(copySvg).toMatch(/^<svg[^>]*width="1080"[^>]*height="1920"[^>]*viewBox="0 0 1080 1920"/);

    const authority = await installedAuthority();
    // This goes through the current Browser authority, which supplies its
    // checked-in renderer identity only after the real installed registry lists
    // a current entry. It is a static preflight, not a renderer invocation.
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(moduleOn.motion, authority);
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) throw new Error(resolved.failure.message);
    expect(resolved.plan.effectModules).toHaveLength(1);
    expect(resolved.plan.effectModules?.[0]).toMatchObject({
      layerId: "subject-afterimage",
      scopeGroupId: "subject-stage",
      moduleId: "motion.afterimage-stack",
      version: "1.0.0",
      intrinsic: "motion.afterimage-stack.v1",
      rendererAbi: "shellx-motion/gpu-effect-module@1"
    });
    expect(resolved.plan.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "image", assetRef: "assets/second-take-subject.svg" }),
      expect.objectContaining({ kind: "image", assetRef: "assets/second-take-copy.svg" })
    ]));
    expect(resolved.plan.resources.some((resource) => resource.kind === "font")).toBe(false);

    expect(await validateMotionDocumentInStages(moduleOff.motion)).toMatchObject({ ok: true });
    const baseline = await resolveGpuEffectModuleStaticPlanForUse(moduleOff.motion, authority);
    expect(baseline).toMatchObject({ ok: true });
    if (!baseline.ok) throw new Error(baseline.failure.message);
    expect(baseline.plan).not.toHaveProperty("effectModules");
  });
});

async function generateScratchPackages(): Promise<{ moduleOn: string; moduleOff: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-v25c-second-take-"));
  roots.push(root);
  const moduleOn = join(root, "module-on");
  const moduleOff = join(root, "module-off");
  await runFile("python3", [GENERATOR, "--out", moduleOn]);
  await runFile("python3", [GENERATOR, "--variant", "module-off", "--out", moduleOff]);
  return { moduleOn, moduleOff };
}

async function expectGeneratedParity(expectedRoot: string, actualRoot: string): Promise<void> {
  for (const path of ["manifest.json", "motion.json", "assets/second-take-subject.svg", "assets/second-take-copy.svg"]) {
    await expect(readFile(join(actualRoot, path)), path).resolves.toEqual(await readFile(join(expectedRoot, path)));
  }
}

async function readPackage(root: string): Promise<MotionPackage> {
  const [manifest, motion] = await Promise.all([
    readJson(join(root, "manifest.json")),
    readJson(join(root, "motion.json"))
  ]);
  return { root, manifest: manifest as MotionPackage["manifest"], motion: motion as MotionPackage["motion"] };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function installedAuthority() {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-v25c-registry-"));
  roots.push(root);
  const stateRoot = join(root, "effect-modules");
  await mkdir(stateRoot, { mode: 0o700 });
  const registry = createEffectModuleRegistryAuthority({
    stateRoot,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    readManifestFileForTest: async (path) => {
      const bytes = await readFile(path);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    }
  });
  const pending = await registry.prepareInstallFromManifestFile(INSTALL_MANIFEST);
  await registry.confirmInstall(pending.confirmationId);
  return createEffectModuleRegistryUseAuthority(registry);
}
