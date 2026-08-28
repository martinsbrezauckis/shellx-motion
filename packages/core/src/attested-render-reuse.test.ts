import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attestArtifactReceipt,
  attestedRenderReuseCacheKey,
  createAttestedArtifactHandle,
  deriveAttestedRenderPackageFingerprint,
  createAttestedRenderReuseDescriptor,
  hashBuffer,
  readAttestedRenderReuseDescriptor,
  verifyAttestedRenderReuse,
  writeAttestedRenderReuseDescriptor,
  type AttestedRenderReuseInputs,
  type AttestedRenderReusePlan,
  type OperationReceipt,
} from "./index";

const tempRoots: string[] = [];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gJ+41Xk4QAAAABJRU5ErkJggg==", "base64");

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("attested render reuse descriptor v2", () => {
  it("binds the exact plan, bounded inputs, source receipt, and output bytes", async () => {
    const fixture = await reusableArtifact();
    const verified = await verifyAttestedRenderReuse({
      root: fixture.root,
      descriptorPath: fixture.descriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs
    });

    expect(verified.descriptor).toMatchObject({ schema: "shellx-motion/attested-render-reuse@2", cacheKey: fixture.key });
    expect(verified.artifact.path).toBe(await realpath(fixture.outputPath));
    await expect(verifyAttestedRenderReuse({
      root: fixture.root,
      descriptorPath: fixture.descriptorPath,
      plan: { ...fixture.plan, preset: "jpeg-frame" },
      inputs: fixture.inputs
    })).rejects.toThrow(/does not bind the current render request/);
  });

  it("fails closed for a descriptor whose bytes or self-bound id were changed", async () => {
    const fixture = await reusableArtifact();
    const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8")) as Record<string, unknown>;
    descriptor.createdAt = "2026-08-09T00:00:01.000Z";
    await writeFile(fixture.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(readAttestedRenderReuseDescriptor(fixture.descriptorPath)).rejects.toThrow(/does not bind its contents/);
  });

  it("uses exclusive publication and never replaces an existing descriptor during a fill race", async () => {
    const fixture = await reusableArtifact();
    const descriptor = await readAttestedRenderReuseDescriptor(fixture.descriptorPath);
    const before = await readFile(fixture.descriptorPath, "utf8");

    await expect(writeAttestedRenderReuseDescriptor({ root: fixture.root, descriptorPath: fixture.descriptorPath, descriptor })).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(fixture.descriptorPath, "utf8")).resolves.toBe(before);
  });

  it("preserves a descriptor path through an OS-level root alias", async () => {
    const fixture = await reusableArtifact();
    const descriptor = await readAttestedRenderReuseDescriptor(fixture.descriptorPath);
    await unlink(fixture.descriptorPath);
    const aliasRoot = `${fixture.root}-alias`;
    await symlink(fixture.root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    tempRoots.push(aliasRoot);
    const aliasedDescriptorPath = join(aliasRoot, relative(fixture.root, fixture.descriptorPath));

    await writeAttestedRenderReuseDescriptor({ root: aliasRoot, descriptorPath: aliasedDescriptorPath, descriptor });
    const verified = await verifyAttestedRenderReuse({
      root: aliasRoot,
      descriptorPath: aliasedDescriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs,
    });

    expect(verified.descriptor.id).toBe(descriptor.id);
    expect(verified.artifact.path).toBe(await realpath(fixture.outputPath));
  });

  it("refuses cross-root descriptor access", async () => {
    const fixture = await reusableArtifact();
    const alternateRoot = await mkdtemp(join(tmpdir(), "shellx-motion-reuse-other-root-"));
    tempRoots.push(alternateRoot);
    await expect(verifyAttestedRenderReuse({
      root: alternateRoot,
      descriptorPath: fixture.descriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs
    })).rejects.toThrow(/escapes its root/);
  });

  it.skipIf(process.platform === "win32")("refuses an output symlink", async () => {
    const fixture = await reusableArtifact();
    const externalOutput = join(fixture.root, "external-output.png");
    await writeFile(externalOutput, PNG);
    await unlink(fixture.outputPath);
    await symlink(externalOutput, fixture.outputPath, "file");
    await expect(verifyAttestedRenderReuse({
      root: fixture.root,
      descriptorPath: fixture.descriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs
    })).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("refuses a source-receipt symlink even when its bytes match the original", async () => {
    const fixture = await reusableArtifact();
    const receiptPath = join(fixture.root, "render-source.receipt.json");
    const externalReceipt = join(fixture.root, "external-source.receipt.json");
    await writeFile(externalReceipt, await readFile(receiptPath));
    await unlink(receiptPath);
    await symlink(externalReceipt, receiptPath, "file");

    await expect(verifyAttestedRenderReuse({
      root: fixture.root,
      descriptorPath: fixture.descriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs
    })).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("refuses a descriptor symlink before parsing its target", async () => {
    const fixture = await reusableArtifact();
    const externalDescriptor = join(fixture.root, "external-descriptor.json");
    await writeFile(externalDescriptor, await readFile(fixture.descriptorPath));
    await unlink(fixture.descriptorPath);
    await symlink(externalDescriptor, fixture.descriptorPath, "file");

    await expect(verifyAttestedRenderReuse({
      root: fixture.root,
      descriptorPath: fixture.descriptorPath,
      plan: fixture.plan,
      inputs: fixture.inputs
    })).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic link while fingerprinting the current package bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-reuse-package-link-"));
    tempRoots.push(root);
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}\n", "utf8");
    await symlink(outside, join(root, "linked-input.json"), "file");

    await expect(deriveAttestedRenderPackageFingerprint(root)).rejects.toThrow(/symbolic link/);
  });
});

async function reusableArtifact(): Promise<{
  root: string;
  outputPath: string;
  descriptorPath: string;
  key: string;
  plan: AttestedRenderReusePlan;
  inputs: AttestedRenderReuseInputs;
}> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-reuse-core-"));
  tempRoots.push(root);
  const outputPath = join(root, "frame.png");
  await writeFile(outputPath, PNG);
  const inputs: AttestedRenderReuseInputs = {
    schema: "shellx-motion/attested-render-inputs@2",
    packageSha256: "a".repeat(64),
    workflowSha256: "b".repeat(64)
  };
  const plan: AttestedRenderReusePlan = {
    schema: "shellx-motion/attested-render-plan@2",
    outputRootRelativePath: "frame.png",
    preset: "png-frame",
    frameLane: "browser",
    engineVersion: "0.1.0",
    workflow: "inline",
    qualityManifest: false
  };
  const key = attestedRenderReuseCacheKey(plan, inputs);
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: "render-source",
    operation: "render.final",
    status: "passed",
    packageId: "pkg_reuse",
    inputHashes: { attestedRenderReuse: key },
    createdAt: "2026-08-09T00:00:00.000Z",
    lane: "image",
    output: { path: outputPath, sha256: hashBuffer(PNG), preset: "png-frame" },
    warnings: []
  };
  const receiptPath = join(root, "render-source.receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const sourceReceipt = await attestArtifactReceipt(root, receiptPath, "render");
  const artifact = await createAttestedArtifactHandle({
    root,
    artifactPath: outputPath,
    packageId: "pkg_reuse",
    motionId: "motion_reuse",
    operationHash: key,
    preset: "png-frame",
    mediaType: "image/png",
    receipts: [sourceReceipt],
    createdAt: receipt.createdAt,
    probe: false
  });
  const descriptor = createAttestedRenderReuseDescriptor({ plan, inputs, artifact, sourceReceipt, createdAt: receipt.createdAt });
  const descriptorPath = join(root, ".shellx-motion", "render-reuse", "v2", `${key}.json`);
  await writeAttestedRenderReuseDescriptor({ root, descriptorPath, descriptor });
  return { root, outputPath, descriptorPath, key, plan, inputs };
}
