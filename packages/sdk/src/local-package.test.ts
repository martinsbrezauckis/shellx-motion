import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "@shellx-motion/debug-api";
import { createLocalMotionSdk } from "./local.js";

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
    const sdk = createLocalMotionSdk();
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
    expect(repeated).toMatchObject({ ok: false, error: { code: "local_operation_failed", message: expect.stringContaining("already exists") } });
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

  it("still validates a package every lane can render", async () => {
    const validated = await createLocalMotionSdk().validate({ packageRoot: resolve("../../fixtures/packages/fixed-scene3d") });
    expect(validated).toMatchObject({ ok: true, output: { package: { packageId: "pkg_fixed_scene3d" } } });
  });
});

/** A structurally valid package whose only layer has a type no capability card lists. */
async function writeUnrenderablePackage(packageRoot: string): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
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
