import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EffectModuleRegistryError,
  MAX_EFFECT_MODULE_ENTRIES,
  createEffectModuleRegistryAuthority,
  parseEffectModuleManifest,
  safeEffectModuleVersion
} from "./effect-module-registry.js";
import { assertEffectModuleRegistryRoot } from "./effect-module-private-fs.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const base = join(resolve(process.cwd(), "../.."), ".scratch", "effect-module-registry-tests");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, prefix));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

function manifest(version = "1.0.0", displayName = "Afterimage Stack"): string {
  return `${JSON.stringify({
    schema: "shellx-motion/effect-module-manifest@1",
    moduleId: "motion.afterimage-stack",
    version,
    displayName,
    intrinsic: "motion.afterimage-stack.v1",
    rendererAbi: "shellx-motion/gpu-effect-module@1",
    parameterSchema: "motion.afterimage-stack.parameters@1"
  })}\n`;
}

async function setup(): Promise<{ stateRoot: string; source: string }> {
  const root = await temporaryRoot("shellx-motion-effect-module-");
  const stateRoot = join(root, "effect-modules");
  await mkdir(stateRoot, { mode: 0o700 });
  const source = join(root, "afterimage.json");
  await writeFile(source, manifest(), { mode: 0o600 });
  return { stateRoot, source };
}

function testSourceReader(): (path: string) => Promise<{ bytes: Buffer; sha256: string }> {
  return async (path) => {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("test source reader refused symbolic link");
    const bytes = await readFile(path);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("C1 private effect-module registry", () => {
  it("shares Core's bounded canonical SemVer parser across manifest and registry entry routes", async () => {
    const accepted = ["1.2.3", "1.2.3-rc.1", "1.2.3-0"];
    const rejected = ["v1.2.3", "1.2.3+build", "latest", "^1.2.3", "1.2.3-01", "1.2.3-rc.01", `1.2.3-${"a".repeat(128)}`];
    for (const version of accepted) {
      expect(safeEffectModuleVersion(version), version).toBe(true);
      expect(parseEffectModuleManifest(Buffer.from(manifest(version), "utf8")).version, version).toBe(version);
    }
    for (const version of rejected) {
      expect(safeEffectModuleVersion(version), version).toBe(false);
      expect(() => parseEffectModuleManifest(Buffer.from(manifest(version), "utf8")), version).toThrow(/unsupported closed C1 fields/i);
    }
    const { stateRoot, source } = await setup();
    await writeFile(source, manifest(`1.2.3-${"a".repeat(128)}`), { mode: 0o600 });
    const authority = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader() });
    await expect(authority.prepareInstallFromManifestFile(source)).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("rejects malformed UTF-8 and duplicate closed-manifest keys before assigning meaning", () => {
    const malformed = Buffer.from(manifest(), "utf8");
    const displayNameOffset = malformed.indexOf(Buffer.from("Afterimage Stack", "utf8"));
    expect(displayNameOffset).toBeGreaterThanOrEqual(0);
    malformed[displayNameOffset] = 0xff;
    expect(() => parseEffectModuleManifest(malformed)).toThrow(/valid UTF-8 JSON with no duplicate/i);

    const bomPrefixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(manifest(), "utf8")]);
    expect(() => parseEffectModuleManifest(bomPrefixed)).toThrow(/valid UTF-8 JSON with no duplicate/i);

    const duplicate = Buffer.from(`{"schema":"shellx-motion/effect-module-manifest@1","moduleId":"motion.afterimage-stack","version":"1.0.0","displayName":"First name","displayName":"Second name","intrinsic":"motion.afterimage-stack.v1","rendererAbi":"shellx-motion/gpu-effect-module@1","parameterSchema":"motion.afterimage-stack.parameters@1"}`, "utf8");
    expect(() => parseEffectModuleManifest(duplicate)).toThrow(/valid UTF-8 JSON with no duplicate/i);
  });

  it("freezes a source once, makes confirmation one-shot, and returns an opaque idempotent lease", async () => {
    const { stateRoot, source } = await setup();
    const authority = createEffectModuleRegistryAuthority({ stateRoot, now: () => new Date("2026-08-15T00:00:00.000Z"), readManifestFileForTest: testSourceReader() });
    const pending = await authority.prepareInstallFromManifestFile(source);
    await writeFile(source, manifest("1.0.0", "Source swapped after picker"));

    const installed = await authority.confirmInstall(pending.confirmationId);
    expect(installed).toMatchObject({ idempotent: false, generation: 1, entry: { displayName: "Afterimage Stack" } });
    await expect(authority.confirmInstall(pending.confirmationId)).rejects.toMatchObject({ code: "pending_not_found" });

    const lease = await authority.beginUse("motion.afterimage-stack", "1.0.0");
    expect(lease.registryEntrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await lease.release()).toEqual({ released: true });
    expect(await lease.release()).toEqual({ released: false });
  });

  it("refuses source and private-root symlinks without adopting them", async ({ skip }) => {
    const { stateRoot, source } = await setup();
    let readerCalled = false;
    const authority = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async () => { readerCalled = true; return await testSourceReader()(source); } });
    const linkedSource = `${source}.link`;
    try {
      await symlink(source, linkedSource, process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The Windows test account cannot create symbolic links.");
        return;
      }
      throw error;
    }
    await expect(authority.prepareInstallFromManifestFile(linkedSource)).rejects.toBeInstanceOf(Error);
    expect(readerCalled).toBe(false);

    const linkedRoot = `${stateRoot}.link`;
    await symlink(stateRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(createEffectModuleRegistryAuthority({ stateRoot: linkedRoot }).list()).rejects.toMatchObject({ code: "private_state_invalid" });
  });

  it("serializes same-byte concurrent confirmation, preserves immutable conflicts, and keeps revoked versions revoked", async () => {
    const { stateRoot, source } = await setup();
    const authority = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader() });
    const [first, second] = await Promise.all([
      authority.prepareInstallFromManifestFile(source),
      authority.prepareInstallFromManifestFile(source)
    ]);
    const answers = await Promise.all([
      authority.confirmInstall(first.confirmationId),
      authority.confirmInstall(second.confirmationId)
    ]);
    expect(answers.map((answer) => answer.idempotent).sort()).toEqual([false, true]);
    expect((await authority.revoke("motion.afterimage-stack", "1.0.0")).changed).toBe(true);
    await expect(authority.beginUse("motion.afterimage-stack", "1.0.0")).rejects.toMatchObject({ code: "revoked" });

    await writeFile(source, manifest("1.0.0", "Different immutable bytes"));
    const replacement = await authority.prepareInstallFromManifestFile(source);
    await expect(authority.confirmInstall(replacement.confirmationId)).rejects.toMatchObject({ code: "immutable_conflict" });

    const same = await authority.prepareInstallFromManifestFile(join(stateRoot, "blobs", `${answers[0]!.entry.manifestSha256}.json`));
    const sameResult = await authority.confirmInstall(same.confirmationId);
    expect(sameResult.entry.revokedAt).toBeDefined();
    expect(sameResult.idempotent).toBe(true);
  });

  it("retains root object identity when legitimate lock-entry churn changes only directory metadata", async () => {
    const { stateRoot } = await setup();
    const transient = join(stateRoot, ".registry.lock");
    await expect(assertEffectModuleRegistryRoot(stateRoot, async () => {
      await writeFile(transient, "lock\n", { mode: 0o600 });
      await rm(transient);
    })).resolves.toBe(stateRoot);
  });

  it("refuses replacement of the registry root object at the same path", async () => {
    const { stateRoot } = await setup();
    await expect(assertEffectModuleRegistryRoot(stateRoot, async () => {
      await rm(stateRoot, { recursive: true });
      await mkdir(stateRoot, { mode: 0o700 });
    })).rejects.toMatchObject({ code: "private_state_changed" });
  });

  it.runIf(process.platform !== "win32")("rechecks private root permissions after the admission race window", async () => {
    const { stateRoot } = await setup();
    await expect(assertEffectModuleRegistryRoot(stateRoot, async () => {
      await chmod(stateRoot, 0o777);
    })).rejects.toMatchObject({ code: "private_state_changed" });
  });

  it("bounds installed versions and never lets revocation create capacity", async () => {
    const { stateRoot, source } = await setup();
    const authority = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader() });
    for (let index = 0; index < MAX_EFFECT_MODULE_ENTRIES; index += 1) {
      await writeFile(source, manifest(`1.0.${index}`));
      const pending = await authority.prepareInstallFromManifestFile(source);
      await authority.confirmInstall(pending.confirmationId);
    }
    await authority.revoke("motion.afterimage-stack", "1.0.0");
    await writeFile(source, manifest("1.1.0"));
    const pending = await authority.prepareInstallFromManifestFile(source);
    await expect(authority.confirmInstall(pending.confirmationId)).rejects.toMatchObject({ code: "capacity_exceeded" });
  });

  it("drops expired and cancelled pending bytes, and ignores crash-orphan staging on restart", async () => {
    const { stateRoot, source } = await setup();
    let milliseconds = 0;
    const authority = createEffectModuleRegistryAuthority({ stateRoot, now: () => new Date(milliseconds), pendingTtlMs: 1, readManifestFileForTest: testSourceReader() });
    const expired = await authority.prepareInstallFromManifestFile(source);
    milliseconds = 2;
    await expect(authority.confirmInstall(expired.confirmationId)).rejects.toMatchObject({ code: "pending_not_found" });
    const pending = await authority.prepareInstallFromManifestFile(source);
    expect(await authority.cancelInstall(pending.confirmationId)).toEqual({ cancelled: true });
    expect(await authority.cancelInstall(pending.confirmationId)).toEqual({ cancelled: false });

    const paths = join(stateRoot, "staging");
    await writeFile(join(paths, ".candidate-00000000-0000-4000-8000-000000000000.json"), manifest());
    const restarted = createEffectModuleRegistryAuthority({ stateRoot });
    expect(await restarted.list()).toEqual([]);
  });

  it("publishes only a complete generation after injected blob-publication failure", async () => {
    const { stateRoot, source } = await setup();
    const authority = createEffectModuleRegistryAuthority({
      stateRoot,
      readManifestFileForTest: testSourceReader(),
      faults: { afterBlobPublished: () => { throw new Error("simulated power interruption"); } }
    });
    const pending = await authority.prepareInstallFromManifestFile(source);
    await expect(authority.confirmInstall(pending.confirmationId)).rejects.toThrow("simulated power interruption");
    expect(await createEffectModuleRegistryAuthority({ stateRoot }).list()).toEqual([]);
  });

  it("does not overwrite a blob inserted after its target absence check", async () => {
    const { stateRoot, source } = await setup();
    const expectedSha256 = createHash("sha256").update(manifest()).digest("hex");
    const foreign = Buffer.from("foreign immutable blob", "utf8");
    const authority = createEffectModuleRegistryAuthority({
      stateRoot,
      readManifestFileForTest: testSourceReader(),
      faults: {
        afterBlobTargetAbsenceCheck: async () => {
          await writeFile(join(stateRoot, "blobs", `${expectedSha256}.json`), foreign, { mode: 0o600 });
        }
      }
    });
    const pending = await authority.prepareInstallFromManifestFile(source);
    await expect(authority.confirmInstall(pending.confirmationId)).rejects.toMatchObject({ code: "private_state_changed" });
    expect(await readFile(join(stateRoot, "blobs", `${expectedSha256}.json`))).toEqual(foreign);
  });

  it("does not overwrite a generation inserted after its target absence check", async () => {
    const { stateRoot, source } = await setup();
    const foreign = Buffer.from("foreign immutable generation", "utf8");
    const authority = createEffectModuleRegistryAuthority({
      stateRoot,
      readManifestFileForTest: testSourceReader(),
      faults: {
        afterGenerationTargetAbsenceCheck: async () => {
          await writeFile(join(stateRoot, "generations", "generation-000000000001.json"), foreign, { mode: 0o600 });
        }
      }
    });
    const pending = await authority.prepareInstallFromManifestFile(source);
    await expect(authority.confirmInstall(pending.confirmationId)).rejects.toMatchObject({ code: "private_state_changed" });
    expect(await readFile(join(stateRoot, "generations", "generation-000000000001.json"))).toEqual(foreign);
  });

  it("keeps immutable old-or-new generations across publication faults and refuses a missing referenced blob", async () => {
    const { stateRoot, source } = await setup();
    const before = createEffectModuleRegistryAuthority({
      stateRoot, readManifestFileForTest: testSourceReader(),
      faults: { beforeRegistryPublish: () => { throw new Error("before generation publish"); } }
    });
    const beforePending = await before.prepareInstallFromManifestFile(source);
    await expect(before.confirmInstall(beforePending.confirmationId)).rejects.toThrow("before generation publish");
    expect(await createEffectModuleRegistryAuthority({ stateRoot }).list()).toEqual([]);

    const after = createEffectModuleRegistryAuthority({
      stateRoot, readManifestFileForTest: testSourceReader(),
      faults: { afterRegistryPublish: () => { throw new Error("after generation publish"); } }
    });
    const afterPending = await after.prepareInstallFromManifestFile(source);
    await expect(after.confirmInstall(afterPending.confirmationId)).rejects.toThrow("after generation publish");
    const persisted = await createEffectModuleRegistryAuthority({ stateRoot }).list();
    expect(persisted).toHaveLength(1);

    const revokeBefore = createEffectModuleRegistryAuthority({
      stateRoot, faults: { beforeRegistryPublish: () => { throw new Error("before revoke publish"); } }
    });
    await expect(revokeBefore.revoke("motion.afterimage-stack", "1.0.0")).rejects.toThrow("before revoke publish");
    expect((await createEffectModuleRegistryAuthority({ stateRoot }).inspect("motion.afterimage-stack", "1.0.0"))?.revokedAt).toBeUndefined();

    const hash = persisted[0]!.manifestSha256;
    await rm(join(stateRoot, "blobs", `${hash}.json`));
    await expect(createEffectModuleRegistryAuthority({ stateRoot }).list()).rejects.toMatchObject({ code: "private_state_changed" });
  });

  it("does not let a second live authority clean a fresh pending candidate, and close cancels its own pending bytes", async () => {
    const { stateRoot, source } = await setup();
    const first = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader(), pendingTtlMs: 60_000 });
    const pending = await first.prepareInstallFromManifestFile(source);
    const second = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader(), pendingTtlMs: 60_000 });
    expect(await second.list()).toEqual([]);
    expect((await first.confirmInstall(pending.confirmationId)).idempotent).toBe(false);

    const later = await first.prepareInstallFromManifestFile(source);
    expect(await first.close()).toEqual({ closed: true, cancelledPending: 1 });
    await expect(first.confirmInstall(later.confirmationId)).rejects.toMatchObject({ code: "closed" });
    expect(await first.close()).toEqual({ closed: false, cancelledPending: 0 });
  });

  it("fails closed on a newer visible malformed generation instead of falling back to an older state", async () => {
    const { stateRoot, source } = await setup();
    const authority = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: testSourceReader() });
    const pending = await authority.prepareInstallFromManifestFile(source);
    await authority.confirmInstall(pending.confirmationId);
    await writeFile(join(stateRoot, "generations", "generation-000000000002.json"), "{not-json", { mode: 0o600 });
    await expect(createEffectModuleRegistryAuthority({ stateRoot }).list()).rejects.toMatchObject({ code: "private_state_invalid" });
  });

  it("refuses a non-private pre-created registry root", async () => {
    const { stateRoot } = await setup();
    if (process.platform === "win32") return;
    await chmod(stateRoot, 0o755);
    await expect(createEffectModuleRegistryAuthority({ stateRoot }).list()).rejects.toBeInstanceOf(EffectModuleRegistryError);
  });
});
