import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  admitMotionRenderDeliverySources,
  renderDeliveryAnchorDeliveryBindingSha256,
  renderDeliverySourceManifestFingerprint,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { importAdmittedRenderDeliveryToPackage } from "./render-delivery-package-import.js";
import { assertRenderDeliveryPackageImportReceipt } from "./render-delivery-package-import-receipt.js";
import { PackageEditTransactionError } from "../package-edit-transaction.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("private Debug provider-delivery package COW import", () => {
  it("imports only the original admitted sources through one COW swap and writes one path-free receipt", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const sourceBefore = await packageBytes(fixture.sourcePackageRoot);

    const result = await runImport(fixture, manifest);

    expect(result.workspaceCleanup).toBe("completed");
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.copiedOutput)).toBe(true);
    expect(result.receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.copiedAssetCount).toBe(2);
    expect(await packageBytes(fixture.sourcePackageRoot)).toEqual(sourceBefore);
    const receipt = await readFile(join(fixture.outputPackageRoot, "receipts", "render-delivery-import.v1.json"), "utf8");
    expect(receipt).toBe(JSON.stringify(result.receipt, null, 2) + "\n");
    expect(receipt).not.toContain(fixture.providerRoot);
    expect(receipt).not.toContain(fixture.providerPaths[0]!);
    expect(receipt).not.toMatch(/"(?:dev|ino|mtimeMs|ctimeMs)"/);
    for (const fact of manifest.sources.beauty) {
      await expect(readFile(join(fixture.outputPackageRoot, fact.packagePath))).resolves.toEqual(PNG);
    }
  });

  it("refuses a COW output outside the exact host-selected package workspace", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const outside = join(fixture.root, "outside-package-output");
    await expect(importAdmittedRenderDeliveryToPackage(manifest, {
      sourcePackageRoot: fixture.sourcePackageRoot,
      outputPackageRoot: outside,
      packageWorkspaceRoot: join(fixture.root, "package-workspace"),
      packageWorkspaceAuthority: fixture.packageAuthority,
    })).rejects.toMatchObject({ code: "unsafe_output" });
    await expect(readFile(join(outside, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports one canonical anchor payload beside beauty in the same COW transaction and reopens exact evidence", async () => {
    const fixture = await makeAnchoredFixture();
    const manifest = await admitted(fixture);
    const sourceBefore = await packageBytes(fixture.sourcePackageRoot);
    const providerBefore = await Promise.all([...fixture.providerPaths, fixture.anchorPath].map(async (path) => await readFile(path)));

    const result = await runImport(fixture, manifest);

    expect(result.copiedAssetCount).toBe(3);
    expect(result.copiedByteLength).toBe((PNG.byteLength * 2) + fixture.anchorBytes.byteLength);
    expect(result.receipt.sourceManifest.anchors).toMatchObject({
      packagePath: `assets/provider-delivery/${manifest.deliveryFingerprint}/anchors.json`,
      sha256: sha(fixture.anchorBytes), byteLength: fixture.anchorBytes.byteLength,
      schema: "motion.render-provider-anchor-payload/v1", frameCount: 2,
      convention: "screen-pixel-top-left-q1024",
    });
    await expect(readFile(join(fixture.outputPackageRoot, manifest.sources.anchors!.packagePath))).resolves.toEqual(fixture.anchorBytes);
    await expect(packageBytes(fixture.sourcePackageRoot)).resolves.toEqual(sourceBefore);
    await expect(Promise.all([...fixture.providerPaths, fixture.anchorPath].map(async (path) => await readFile(path)))).resolves.toEqual(providerBefore);
    expect(JSON.stringify(result.receipt)).not.toContain(fixture.providerRoot);
    expect(JSON.stringify(result.receipt)).not.toContain(fixture.anchorPath);
  });

  it("refuses anchor destination collisions, stale sources, and partial-anchor rollback before an output claim", async () => {
    const collision = await makeAnchoredFixture();
    const collisionManifest = await admitted(collision);
    await mkdir(dirname(join(collision.sourcePackageRoot, collisionManifest.sources.anchors!.packagePath)), { recursive: true });
    await writeFile(join(collision.sourcePackageRoot, collisionManifest.sources.anchors!.packagePath), Buffer.from("unlisted anchor collision"));
    await expect(runImport(collision, collisionManifest)).rejects.toThrow(/destination must be absent/i);
    await expect(readFile(join(collision.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const stale = await makeAnchoredFixture();
    const staleManifest = await admitted(stale);
    await writeFile(stale.anchorPath, stale.anchorBytes);
    await expect(runImport(stale, staleManifest)).rejects.toMatchObject({ code: "source_identity" });
    await expect(readFile(join(stale.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const rollback = await makeAnchoredFixture();
    const rollbackManifest = await admitted(rollback);
    await expect(runImport(rollback, rollbackManifest, {
      afterCopiedAnchor: async () => { throw new Error("abort after anchor copy"); },
    })).rejects.toThrow(/abort after anchor copy/i);
    await expect(readFile(join(rollback.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a receipt with recomputed fingerprints but forged delivery-derived evidence", async () => {
    const fixture = await makeAnchoredFixture();
    const result = await runImport(fixture, await admitted(fixture));
    const omitted = JSON.parse(JSON.stringify(result.receipt)) as any;
    delete omitted.sourceManifest.anchors;
    delete omitted.copiedOutput.anchors;
    omitted.copiedOutput.assetCount -= 1;
    const { fingerprint: _omittedFingerprint, ...omittedPayload } = omitted;
    omitted.fingerprint = canonicalJsonSha256(omittedPayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(omitted)).toThrow(/invalid structural shape/i);

    const tampered = JSON.parse(JSON.stringify(result.receipt)) as any;
    tampered.sourceManifest.anchors.byteLength += 1;
    const { fingerprint: _tamperedFingerprint, ...tamperedPayload } = tampered;
    tampered.fingerprint = canonicalJsonSha256(tamperedPayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(tampered)).toThrow(/invalid structural shape/i);

    const forgedBinding = JSON.parse(JSON.stringify(result.receipt)) as any;
    const arbitraryBinding = "f".repeat(64);
    forgedBinding.plan.assets.anchors.deliveryBindingSha256 = arbitraryBinding;
    forgedBinding.sourceManifest.anchors.deliveryBindingSha256 = arbitraryBinding;
    forgedBinding.copiedOutput.anchors.deliveryBindingSha256 = arbitraryBinding;
    forgedBinding.planFingerprint = canonicalJsonSha256(forgedBinding.plan);
    forgedBinding.sourceManifest.fingerprint = renderDeliverySourceManifestFingerprint(
      forgedBinding.deliveryFingerprint,
      forgedBinding.plan,
      { beauty: forgedBinding.sourceManifest.beauty, anchors: forgedBinding.sourceManifest.anchors },
      forgedBinding.sourceManifest.sourceByteLength,
    );
    const { fingerprint: _forgedFingerprint, ...forgedPayload } = forgedBinding;
    forgedBinding.fingerprint = canonicalJsonSha256(forgedPayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(forgedBinding)).toThrow(/invalid structural shape/i);

    const forgedBeauty = JSON.parse(JSON.stringify(result.receipt)) as any;
    const arbitraryBeautySha = "e".repeat(64);
    forgedBeauty.plan.assets.beauty[0].sha256 = arbitraryBeautySha;
    forgedBeauty.sourceManifest.beauty[0].sha256 = arbitraryBeautySha;
    forgedBeauty.copiedOutput.beauty[0].sha256 = arbitraryBeautySha;
    recomputeReceiptEvidence(forgedBeauty);
    expect(() => assertRenderDeliveryPackageImportReceipt(forgedBeauty)).toThrow(/invalid structural shape/i);

    for (const forgePlan of [
      (plan: any) => { plan.provider.id = "forged-provider"; },
      (plan: any) => { plan.timing.frameCount += 1; },
      (plan: any) => { plan.assets.beauty[0].packagePath = "assets/forged.png"; },
    ]) {
      const forgedPlan = JSON.parse(JSON.stringify(result.receipt)) as any;
      forgePlan(forgedPlan.plan);
      recomputeReceiptEvidence(forgedPlan);
      expect(() => assertRenderDeliveryPackageImportReceipt(forgedPlan)).toThrow(/invalid structural shape/i);
    }

    const planMismatch = JSON.parse(JSON.stringify(result.receipt)) as any;
    planMismatch.plan.deliveryFingerprint = "0".repeat(64);
    planMismatch.planFingerprint = canonicalJsonSha256(planMismatch.plan);
    const { fingerprint: _planFingerprint, ...planPayload } = planMismatch;
    planMismatch.fingerprint = canonicalJsonSha256(planPayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(planMismatch)).toThrow(/invalid structural shape/i);

    const deliveryMismatch = JSON.parse(JSON.stringify(result.receipt)) as any;
    deliveryMismatch.deliveryFingerprint = "0".repeat(64);
    deliveryMismatch.plan.deliveryFingerprint = deliveryMismatch.deliveryFingerprint;
    deliveryMismatch.planFingerprint = canonicalJsonSha256(deliveryMismatch.plan);
    deliveryMismatch.sourceManifest.fingerprint = renderDeliverySourceManifestFingerprint(
      deliveryMismatch.deliveryFingerprint,
      deliveryMismatch.plan,
      { beauty: deliveryMismatch.sourceManifest.beauty, anchors: deliveryMismatch.sourceManifest.anchors },
      deliveryMismatch.sourceManifest.sourceByteLength,
    );
    const { fingerprint: _deliveryFingerprint, ...deliveryPayload } = deliveryMismatch;
    deliveryMismatch.fingerprint = canonicalJsonSha256(deliveryPayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(deliveryMismatch)).toThrow(/invalid structural shape/i);

    const sourceMismatch = JSON.parse(JSON.stringify(result.receipt)) as any;
    sourceMismatch.sourceManifest.fingerprint = "0".repeat(64);
    const { fingerprint: _sourceFingerprint, ...sourcePayload } = sourceMismatch;
    sourceMismatch.fingerprint = canonicalJsonSha256(sourcePayload);
    expect(() => assertRenderDeliveryPackageImportReceipt(sourceMismatch)).toThrow(/invalid structural shape/i);
  });

  it("leaves the output absent for a stale/hash-tampered, symlinked, or hardlinked admitted source", async () => {
    for (const mutation of ["tampered", "symlink", "hardlink"] as const) {
      const fixture = await makeFixture();
      const manifest = await admitted(fixture);
      const packageBefore = await packageBytes(fixture.sourcePackageRoot);
      const first = fixture.providerPaths[0]!;
      if (mutation === "tampered") await writeFile(first, Buffer.from("changed"));
      if (mutation === "symlink") {
        const outside = join(fixture.root, "outside.png");
        await writeFile(outside, PNG);
        await rm(first);
        await symlink(outside, first);
      }
      if (mutation === "hardlink") await link(first, join(fixture.providerRoot, "second-name.png"));
      await expect(runImport(fixture, manifest)).rejects.toThrow();
      await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(packageBytes(fixture.sourcePackageRoot)).resolves.toEqual(packageBefore);
      expect(await readdir(join(fixture.root, "package-workspace"))).toEqual(["source"]);
    }
  });

  it("refuses a malformed request before the Debug COW adapter is given any manifest", async () => {
    const fixture = await makeFixture();
    const malformed = { delivery: fixture.delivery, sources: { beauty: [{ index: 0, providerLocalPath: fixture.providerPaths[0]! }] } };
    await expect(admitMotionRenderDeliverySources(malformed, {
      providerInputRoot: fixture.providerRoot,
      providerInputRootAuthority: fixture.providerAuthority,
    })).rejects.toMatchObject({ code: "delivery_not_admitted" });
    await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a reconstructed admitted manifest before creating a transaction or output", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const reconstructed = structuredClone(manifest) as MotionRenderDeliverySourceManifest;
    await expect(runImport(fixture, reconstructed)).rejects.toMatchObject({ code: "source_identity" });
    await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses missing, lookalike, and parent-mismatched package authorities before output", async () => {
    const cases: Array<"missing" | "lookalike" | "parent"> = ["missing", "lookalike", "parent"];
    for (const kind of cases) {
      const fixture = await makeFixture();
      const manifest = await admitted(fixture);
      const authority = kind === "missing" ? undefined : kind === "lookalike"
        ? {} as Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>
        : await createTrustedWorkspaceAnchor(fixture.root);
      await expect(importAdmittedRenderDeliveryToPackage(manifest, {
        sourcePackageRoot: fixture.sourcePackageRoot,
        outputPackageRoot: fixture.outputPackageRoot,
        packageWorkspaceRoot: join(fixture.root, "package-workspace"),
        packageWorkspaceAuthority: authority,
      })).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("does not repair an immutable inventory/file collision", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const collision = manifest.sources.beauty[0]!.packagePath;
    await writeFile(join(fixture.sourcePackageRoot, "manifest.json"), JSON.stringify(packageManifest([collision]), null, 2) + "\n");
    const collisionPath = join(fixture.sourcePackageRoot, collision);
    await mkdir(dirname(collisionPath), { recursive: true });
    await writeFile(collisionPath, Buffer.from("preexisting"));

    await expect(runImport(fixture, manifest)).rejects.toThrow(/already declared/i);
    await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires the physical immutable destination leaf to be absent even when inventory omits it", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const collisionPath = join(fixture.sourcePackageRoot, manifest.sources.beauty[0]!.packagePath);
    await mkdir(dirname(collisionPath), { recursive: true });
    await writeFile(collisionPath, Buffer.from("unlisted collision"));
    await expect(runImport(fixture, manifest)).rejects.toThrow(/destination must be absent/i);
    await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back an absent output after a partial staged copy or a staged receipt collision", async () => {
    const partial = await makeFixture();
    const partialManifest = await admitted(partial);
    await expect(runImport(partial, partialManifest, {
      afterCopiedAsset: async () => { throw new Error("cancelled after partial copy"); },
    })).rejects.toThrow(/cancelled/);
    await expect(readFile(join(partial.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const receiptCollision = await makeFixture();
    const receiptManifest = await admitted(receiptCollision);
    await mkdir(join(receiptCollision.sourcePackageRoot, "receipts"), { recursive: true });
    await writeFile(join(receiptCollision.sourcePackageRoot, "receipts", "render-delivery-import.v1.json"), "untrusted old receipt\n");
    await expect(runImport(receiptCollision, receiptManifest)).rejects.toThrow();
    await expect(readFile(join(receiptCollision.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const receiptLink = await makeFixture();
    const receiptLinkManifest = await admitted(receiptLink);
    await mkdir(join(receiptLink.sourcePackageRoot, "receipts"), { recursive: true });
    await symlink(join(receiptLink.sourcePackageRoot, "motion.json"), join(receiptLink.sourcePackageRoot, "receipts", "render-delivery-import.v1.json"));
    await expect(runImport(receiptLink, receiptLinkManifest)).rejects.toThrow();
    await expect(readFile(join(receiptLink.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds distinct provider/package anchors: no target topology is acquired in provider source scope", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    const result = await runImport(fixture, manifest);
    expect(result.packageRoot).toBe(fixture.outputPackageRoot);
  });

  it("preserves a held-target failure classification through the provider authority callback", async () => {
    const fixture = await makeFixture();
    const manifest = await admitted(fixture);
    await expect(runImport(fixture, manifest, {
      beforeProviderSourceCopy: async () => { throw new PackageEditTransactionError("output_changed", "target write seam"); },
    })).rejects.toMatchObject({ code: "output_changed" });
    await expect(readFile(join(fixture.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors AbortSignal before a transaction and after a partial staged copy before output claim", async () => {
    const preAborted = await makeFixture();
    const preAbortedManifest = await admitted(preAborted);
    const preController = new AbortController();
    preController.abort();
    await expect(runImport(preAborted, preAbortedManifest, { signal: preController.signal })).rejects.toMatchObject({ code: "cancelled" });
    await expect(readFile(join(preAborted.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const partial = await makeFixture();
    const partialManifest = await admitted(partial);
    const partialController = new AbortController();
    await expect(runImport(partial, partialManifest, {
      signal: partialController.signal,
      afterCopiedAsset: async () => partialController.abort(),
    })).rejects.toMatchObject({ code: "cancelled" });
    await expect(readFile(join(partial.outputPackageRoot, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function makeFixture(): Promise<{
  root: string;
  providerRoot: string;
  providerAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>;
  packageAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>;
  providerPaths: readonly string[];
  sourcePackageRoot: string;
  outputPackageRoot: string;
  delivery: Record<string, unknown>;
  sources: { beauty: Array<{ index: number; providerLocalPath: string }> };
}> {
  const root = await scratch();
  const providerRoot = join(root, "provider-input");
  const packageRoot = join(root, "package-workspace");
  const sourcePackageRoot = join(packageRoot, "source");
  const outputPackageRoot = join(packageRoot, "output");
  await mkdir(providerRoot, { recursive: true, mode: 0o700 });
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  const providerPaths = await Promise.all([0, 1].map(async (index) => {
    const path = join(providerRoot, `${index}.png`);
    await writeFile(path, PNG);
    return path;
  }));
  await writePackage(sourcePackageRoot);
  const frames = providerPaths.map((_, index) => ({ index, sha256: sha(PNG) }));
  const rate = { numerator: 30, denominator: 1 };
  const schedule = [{ index: 0, presentationTime: { numerator: 0, denominator: 1 } }, { index: 1, presentationTime: { numerator: 1, denominator: 30 } }];
  return {
    root, providerRoot,
    providerAuthority: await createTrustedWorkspaceAnchor(providerRoot),
    packageAuthority: await createTrustedWorkspaceAnchor(packageRoot),
    providerPaths, sourcePackageRoot, outputPackageRoot,
    delivery: {
      schema: "motion.render-delivery/v1",
      provider: { id: "fixture-provider", version: "v1", capabilitySnapshotSha256: "a".repeat(64) },
      terminal: { jobId: "fixture-job", outcome: "passed", revalidation: "passed", cleanup: { state: "closed", succeeded: true } },
      identity: { sceneSha256: "b".repeat(64), shotSha256: "c".repeat(64), assetManifestSha256: "d".repeat(64), scheduleSha256: canonical({ rate, schedule }), providerReceiptSha256: "e".repeat(64) },
      conventions: { timing: "frame-index-rational-seconds", coordinates: "screen-pixel-top-left", alpha: "straight", depth: "not-provided" },
      rate, schedule,
      passes: [{ kind: "beauty", id: "beauty", format: "png", alphaMode: "straight", width: 1, height: 1, frames, frameSequenceSha256: canonical({ frames }) }],
    },
    sources: { beauty: providerPaths.map((providerLocalPath, index) => ({ index, providerLocalPath })) },
  };
}

async function makeAnchoredFixture(): Promise<{
  root: string;
  providerRoot: string;
  providerAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>;
  packageAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>;
  providerPaths: readonly string[];
  anchorPath: string;
  anchorBytes: Buffer;
  sourcePackageRoot: string;
  outputPackageRoot: string;
  delivery: Record<string, any>;
  sources: { beauty: Array<{ index: number; providerLocalPath: string }>; anchors: { providerLocalPath: string } };
}> {
  const fixture = await makeFixture();
  fixture.delivery.anchors = {
    schema: "motion.render-provider-anchor-payload/v1",
    sha256: "0".repeat(64),
    frameCount: 2,
    convention: "screen-pixel-top-left-q1024",
  };
  const payload = {
    schema: "motion.render-provider-anchor-payload/v1",
    deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(fixture.delivery as any),
    coordinateConvention: "screen-pixel-top-left-q1024",
    anchors: [{ id: 7, samples: [
      { frameIndex: 0, state: "visible", xQ1024: 0, yQ1024: 0 },
      { frameIndex: 1, state: "not-visible" },
    ] }],
  } as const;
  const anchorBytes = Buffer.from(canonicalJson(payload), "utf8");
  (fixture.delivery.anchors as { sha256: string }).sha256 = sha(anchorBytes);
  const anchorPath = join(fixture.providerRoot, "anchors.json");
  await writeFile(anchorPath, anchorBytes);
  return {
    ...fixture,
    anchorPath,
    anchorBytes,
    sources: { beauty: fixture.sources.beauty, anchors: { providerLocalPath: anchorPath } },
  };
}

async function admitted(fixture: Pick<Awaited<ReturnType<typeof makeFixture>>, "providerRoot" | "providerAuthority" | "delivery" | "sources">): Promise<MotionRenderDeliverySourceManifest> {
  return await admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, {
    providerInputRoot: fixture.providerRoot,
    providerInputRootAuthority: fixture.providerAuthority,
  });
}

async function runImport(
  fixture: Pick<Awaited<ReturnType<typeof makeFixture>>, "sourcePackageRoot" | "outputPackageRoot" | "root" | "packageAuthority">,
  manifest: MotionRenderDeliverySourceManifest,
  services: {
    signal?: AbortSignal;
    beforeProviderSourceCopy?: (asset: Readonly<{ frameIndex: number; packagePath: string }>) => Promise<void>;
    beforeProviderAnchorCopy?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
    afterCopiedAsset?: (asset: Readonly<{ frameIndex: number; packagePath: string }>) => Promise<void>;
    afterCopiedAnchor?: (asset: Readonly<{ packagePath: string }>) => Promise<void>;
  } = {},
) {
  return await importAdmittedRenderDeliveryToPackage(manifest, {
    sourcePackageRoot: fixture.sourcePackageRoot,
    outputPackageRoot: fixture.outputPackageRoot,
    packageWorkspaceRoot: join(fixture.root, "package-workspace"),
    packageWorkspaceAuthority: fixture.packageAuthority,
  }, services);
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "manifest.json"), JSON.stringify(packageManifest([]), null, 2) + "\n");
  await writeFile(join(root, "motion.json"), JSON.stringify({ schema: "shellx-motion/motion@1", id: "fixture_motion", name: "Fixture", durationMs: 1000, fps: 30, width: 1, height: 1, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }, null, 2) + "\n");
}

function packageManifest(assets: string[]) {
  return { schema: "shellx-motion/package-manifest@1", id: "fixture_package", name: "Fixture", motion: "motion.json", assets, sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } };
}

async function packageBytes(root: string): Promise<readonly Buffer[]> {
  return await Promise.all(["manifest.json", "motion.json"].map(async (name) => await readFile(join(root, name))));
}

function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { return canonicalJsonSha256(value); }
function recomputeReceiptEvidence(receipt: any): void {
  receipt.planFingerprint = canonicalJsonSha256(receipt.plan);
  receipt.sourceManifest.fingerprint = renderDeliverySourceManifestFingerprint(
    receipt.deliveryFingerprint,
    receipt.plan,
    { beauty: receipt.sourceManifest.beauty, ...(Object.prototype.hasOwnProperty.call(receipt.sourceManifest, "anchors") ? { anchors: receipt.sourceManifest.anchors } : {}) },
    receipt.sourceManifest.sourceByteLength,
  );
  const { fingerprint: _fingerprint, ...payload } = receipt;
  receipt.fingerprint = canonicalJsonSha256(payload);
}
async function scratch(): Promise<string> { const parent = resolve("../../.scratch"); await mkdir(parent, { recursive: true, mode: 0o700 }); const root = await mkdtemp(join(parent, "render-delivery-package-import-")); roots.push(root); return root; }
