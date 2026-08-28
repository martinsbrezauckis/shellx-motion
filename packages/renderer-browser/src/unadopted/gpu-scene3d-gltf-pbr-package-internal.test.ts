import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { GPU_SCENE3D_GLTF_PBR_PACKAGE_INTERNAL_SCHEMA, assertScene3dGltfPbrOutputDisjoint, renderScene3dGltfPbrPackageInternal, verifyScene3dGltfPbrPackageInternalReceipt } from "./gpu-scene3d-gltf-pbr-package-internal";

const roots: string[] = [];
const HASH_A = "a".repeat(64), HASH_B = "b".repeat(64), HASH_C = "c".repeat(64);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("package-internal glTF PBR dispatch", () => {
  it("refuses malformed or caller-asserted package requests before opening a package, Browser, or output stage", async () => {
    const outputDirectory = join(tmpdir(), `shellx-motion-pbr-refusal-${process.pid}-${Date.now()}`);
    const result = await renderScene3dGltfPbrPackageInternal({ schema: GPU_SCENE3D_GLTF_PBR_PACKAGE_INTERNAL_SCHEMA, packageRoot: "/not-a-package", outputDirectory, unexpectedPackageId: "forged" } as never);
    expect(result).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } }); expect(existsSync(outputDirectory)).toBe(false);
  });

  it("stays absent from the Browser public export surface", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("scene3d-gltf-pbr-package-internal"); expect(index).not.toContain("renderScene3dGltfPbrPackageInternal");
  });

  it("seals the canonical receipt to the exact tight raw RGBA frame identity", () => {
    const receipt = receiptFixture();
    expect(verifyScene3dGltfPbrPackageInternalReceipt(receipt)).toEqual(receipt);
    const reordered = { ...receipt, inputHashes: { ...receipt.inputHashes }, output: { ...receipt.output } };
    expect(canonicalJson(verifyScene3dGltfPbrPackageInternalReceipt(reordered))).toBe(canonicalJson(receipt));
    expect(() => verifyScene3dGltfPbrPackageInternalReceipt({ ...receipt, output: { ...receipt.output, rawRgbaSha256: HASH_A } })).toThrow(/exact admitted identities/);
    expect(() => verifyScene3dGltfPbrPackageInternalReceipt({ ...receipt, inputHashes: { ...receipt.inputHashes, "pbr-raw-rgba-frame": HASH_A } })).toThrow(/exact admitted identities/);
    const { "pbr-raw-rgba-frame": _raw, ...missingRaw } = receipt.inputHashes;
    expect(() => verifyScene3dGltfPbrPackageInternalReceipt({ ...receipt, inputHashes: missingRaw })).toThrow(/input hashes/);
  });

  it("refuses equal, nested, ancestor, and symlink-alias output selections without touching the package tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-pbr-disjoint-")); roots.push(root);
    const source = join(root, "package"), nested = join(source, "pbr-output"), alias = join(root, "package-alias"), sentinel = join(source, "manifest.json");
    await mkdir(source, { mode: 0o700 }); await writeFile(sentinel, "source-must-not-change", { mode: 0o600 });
    const before = await readFile(sentinel);
    for (const output of [source, nested, root]) await expect(assertScene3dGltfPbrOutputDisjoint(source, output)).rejects.toThrow(/disjoint/);
    await symlink(source, alias, "dir");
    await expect(assertScene3dGltfPbrOutputDisjoint(source, join(alias, "pbr-output"))).rejects.toThrow(/symlink/);
    expect(existsSync(nested)).toBe(false); expect(await readFile(sentinel)).toEqual(before);
  });
});

function receiptFixture() {
  const pngSha256 = HASH_B, rawRgbaSha256 = HASH_C;
  return {
    schema: "shellx-motion/receipt@1" as const, id: `receipt_scene3d_gltf_pbr_${pngSha256.slice(0, 16)}`,
    operation: "renderer.browser.scene3d-gltf-pbr-package-internal", status: "passed" as const, packageId: "pkg_pbr_fixture",
    inputHashes: { "gltf-source": HASH_A, "gltf-sidecar": HASH_A, "gltf-sidecar-receipt": HASH_A, "gltf-declaration": HASH_A, "pbr-static-plan": HASH_A, "pbr-frame-plan": HASH_A, "pbr-page-catalog": HASH_A, "pbr-raw-rgba-frame": rawRgbaSha256 },
    createdAt: "2026-08-16T00:00:00.000Z", lane: "gpu", output: { schema: "shellx-motion/scene3d-gltf-pbr-package-output@1", path: "frame.png", sha256: pngSha256, rawRgbaSha256, width: 1280, height: 720, packageId: "pkg_pbr_fixture", pbrCatalogSha256: HASH_A, staticFingerprint: HASH_A, frameFingerprint: HASH_A, peakGpuResourceBytes: 11_059_584, readback: {}, pageReadback: {}, resources: {}, pageCleanup: {}, cleanup: {}, runtime: {} }, warnings: [] as string[]
  };
}
