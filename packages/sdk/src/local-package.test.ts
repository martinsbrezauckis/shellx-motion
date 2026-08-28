import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadedPackageInputHashes, loadMotionPackage } from "@shellx-motion/core";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { createLocalMotionSdk } from "./local.js";
import { localPackageIdentity } from "./local-package-identity.js";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support.js";

const roots: string[] = [];

/**
 * The version this package is published as, read from its own manifest rather than repeated as a
 * literal. The capability contract must report exactly this — a hardcoded `sdkVersion` is what
 * previously made the in-process SDK claim `0.0.0` while the CLI claimed `0.1.0`.
 */
async function manifestVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

describe("local Motion SDK package operations", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes an explicit versioned local capability contract", async () => {
    const capabilities = await createLocalMotionSdk().capabilities();
    expect(capabilities).toEqual({
      schema: "shellx-motion/local-sdk-capabilities@1",
      contractVersion: 1,
      sdkVersion: await manifestVersion(),
      colorAlpha: {
        schema: "shellx-motion/color-alpha@1",
        status: "current-observable",
        authoredColors: {
          encoding: "sdr-srgb-encoded",
          syntax: "motion-css-subset",
          unsupportedSyntax: "wide-gamut-and-hdr-color-functions-refused"
        },
        unprofiledRaster: {
          assumption: "sdr-srgb-encoded",
          embeddedProfiles: "unsupported-undefined"
        },
        unsupported: [
          "hdr",
          "wide-gamut",
          "icc-profile-conversion",
          "ocio",
          "user-selectable-working-space"
        ],
        lanes: {
          native: expect.objectContaining({
            alphaBoundary: "straight-rgba-png",
            filterDomain: "temporary-premultiplied-encoded-srgb",
            blendDomain: "encoded-srgb"
          }),
          browser: expect.objectContaining({
            alphaBoundary: "browser-managed-before-png-capture",
            filterDomain: "chromium-managed",
            blendDomain: "chromium-managed"
          }),
          gpu: expect.objectContaining({
            alphaBoundary: "straight-rgba-stream",
            filterDomain: "premultiplied-encoded-srgb",
            blendDomain: "premultiplied-encoded-srgb"
          }),
          ffmpeg: expect.objectContaining({
            delivery: {
              profile: "sdr-bt709",
              conversion: "rgb-full-to-yuv-limited",
              readback: "ffprobe-observed-tags"
            }
          })
        }
      },
      operations: expect.arrayContaining([
        "trackingRequest", "trackingInspect", "trackingApply", "trackingDetach", "trackingVerify",
        "keyingInspect", "rotoUpsert", "compositingInspect", "gltfImport", "proceduralInspect",
      ]),
    });
    expect(new Set(capabilities.operations).size).toBe(capabilities.operations.length);
  });

  it("validates real packages and atomically compiles inline scripted video", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-local-compile-"));
    roots.push(root);
    const sdk = createLocalMotionSdk(withTestAuthoringRoots({}, { outputRoots: [root] }));
    const validated = await sdk.validate({ packageRoot: resolve("../../fixtures/packages/editable-lower-third") });
    expect(validated).toMatchObject({
      ok: true,
      output: {
        package: {
          packageId: "pkg_editable_lower_third",
          motionId: "motion_editable_lower_third",
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        template: { schema: "shellx-motion/template-parameters@1", templateId: "template_editable_lower_third" },
      },
    });

    const packageRoot = join(root, "compiled");
    const compiled = await sdk.compile({ script: scriptedVideo(), outDir: packageRoot, createdAt: "2026-07-12T00:00:00.000Z" });
    expect(compiled).toMatchObject({
      ok: true,
      output: {
        packageRoot,
        package: { packageId: "pkg_script_sdk_local", motionId: "motion_script_sdk_local" },
        receiptPath: join(packageRoot, "receipts", "script-compile.receipt.json"),
      },
    });
    await expect(readFile(join(packageRoot, "manifest.json"), "utf8")).resolves.toContain("pkg_script_sdk_local");
    const repeated = await sdk.compile({ script: scriptedVideo(), outDir: packageRoot });
    expect(repeated).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: expect.stringMatching(/already exists|not empty/i) } });
  });

  it("enforces configured authoring output roots for SDK compilation, including symbolic-link escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-compile-output-root-"));
    const approvedRoot = join(root, "approved");
    const outsideRoot = join(root, "outside");
    roots.push(root);
    await Promise.all([mkdir(approvedRoot, { mode: 0o700 }), mkdir(outsideRoot)]);
    const sdk = createLocalMotionSdk({ authoringOutputRoots: [approvedRoot] });

    const outside = await sdk.compile({ script: scriptedVideo(), outDir: join(outsideRoot, "compiled") });
    expect(outside).toMatchObject({
      ok: false,
      error: {
        code: "authoring_path_not_approved",
        message: "SDK compile package output must be inside an approved authoring output root and may not traverse symbolic links."
      }
    });
    await expect(lstat(join(outsideRoot, "compiled"))).rejects.toMatchObject({ code: "ENOENT" });

    const linkedRoot = join(approvedRoot, "linked-outside");
    await symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const linked = await sdk.compile({ script: scriptedVideo(), outDir: join(linkedRoot, "compiled") });
    expect(linked).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    await expect(lstat(join(outsideRoot, "compiled"))).rejects.toMatchObject({ code: "ENOENT" });

    const allowed = await sdk.compile({ script: scriptedVideo(), outDir: join(approvedRoot, "compiled") });
    expect(allowed).toMatchObject({ ok: true, output: { packageRoot: join(approvedRoot, "compiled") } });
    await expect(readFile(join(approvedRoot, "compiled", "manifest.json"), "utf8")).resolves.toContain("pkg_script_sdk_local");
  });

  it.skipIf(process.platform === "win32")("refuses an unsafe SDK compile output parent before it creates a package", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-compile-unsafe-output-"));
    const unsafeParent = join(root, "unsafe");
    const outDir = join(unsafeParent, "compiled");
    roots.push(root);
    await mkdir(unsafeParent, { mode: 0o777 });
    await chmod(unsafeParent, 0o777);

    const compiled = await createLocalMotionSdk(withTestAuthoringRoots({}, { outputRoots: [root] })).compile({ script: scriptedVideo(), outDir });

    expect(compiled).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: expect.stringMatching(/topology is unsafe|writable/i) } });
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps SDK package identity bound to the Core loader snapshot instead of reopening paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-loader-identity-"));
    const packageRoot = join(root, "package");
    roots.push(root);
    await cp(resolve("../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
    const pkg = await loadMotionPackage(packageRoot);
    const loaded = loadedPackageInputHashes(pkg);
    expect(loaded).toBeTruthy();

    // A response can be assembled after the producer has atomically moved or cleaned its source
    // directory. The parsed object remains valid; the identity must not open pathname bytes again.
    await rm(join(packageRoot, "manifest.json"));
    await rm(join(packageRoot, "motion.json"));
    await expect(localPackageIdentity(pkg)).resolves.toMatchObject({
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      manifestSha256: loaded?.["manifest.json"],
      motionSha256: loaded?.[pkg.manifest.motion]
    });
  });

  // Superseded behaviour: the renderability gate lived only in the Debug API/MCP command, so the
  // same directory was `valid` through the SDK and `package_unrenderable` through MCP. Both now call
  // core's `unrenderablePackageRefusal`; this test fails if either surface grows its own answer.
  // Reproduced end to end in artifacts/lane-truth-defects/falsifier-sdk-mcp-validate.ts.
  it("refuses an unrenderable package with the same verdict the MCP surface gives", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-unrenderable-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    await writeUnrenderablePackage(packageRoot);

    const mcp = await dispatchDebugCommand("motion.package.validate", { packageRoot }, { tier: "read_motion" });
    const sdk = await createLocalMotionSdk().validate({ packageRoot });

    expect(mcp.ok).toBe(false);
    expect(sdk.ok).toBe(false);
    if (mcp.ok || sdk.ok) throw new Error("unreachable");
    expect(sdk.error.code).toBe(mcp.error.code);
    expect(sdk.error.message).toBe(mcp.error.message);
    expect(sdk.error).toMatchObject({
      code: "package_unrenderable",
      message: 'No render lane supports 1 layer: box (type "rect").',
      detail: {
        suggestedAction: mcp.error.suggestedAction,
        unrenderableLayers: [{ layerId: "box", type: "rect" }],
      },
    });
  });

  it("preserves structural-stage ordering and diagnostics on failed local SDK validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-structural-validation-"));
    roots.push(root);
    const packageRoot = join(root, "package");
    await writeStructurallyInvalidPackage(packageRoot);

    const validated = await createLocalMotionSdk().validate({ packageRoot });

    expect(validated).toMatchObject({
      ok: false,
      error: {
        code: "invalid_motion_document",
        detail: {
          validation: {
            contract: "shellx-motion/motion-validation@1",
            structural: "failed",
            semantic: "not_run",
            renderability: "not_proven",
          },
          schemaErrorCount: 1,
          schemaErrorsTruncated: false,
        },
      },
    });
    if (validated.ok) throw new Error("unreachable");
    const detail = validated.error.detail as { schemaErrors?: Array<{ path?: unknown }> } | undefined;
    expect(detail?.schemaErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/layers/0/environment/backgroundColor" })]),
    );
  });

  it("persists passed and failed validation receipts in the caller's governed host store", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-validation-receipts-"));
    roots.push(root);
    const receiptsRoot = join(root, "host-receipts");
    const sdk = createLocalMotionSdk();

    const passed = await sdk.validate({
      packageRoot: resolve("../../fixtures/packages/editable-lower-third"),
      receiptsRoot,
    });
    expect(passed).toMatchObject({
      ok: true,
      output: { receiptId: expect.stringMatching(/^package-validate-/), receiptPath: expect.any(String) },
    });
    if (!passed.ok) throw new Error("unreachable");
    expect(JSON.parse(await readFile(passed.output.receiptPath!, "utf8"))).toMatchObject({
      operation: "package.validate",
      status: "passed",
      actor: { transport: "sdk", grantedTier: "read_motion" },
    });

    const packageRoot = join(root, "unrenderable-package");
    await writeUnrenderablePackage(packageRoot);
    const failed = await sdk.validate({ packageRoot, receiptsRoot });
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "package_unrenderable",
        detail: { receiptId: expect.stringMatching(/^package-validate-/), receiptPath: expect.any(String) },
      },
    });
    if (failed.ok) throw new Error("unreachable");
    const failedDetail = failed.error.detail as { receiptPath?: unknown } | undefined;
    const failedPath = failedDetail?.receiptPath;
    expect(typeof failedPath).toBe("string");
    expect(JSON.parse(await readFile(String(failedPath), "utf8"))).toMatchObject({
      operation: "package.validate",
      status: "failed",
      output: { error: { code: "package_unrenderable" } },
    });
  });

  it("still validates a package every lane can render", async () => {
    const validated = await createLocalMotionSdk().validate({ packageRoot: resolve("../../fixtures/packages/fixed-scene3d") });
    expect(validated).toMatchObject({ ok: true, output: { package: { packageId: "pkg_fixed_scene3d" } } });
  });
});

/** A structurally valid package whose only layer has a type no capability card lists. */
async function writeUnrenderablePackage(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_unrenderable_probe",
    name: "Unrenderable Probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_unrenderable_probe",
    name: "Unrenderable Probe",
    durationMs: 1000,
    fps: 24,
    width: 320,
    height: 180,
    background: "#020617",
    layers: [{ id: "box", type: "rect", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 100, height: 100 } }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  }, null, 2)}\n`, "utf8");
}

async function writeStructurallyInvalidPackage(packageRoot: string): Promise<void> {
  await writeUnrenderablePackage(packageRoot);
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, unknown>;
  motion.layers = [{
    id: "weather",
    type: "environment",
    startMs: 0,
    durationMs: 1000,
    environment: {
      schema: "shellx-motion/environment@1",
      kind: "rain",
      seed: 1,
      quality: "preview",
      mode: "scene",
      intensity: 0.5,
      wind: 0,
      dropSpeed: 1,
      dropLength: 1,
      depthLayers: 1,
      color: "#ffffff",
      backgroundColor: "midnightblue",
      lightColor: "#ffffff",
      accentColor: "#ffffff",
      ground: { horizon: 0.5, wetness: 0.5, roughness: 0.5, rippleAmount: 0.5, splashAmount: 0.5, reflectionStrength: 0.5 },
      atmosphere: { mist: 0.2, lensDroplets: 0.2 },
    },
  }];
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
}

function scriptedVideo() {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "sdk-local",
    name: "SDK Local",
    sourceApp: "shellx-motion-sdk",
    workflow: "compile",
    width: 320,
    height: 180,
    fps: 5,
    frames: [{ id: "only", title: "Local SDK", durationMs: 200, background: "#0f172a", accent: "#38bdf8" }],
  };
}
