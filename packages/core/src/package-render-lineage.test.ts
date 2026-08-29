import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindFinalRenderReceiptLineage,
  derivePackageRenderLineage,
  hashBuffer,
  loadStableRenderPackage,
  lowerGltfToMotion,
  MAX_PACKAGE_SOURCE_BYTES,
  packageRenderLineageInputHashes,
  parseGltfContainer,
  validatePackageRenderLineage,
  type OperationReceipt,
  type PackageManifest,
} from "./index";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];

describe("package render lineage", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes the shared 64 MiB package-source ceiling for bounded PNG and preserved-source readers", () => {
    expect(MAX_PACKAGE_SOURCE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("derives a path-free two-hash lineage for ordinary Motion packages", async () => {
    const root = await tempRoot();
    const motion = { schema: "shellx-motion/motion@1", id: "motion_plain" };
    const manifest = manifestFor("pkg_plain", "motion.json");
    const manifestBytes = jsonBytes(manifest);
    const motionBytes = jsonBytes(motion);
    await writeFile(join(root, "manifest.json"), manifestBytes);
    await writeFile(join(root, "motion.json"), motionBytes);

    const lineage = await derivePackageRenderLineage(root);

    expect(lineage).toEqual({
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: hashBuffer(manifestBytes),
      motionSha256: hashBuffer(motionBytes),
    });
    expect(packageRenderLineageInputHashes(lineage)).toEqual({
      manifestSha256: hashBuffer(manifestBytes),
      motionSha256: hashBuffer(motionBytes),
    });
  });

  it("applies structural JSON admission before parsing every lineage-owned JSON file", async () => {
    const manifestRoot = await writePlainPackage("manifest-structural");
    await writeFile(join(manifestRoot, "manifest.json"), jsonBytes({
      ...manifestFor("pkg_manifest_structural", "motion.json"),
      ignored: deeplyNestedValue()
    }));
    await expectMarkedInputRejectedBeforeJsonParse(manifestRoot, /pre-parse nesting limit/);

    const motionRoot = await writePlainPackage("motion-structural");
    await writeFile(join(motionRoot, "motion.json"), jsonBytes({
      ...motionFor("motion_motion_structural", "Motion structural"),
      ignored: deeplyNestedValue()
    }));
    await expectMarkedInputRejectedBeforeJsonParse(motionRoot, /pre-parse nesting limit/);

    const receiptFixture = await writeGltfPackage();
    const receipt = JSON.parse(await readFile(receiptFixture.receiptPath, "utf8"));
    receipt.ignored = deeplyNestedValue();
    await writeFile(receiptFixture.receiptPath, jsonBytes(receipt));
    await expectMarkedInputRejectedBeforeJsonParse(receiptFixture.root, /pre-parse nesting limit/);
  });

  it("rejects invalid UTF-8 lineage JSON before JSON.parse", async () => {
    const root = await writePlainPackage("invalid-utf8");
    const valid = jsonBytes(manifestFor("pkg_invalid_utf8", "motion.json"));
    await writeFile(
      join(root, "manifest.json"),
      Buffer.concat([valid.subarray(0, valid.byteLength - 2), Buffer.from([0xc3, 0x28, 0x7d, 0x0a])])
    );
    await expectRejectedBeforeJsonParse(root, /valid UTF-8 JSON/);
  });

  it("binds the exact loaded package revision and refuses a same-id source mutation before receipt release", async () => {
    const root = await stableTempRoot();
    const manifest = manifestFor("pkg_same_id", "motion.json");
    const motion = motionFor("motion_same_id", "first revision");
    await writeFile(join(root, "manifest.json"), jsonBytes(manifest));
    await writeFile(join(root, "motion.json"), jsonBytes(motion));

    await withinWorkspace(resolve(".scratch"), async () => {
      const loaded = await loadStableRenderPackage(root);
      const receipt: OperationReceipt = {
        schema: "shellx-motion/receipt@1",
        id: "final-same-id",
        operation: "render.final",
        status: "passed",
        packageId: manifest.id,
        inputHashes: { frames: "f".repeat(64) },
        createdAt: "2026-08-26T00:00:00.000Z",
        lane: "ffmpeg",
        output: { path: "out.mp4" },
        warnings: [],
      };

      await bindFinalRenderReceiptLineage(receipt, loaded.pkg, loaded.lineage);
      expect(receipt.inputHashes).toEqual({
        frames: "f".repeat(64),
        ...packageRenderLineageInputHashes(loaded.lineage),
      });

      await writeFile(join(root, "motion.json"), jsonBytes(motionFor("motion_same_id", "second revision")));
      await expect(bindFinalRenderReceiptLineage(receipt, loaded.pkg, loaded.lineage))
        .rejects.toThrow("changed during the final render");

      const revised = await loadStableRenderPackage(root);
      expect(revised.pkg.manifest.id).toBe(loaded.pkg.manifest.id);
      expect(revised.lineage.motionSha256).not.toBe(loaded.lineage.motionSha256);
    });
  });

  it("binds preserved, normalized, and lowering-receipt bytes for glTF packages", async () => {
    const fixture = await writeGltfPackage();

    await expect(derivePackageRenderLineage(fixture.root)).resolves.toEqual({
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: fixture.manifestSha256,
      motionSha256: fixture.motionSha256,
      adapterId: "adapter.gltf",
      sourceSha256: fixture.sourceSha256,
      normalizedSourceSha256: fixture.normalizedSourceSha256,
      loweringReceiptSha256: fixture.loweringReceiptSha256,
    });
  });

  it("rejects each glTF provenance and receipt tamper", async () => {
    const sourceTamper = await writeGltfPackage();
    await writeFile(sourceTamper.sourcePath, Buffer.concat([await readFile(sourceTamper.sourcePath), Buffer.from(" ")]));
    await expect(derivePackageRenderLineage(sourceTamper.root)).rejects.toThrow("preserved source hash");

    const normalizedTamper = await writeGltfPackage();
    await writeFile(normalizedTamper.normalizedPath, Buffer.concat([await readFile(normalizedTamper.normalizedPath), Buffer.from(" ")]));
    await expect(derivePackageRenderLineage(normalizedTamper.root)).rejects.toThrow("normalized source hash");

    const receiptTamper = await writeGltfPackage();
    const receipt = JSON.parse(await readFile(receiptTamper.receiptPath, "utf8"));
    receipt.inputHashes.source = "f".repeat(64);
    await writeFile(receiptTamper.receiptPath, jsonBytes(receipt));
    await expect(derivePackageRenderLineage(receiptTamper.root)).rejects.toThrow("input hashes");

    const receiptIdentityTamper = await writeGltfPackage();
    const wrongIdentity = JSON.parse(await readFile(receiptIdentityTamper.receiptPath, "utf8"));
    wrongIdentity.id = "adapter-lowering-gltf-forged";
    await writeFile(receiptIdentityTamper.receiptPath, jsonBytes(wrongIdentity));
    await expect(derivePackageRenderLineage(receiptIdentityTamper.root)).rejects.toThrow("receipt identity");

    const receiptOutputTamper = await writeGltfPackage();
    const wrongOutput = JSON.parse(await readFile(receiptOutputTamper.receiptPath, "utf8"));
    wrongOutput.output.motionId = "motion_forged";
    await writeFile(receiptOutputTamper.receiptPath, jsonBytes(wrongOutput));
    await expect(derivePackageRenderLineage(receiptOutputTamper.root)).rejects.toThrow("receipt output");

    const loweredHashTamper = await writeGltfPackage();
    const wrongLoweredHash = JSON.parse(await readFile(loweredHashTamper.receiptPath, "utf8"));
    wrongLoweredHash.output.motionSha256 = "9".repeat(64);
    await writeFile(loweredHashTamper.receiptPath, jsonBytes(wrongLoweredHash));
    await expect(derivePackageRenderLineage(loweredHashTamper.root)).rejects.toThrow("receipt identity");

    const editedMotion = await writeGltfPackage();
    const motion = JSON.parse(await readFile(editedMotion.motionPath, "utf8"));
    motion.name = "legitimate edit after lowering";
    await writeFile(editedMotion.motionPath, jsonBytes(motion));
    await expect(derivePackageRenderLineage(editedMotion.root)).resolves.toMatchObject({
      adapterId: "adapter.gltf",
      manifestSha256: editedMotion.manifestSha256,
      motionSha256: hashBuffer(jsonBytes(motion)),
      sourceSha256: editedMotion.sourceSha256,
      normalizedSourceSha256: editedMotion.normalizedSourceSha256,
      loweringReceiptSha256: editedMotion.loweringReceiptSha256,
    });
  });

  it("requires complete glTF lineage and rejects symlinked package files", async () => {
    expect(() => validatePackageRenderLineage({
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: "a".repeat(64),
      motionSha256: "b".repeat(64),
      adapterId: "adapter.gltf",
      sourceSha256: "c".repeat(64),
    })).toThrow("normalizedSourceSha256");

    const fixture = await writeGltfPackage();
    const replacement = join(fixture.root, "source", "replacement.gltf");
    await writeFile(replacement, await readFile(fixture.sourcePath));
    await unlink(fixture.sourcePath);

    // Windows refuses FILE symlinks without elevation or Developer Mode (EPERM), and the
    // "junction" workaround used elsewhere in this suite only exists for directories. The
    // behaviour under test is engine-side symlink rejection, not the harness's ability to
    // create one — so when the OS denies the fixture, skip the assertion loudly instead of
    // failing the suite or, worse, passing without having tested anything.
    if (!(await tryCreateFileSymlink(replacement, fixture.sourcePath))) {
      console.warn(
        "[package-render-lineage] skipped symlink rejection: this OS denied file-symlink creation "
        + "(Windows needs elevation or Developer Mode). Engine behaviour unverified on this host."
      );
      return;
    }
    await expect(derivePackageRenderLineage(fixture.root)).rejects.toThrow("non-symlink");
  });
});

/**
 * Creates a file symlink, returning false when the OS refuses the operation rather than
 * throwing. Windows denies unprivileged file symlinks with EPERM (and EACCES on some
 * configurations); every other permission or path error is a real problem and is rethrown.
 */
async function tryCreateFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return false;
    throw error;
  }
}

async function writeGltfPackage() {
  const root = await tempRoot();
  const sourceBytes = await readFile(resolve("../../fixtures/imports/gltf-triangle/input.gltf"));
  const container = parseGltfContainer(sourceBytes, "gltf");
  const normalizedBytes = Buffer.from(container.jsonText, "utf8");
  const sourceSha256 = hashBuffer(sourceBytes);
  const normalizedSourceSha256 = hashBuffer(normalizedBytes);
  const packageId = `pkg_gltf_${sourceSha256.slice(0, 16)}`;
  const lowering = lowerGltfToMotion({
    adapterId: "adapter.gltf",
    sourcePath: "source/normalized.gltf.json",
    sourceText: container.jsonText,
    normalizedPackagePath: packageId,
    container,
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  const manifest: PackageManifest = {
    ...manifestFor(packageId, "motion.json"),
    sourceApp: "gltf",
    data: {
      adapter: {
        schema: "shellx-motion/adapter-source@1",
        id: "adapter.gltf",
        source: "source/input.gltf",
        sourceSha256,
        loweringSource: "source/normalized.gltf.json",
        loweringSourceSha256: normalizedSourceSha256,
        loweringReceipt: "receipts/adapter-lowering.receipt.json",
        diagnosticsReceipt: "receipts/adapter-diagnostics.receipt.json",
        container: {
          schema: "shellx-motion/gltf-source@1",
          format: "gltf",
          bufferSha256: container.bufferSha256,
        },
      },
    },
  };
  const sourcePath = join(root, "source", "input.gltf");
  const normalizedPath = join(root, "source", "normalized.gltf.json");
  const motionPath = join(root, "motion.json");
  const receiptPath = join(root, "receipts", "adapter-lowering.receipt.json");
  await mkdir(dirname(sourcePath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  const manifestBytes = jsonBytes(manifest);
  const motionBytes = jsonBytes(lowering.motion);
  const receiptBytes = jsonBytes(lowering.receipt);
  await Promise.all([
    writeFile(join(root, "manifest.json"), manifestBytes),
    writeFile(motionPath, motionBytes),
    writeFile(sourcePath, sourceBytes),
    writeFile(normalizedPath, normalizedBytes),
    writeFile(receiptPath, receiptBytes),
  ]);
  return {
    root,
    sourcePath,
    normalizedPath,
    motionPath,
    receiptPath,
    sourceSha256,
    normalizedSourceSha256,
    manifestSha256: hashBuffer(manifestBytes),
    motionSha256: hashBuffer(motionBytes),
    loweringReceiptSha256: hashBuffer(receiptBytes),
  };
}

function manifestFor(id: string, motion: string): PackageManifest {
  return {
    schema: "shellx-motion/package-manifest@1",
    id,
    name: id,
    motion,
    assets: [],
    sourceApp: "test",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  };
}

function motionFor(id: string, name: string) {
  return {
    schema: "shellx-motion/motion@1",
    id,
    name,
    durationMs: 1_000,
    fps: 30,
    width: 16,
    height: 16,
    layers: [],
    assets: [],
    provenance: { sourceApp: "test", createdBy: "test" },
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-render-lineage-"));
  roots.push(root);
  return root;
}

async function writePlainPackage(suffix: string): Promise<string> {
  const root = await tempRoot();
  await writeFile(join(root, "manifest.json"), jsonBytes(manifestFor(`pkg_${suffix}`, "motion.json")));
  await writeFile(join(root, "motion.json"), jsonBytes(motionFor(`motion_${suffix}`, suffix)));
  return root;
}

async function expectRejectedBeforeJsonParse(root: string, error: RegExp): Promise<void> {
  const parse = vi.spyOn(JSON, "parse");
  try {
    await expect(derivePackageRenderLineage(root)).rejects.toThrow(error);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
}

async function expectMarkedInputRejectedBeforeJsonParse(root: string, error: RegExp): Promise<void> {
  const parse = vi.spyOn(JSON, "parse");
  try {
    await expect(derivePackageRenderLineage(root)).rejects.toThrow(error);
    expect(parse.mock.calls.some(([source]) => typeof source === "string" && source.includes('"ignored"'))).toBe(false);
  } finally {
    parse.mockRestore();
  }
}

function deeplyNestedValue(): unknown {
  let value: unknown = 0;
  for (let depth = 0; depth < 65; depth += 1) value = { child: value };
  return value;
}

async function stableTempRoot(): Promise<string> {
  const parent = resolve(".scratch");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "shellx-motion-render-lineage-"));
  roots.push(root);
  return root;
}

async function withinWorkspace<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
