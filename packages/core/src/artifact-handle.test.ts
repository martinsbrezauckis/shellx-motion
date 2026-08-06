import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactProbeChildEnvironment,
  attestArtifactReceipt,
  createAttestedArtifactHandle,
  createAttestedArtifactHandleReference,
  packageRenderLineageInputHashes,
  readAttestedArtifactHandle,
  resolveArtifactFfprobeExecutable,
  verifyAttestedArtifactHandle,
  verifyAttestedArtifactHandleReference,
  writeAttestedArtifactHandle,
  type AttestedArtifactHandle,
  type OperationReceipt,
  type PackageRenderLineage
} from "./index";

const roots: string[] = [];
const OPERATION_HASH = "a".repeat(64);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const LINEAGE: PackageRenderLineage = {
  schema: "shellx-motion/package-render-lineage@1",
  manifestSha256: "b".repeat(64),
  motionSha256: "c".repeat(64),
};

describe("attested artifact handles", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates, writes, reads, and verifies a content-bound root-relative handle", async () => {
    const fixture = await writeArtifactFixture();
    const renderReceipt = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");
    const handle = await createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: fixture.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: [renderReceipt],
      createdAt: "2026-07-11T10:00:00.000Z"
    });
    const handlePath = join(fixture.root, "handles", "output.artifact.json");

    await writeAttestedArtifactHandle(handlePath, handle);
    const canonicalArtifactPath = await realpath(fixture.artifactPath);
    const canonicalHandlePath = await realpath(handlePath);
    const loaded = await readAttestedArtifactHandle(handlePath);
    const reference = createAttestedArtifactHandleReference(handle, "handles/output.artifact.json", sha256(await readFile(handlePath)));
    const verified = await verifyAttestedArtifactHandle(fixture.root, loaded, {
      expected: {
        packageId: "pkg_attested",
        motionId: "motion_attested",
        preset: "png",
        mediaType: "image/png",
        operationHash: OPERATION_HASH
      }
    });

    expect(loaded).toMatchObject({
      schema: "shellx-motion/artifact-handle@1",
      rootRelativePath: "render/output.png",
      byteLength: PNG_BYTES.byteLength,
      sha256: sha256(PNG_BYTES),
      receipts: [expect.objectContaining({ role: "render", id: "render-receipt", status: "passed" })]
    });
    expect(verified.path).toBe(canonicalArtifactPath);
    await expect(verifyAttestedArtifactHandleReference(fixture.root, reference, { probe: false })).resolves.toMatchObject({
      descriptorPath: canonicalHandlePath,
      path: canonicalArtifactPath
    });
    await expect(verifyAttestedArtifactHandleReference(fixture.root, { ...reference, sha256: "f".repeat(64) }, { probe: false }))
      .rejects.toThrow("descriptor sha256 mismatch");
    expect(verified.receipts[0].receipt.id).toBe("render-receipt");
    await expect(writeAttestedArtifactHandle(handlePath, handle)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("uses the configured ffprobe executable for artifact verification", () => {
    expect(resolveArtifactFfprobeExecutable({
      env: { SHELLX_MOTION_FFPROBE: " /opt/shellx/bin/ffprobe-custom " }
    })).toBe("/opt/shellx/bin/ffprobe-custom");
    expect(resolveArtifactFfprobeExecutable({ env: {} })).toBe("ffprobe");
    expect(() => resolveArtifactFfprobeExecutable({ ffprobePath: "bad\0path", env: {} })).toThrow("null bytes");
  });

  it("scrubs credential-shaped variables from FFprobe child environments", () => {
    const environment = artifactProbeChildEnvironment({
      PATH: "/usr/bin",
      SHELLX_MOTION_DEBUG_TOKEN: "fixture-debug-token",
      OPENAI_API_KEY: "fixture-api-key"
    });

    expect(environment.PATH).toBe("/usr/bin");
    expect(environment).not.toHaveProperty("SHELLX_MOTION_DEBUG_TOKEN");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("binds package lineage into the handle id, reference, expected identity, and exact render inputs", async () => {
    const fixture = await writeArtifactFixture({ packageLineage: LINEAGE });
    const renderReceipt = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");
    const handle = await createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: fixture.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: [renderReceipt],
      packageLineage: LINEAGE,
    });
    const legacy = await createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: fixture.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: [renderReceipt],
    });
    const descriptorPath = join(fixture.root, "handles", "lineaged.artifact.json");
    await writeAttestedArtifactHandle(descriptorPath, handle);
    const reference = createAttestedArtifactHandleReference(handle, "handles/lineaged.artifact.json", sha256(await readFile(descriptorPath)));

    expect(handle.id).not.toBe(legacy.id);
    expect(reference.packageLineage).toEqual(LINEAGE);
    await expect(verifyAttestedArtifactHandle(fixture.root, handle, { expected: { packageLineage: LINEAGE } })).resolves.toBeDefined();
    await expect(verifyAttestedArtifactHandle(fixture.root, handle, {
      expected: { packageLineage: { ...LINEAGE, manifestSha256: "d".repeat(64) } },
    })).rejects.toThrow("packageLineage mismatch");
    await expect(verifyAttestedArtifactHandleReference(fixture.root, {
      ...reference,
      packageLineage: { ...LINEAGE, manifestSha256: "d".repeat(64) },
    }, { probe: false })).rejects.toThrow("packageLineage does not match");

    const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8")) as OperationReceipt;
    receipt.inputHashes.extra = "e".repeat(64);
    await writeFile(fixture.receiptPath, `${JSON.stringify(receipt)}\n`);
    const tamperedAttestation = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");
    await expect(verifyAttestedArtifactHandle(fixture.root, { ...handle, receipts: [tamperedAttestation] }))
      .rejects.toThrow("do not exactly bind");
  });

  it("keeps legacy no-lineage handle verification compatible and rejects incomplete glTF lineage", async () => {
    const valid = await createFixtureHandle();
    await expect(verifyAttestedArtifactHandle(valid.root, valid.handle, { expected: { packageId: "pkg_attested" } }))
      .resolves.toBeDefined();
    await expect(createAttestedArtifactHandle({
      root: valid.root,
      artifactPath: valid.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: valid.handle.receipts,
      packageLineage: { ...LINEAGE, adapterId: "adapter.gltf", sourceSha256: "d".repeat(64) },
    })).rejects.toThrow("normalizedSourceSha256");
  });

  it("rejects absolute, parent-traversing, and non-canonical handle paths", async () => {
    const { root, handle } = await createFixtureHandle();
    for (const rootRelativePath of ["/tmp/output.png", "../output.png", "render/../output.png", "render\\output.png"]) {
      await expect(verifyAttestedArtifactHandle(root, { ...handle, rootRelativePath }))
        .rejects.toThrow(/canonical|root-relative|parent segments/);
    }
  });

  it("rejects symlink escapes from the trusted root", async () => {
    const fixture = await writeArtifactFixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-artifact-outside-"));
    roots.push(outsideRoot);
    const outsidePath = join(outsideRoot, "outside.png");
    const escapeRoot = join(fixture.root, "render", "escape-root");
    await writeFile(outsidePath, PNG_BYTES);
    await symlink(outsideRoot, escapeRoot, process.platform === "win32" ? "junction" : "dir");
    const receipt = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");

    await expect(createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: join(escapeRoot, "outside.png"),
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: [receipt]
    })).rejects.toThrow("escapes the trusted artifact root");
  });

  it("detects swapped artifact bytes and stale receipt files", async () => {
    const { root, artifactPath, receiptPath, handle } = await createFixtureHandle();
    await writeFile(artifactPath, Buffer.concat([PNG_BYTES, Buffer.from("swapped")]));
    await expect(verifyAttestedArtifactHandle(root, handle)).rejects.toThrow(/byte length mismatch|sha256 mismatch/);

    await writeFile(artifactPath, PNG_BYTES);
    await writeFile(receiptPath, `${JSON.stringify({ stale: true })}\n`);
    await expect(verifyAttestedArtifactHandle(root, handle)).rejects.toThrow("render receipt sha256 mismatch");
  });

  it("rejects receipts that point elsewhere or do not bind the operation hash", async () => {
    const valid = await createFixtureHandle();
    const wrongOperation = await createAttestedArtifactHandle({
      root: valid.root,
      artifactPath: valid.artifactPath,
      packageId: valid.handle.packageId,
      motionId: valid.handle.motionId,
      operationHash: "b".repeat(64),
      preset: valid.handle.preset,
      mediaType: valid.handle.mediaType,
      receipts: valid.handle.receipts,
    });
    await expect(verifyAttestedArtifactHandle(valid.root, wrongOperation))
      .rejects.toThrow("do not bind the artifact operationHash");

    const receipt = JSON.parse(await readFile(valid.receiptPath, "utf8")) as OperationReceipt;
    (receipt.output as { path: string }).path = join(tmpdir(), "render", "output.png");
    await writeFile(valid.receiptPath, `${JSON.stringify(receipt)}\n`);
    const wrongPathAttestation = await attestArtifactReceipt(valid.root, valid.receiptPath, "render");
    const wrongPathHandle = { ...valid.handle, receipts: [wrongPathAttestation] };
    await expect(verifyAttestedArtifactHandle(valid.root, wrongPathHandle))
      .rejects.toThrow(/does not resolve|does not bind/);
  });

  it("rejects failed receipts, mismatched expected metadata, oversized files, and invalid magic", async () => {
    const fixture = await writeArtifactFixture({ receiptStatus: "failed" });
    await expect(attestArtifactReceipt(fixture.root, fixture.receiptPath, "render"))
      .rejects.toThrow("is not successful");

    const valid = await createFixtureHandle();
    await expect(verifyAttestedArtifactHandle(valid.root, valid.handle, { expected: { preset: "mp4-h264" } }))
      .rejects.toThrow("artifact preset mismatch");
    await expect(createAttestedArtifactHandle({
      root: valid.root,
      artifactPath: valid.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: valid.handle.receipts,
      maxBytes: PNG_BYTES.byteLength - 1
    })).rejects.toThrow("exceeds");

    await writeFile(valid.artifactPath, Buffer.from("not a png"));
    await expect(createAttestedArtifactHandle({
      root: valid.root,
      artifactPath: valid.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: valid.handle.receipts
    })).rejects.toThrow("bytes do not match");
  });

  it("rejects malformed probed media and probe drift", async () => {
    const fixture = await writeArtifactFixture({ mediaBytes: mp4Header(), mediaType: "video/mp4", preset: "mp4-h264" });
    const receipt = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");
    await expect(createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: fixture.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "mp4-h264",
      mediaType: "video/mp4",
      receipts: [receipt],
      probe: async () => { throw new Error("malformed codec"); }
    })).rejects.toThrow("malformed codec");

    const handle = await createAttestedArtifactHandle({
      root: fixture.root,
      artifactPath: fixture.artifactPath,
      packageId: "pkg_attested",
      motionId: "motion_attested",
      operationHash: OPERATION_HASH,
      preset: "mp4-h264",
      mediaType: "video/mp4",
      receipts: [receipt],
      probe: async () => ({ formatName: "mov,mp4", streams: [{ index: 0, codecType: "video", codecName: "h264" }] })
    });
    await expect(verifyAttestedArtifactHandle(fixture.root, handle, {
      probe: async () => ({ formatName: "mov,mp4", streams: [{ index: 0, codecType: "video", codecName: "hevc" }] })
    })).rejects.toThrow("probe no longer matches");
  });
});

async function createFixtureHandle(): Promise<Awaited<ReturnType<typeof writeArtifactFixture>> & { handle: AttestedArtifactHandle }> {
  const fixture = await writeArtifactFixture();
  const receipt = await attestArtifactReceipt(fixture.root, fixture.receiptPath, "render");
  const handle = await createAttestedArtifactHandle({
    root: fixture.root,
    artifactPath: fixture.artifactPath,
    packageId: "pkg_attested",
    motionId: "motion_attested",
    operationHash: OPERATION_HASH,
    preset: "png",
    mediaType: "image/png",
    receipts: [receipt]
  });
  return { ...fixture, handle };
}

async function writeArtifactFixture(options: {
  receiptStatus?: OperationReceipt["status"];
  mediaBytes?: Buffer;
  mediaType?: string;
  preset?: string;
  packageLineage?: PackageRenderLineage;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-artifact-handle-"));
  roots.push(root);
  const artifactPath = join(root, "render", options.mediaType === "video/mp4" ? "output.mp4" : "output.png");
  const receiptPath = join(root, "receipts", "render.receipt.json");
  const mediaBytes = options.mediaBytes ?? PNG_BYTES;
  const preset = options.preset ?? "png";
  await mkdir(join(root, "render"), { recursive: true });
  await mkdir(join(root, "receipts"), { recursive: true });
  await writeFile(artifactPath, mediaBytes);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: "render-receipt",
    operation: "render.final",
    status: options.receiptStatus ?? "passed",
    packageId: "pkg_attested",
    inputHashes: options.packageLineage
      ? { operationHash: OPERATION_HASH, ...packageRenderLineageInputHashes(options.packageLineage) }
      : { operation: OPERATION_HASH },
    createdAt: "2026-07-11T09:59:59.000Z",
    lane: "ffmpeg",
    output: {
      path: artifactPath,
      sha256: sha256(mediaBytes),
      preset
    },
    warnings: []
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { root, artifactPath, receiptPath };
}

function mp4Header(): Buffer {
  return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
