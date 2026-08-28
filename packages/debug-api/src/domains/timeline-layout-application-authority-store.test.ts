import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, canonicalJsonSha256, hashBuffer } from "@shellx-motion/core";
import { describe, expect, it } from "vitest";
import {
  discoverInterruptedLayoutAuthorityPairs,
  prepareImmutableJsonPair,
  readImmutableJsonPair,
  repairInterruptedImmutableJsonPairForTrustedHost,
  trustedAuthorityDirectory,
  writeImmutableJsonPair,
} from "./timeline-layout-application-authority-store.js";
import {
  acquirePairWriterLock,
} from "./timeline-layout-authority-pair-files.js";
import { pairPaths } from "./timeline-layout-authority-pair-records.js";
import { createHostLayoutAuthorityPairRepair } from "../internal/layout-authority-repair.js";

const key = "layout-authority-pair-test";

describe("timeline layout authority pair journal", () => {
  it.each(["receipt", "authority", "journal"] as const)("rolls back every transaction-created member when %s link admission fails", async (failedStep) => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      await expect(writeImmutableJsonPair(directory, descriptor(directory, {
        beforeCommitStep(step) {
          if (step === failedStep) throw new Error(`inject ${step} link failure`);
        },
      }))).rejects.toThrow(`inject ${failedStep} link failure`);
      expect(await readdir(directory.path)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["receipt", "authority"] as const)("rolls back exactly after the %s member link hook fails", async (failedStep) => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-after-link-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      await expect(writeImmutableJsonPair(directory, descriptor(directory, {
        afterMemberLink(step) {
          if (step === failedStep) throw new Error(`inject ${step} post-link failure`);
        },
      }))).rejects.toThrow(`inject ${failedStep} post-link failure`);
      expect(await readdir(directory.path)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up all proven state when an after-unlink observation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-after-unlink-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      await expect(writeImmutableJsonPair(directory, descriptor(directory, {
        beforeCommitStep(step) {
          if (step === "authority") throw new Error("inject authority link failure");
        },
        afterRollbackUnlink(step) {
          if (step === "receipt") throw new Error("inject receipt post-unlink failure");
        },
      }))).rejects.toThrow("inject receipt post-unlink failure");
      expect(await readdir(directory.path)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits only a final journal and recovers an exact inert pre-journal pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-recover-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPair(directory, input);
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(repairInterruptedImmutableJsonPairForTrustedHost(
        directory,
        readDescriptor(input),
      )).resolves.toBe(true);
      expect(await readdir(directory.path)).toEqual([]);

      await expect(writeImmutableJsonPair(directory, input)).resolves.toContain(`${key}.pair.json`);
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).resolves.toMatchObject({
        recordKind: "layout-application",
        receipt: { id: "receipt" },
        authority: { id: "authority" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["lock creation", 0],
    ["pending creation", 1],
    ["receipt stage write", 2],
    ["authority stage write", 3],
    ["journal stage write", 4],
    ["receipt link", 5],
    ["authority link", 6],
  ] as const)("retries an interrupted prefix after %s through the normal host writer", async (_point, prefix) => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-prefix-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPrefix(directory, input, prefix);

      await expect(repairInterruptedImmutableJsonPairForTrustedHost(
        directory,
        readDescriptor(input),
      )).resolves.toBe(true);
      await expect(writeImmutableJsonPair(directory, input)).resolves.toContain(`${key}.pair.json`);
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).resolves.toMatchObject({
        recordKind: "layout-application",
        receipt: { id: "receipt" },
        authority: { id: "authority" },
      });
      expect(await readdir(directory.path)).toEqual([
        `${key}.authority.json`,
        `${key}.pair.json`,
        `${key}.receipt.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the trusted-host quiescent repair seam before an ordinary writer can retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-no-auto-repair-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPrefix(directory, input, 2);
      const before = await readdir(directory.path);

      await expect(writeImmutableJsonPair(directory, input)).rejects.toThrow(/host writer lock/i);
      expect(await readdir(directory.path)).toEqual(before);
      await expect(repairInterruptedImmutableJsonPairForTrustedHost(
        directory,
        readDescriptor(input),
      )).resolves.toBe(true);
      await expect(writeImmutableJsonPair(directory, input)).resolves.toContain(`${key}.pair.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never runs a fallible hook after final journal admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-journal-final-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const linked: string[] = [];
      await expect(writeImmutableJsonPair(directory, descriptor(directory, {
        afterMemberLink(step) {
          linked.push(step);
        },
      }))).resolves.toContain(`${key}.pair.json`);
      expect(linked).toEqual(["receipt", "authority"]);
      await expect(readImmutableJsonPair(directory, readDescriptor(descriptor(directory)))).resolves.toMatchObject({
        recordKind: "layout-application",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams retained successful history before capping only interrupted v2 prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-discovery-history-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      for (let index = 0; index < 41; index += 1) {
        const input = descriptor(directory, undefined, `accepted-history-${index}`);
        await expect(writeImmutableJsonPair(directory, input)).resolves.toContain(`${input.key}.pair.json`);
      }
      // Each accepted record converges to receipt, authority, and journal. Discovery must validate
      // final journals before interrupted-candidate accounting rather than rejecting normal history.
      await expect(discoverInterruptedLayoutAuthorityPairs(directory)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advances the opaque repair cursor through more than one page to a trailing interrupted prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-paged-repair-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      for (let index = 0; index < 45; index += 1) {
        await writeImmutableJsonPair(directory, descriptor(directory, undefined, `accepted-page-${index}`));
      }
      const interrupted = descriptor(directory);
      await seedInterruptedPrefix(directory, interrupted, 2);
      const repair = createHostLayoutAuthorityPairRepair(root);
      const actions: Array<{ key: string; action: string }> = [];
      let complete = false;
      for (let page = 0; page < 8 && !complete; page += 1) {
        const result = await repair.repairNextPage();
        actions.push(...result.actions);
        complete = result.complete;
      }
      expect(complete).toBe(true);
      expect(actions).toEqual([{ key: interrupted.key, action: "reclaimed_preinstall_prefix" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let inspection consume the opaque repair cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-inspect-repair-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPrefix(directory, input, 2);
      const repair = createHostLayoutAuthorityPairRepair(root);
      await expect(repair.inspectNextPage()).resolves.toMatchObject({
        pairs: [expect.objectContaining({ key: input.key, state: "prepared_no_output" })],
      });
      await expect(repair.repairNextPage()).resolves.toEqual({
        actions: [{ key: input.key, action: "reclaimed_preinstall_prefix" }], complete: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a live independent-process root repair contender without consuming its repair page, then allows crash takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-repair-gate-"));
    let release: (() => Promise<void>) | undefined;
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPrefix(directory, input, 2);
      const gatePath = join(directory.path, ".pair.repair.lock");
      const gate = canonicalJson({
        schema: "shellx-motion/timeline-layout-authority-pair-repair-gate@1",
        receiptsRoot: directory.root,
        nonce: "0".repeat(32),
      });
      release = await holdIndependentProcessLock(gatePath, gate, true);
      const repair = createHostLayoutAuthorityPairRepair(root);
      const before = await readdir(directory.path);
      await expect(repair.repairNextPage()).rejects.toThrow(/host repair is already active/i);
      expect(await readdir(directory.path)).toEqual(before);
      await release();
      release = undefined;
      await expect(repair.repairNextPageAfterHostCrash()).resolves.toEqual({
        actions: [{ key: input.key, action: "reclaimed_preinstall_prefix" }], complete: true,
      });
      await expect(readdir(directory.path)).resolves.toEqual([]);
    } finally {
      await release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps interrupted candidates across the complete opaque repair scan, not only one page", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-paged-cap-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      for (let index = 0; index < 16; index += 1) {
        await seedInterruptedPrefix(directory, descriptor(directory, undefined, `first-${index}`), 2);
      }
      for (let index = 0; index < 40; index += 1) {
        await writeImmutableJsonPair(directory, descriptor(directory, undefined, `accepted-cap-${index}`));
      }
      for (let index = 0; index < 17; index += 1) {
        await seedInterruptedPrefix(directory, descriptor(directory, undefined, `second-${index}`), 2);
      }
      const repair = createHostLayoutAuthorityPairRepair(root);
      await expect(repair.repairNextPage()).resolves.toMatchObject({ complete: false });
      await expect(repair.repairNextPage()).rejects.toThrow(/bounded interrupted-pair cap/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converges accepted residual preparation evidence to the three final files on later host maintenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-residual-maintenance-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPair(directory, input);
      const paths = pairPaths(directory, input.key);
      await link(paths.journalStagePath, paths.journalPath);
      await rm(paths.lockPath);
      expect(await readdir(directory.path)).toHaveLength(7);
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).resolves.toMatchObject({
        recordKind: "layout-application",
      });
      const repair = createHostLayoutAuthorityPairRepair(root);
      await expect(repair.repairNextPage()).resolves.toEqual({ actions: [], complete: true });
      await expect(readdir(directory.path)).resolves.toEqual([
        `${input.key}.authority.json`, `${input.key}.pair.json`, `${input.key}.receipt.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finalizes the exact installed v2 prefix through the installed host repair surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-installed-repair-"));
    try {
      const output = join(root, "installed-output");
      await mkdir(output, { recursive: true });
      const manifest = Buffer.from(JSON.stringify({ id: "installed-repair-package", motion: "motion.json" }), "utf8");
      const motion = Buffer.from(JSON.stringify({ layers: [] }), "utf8");
      await writeFile(join(output, "manifest.json"), manifest);
      await writeFile(join(output, "motion.json"), motion);
      const outputStat = await stat(output);
      const outputLineage = {
        path: output,
        dev: outputStat.dev,
        ino: outputStat.ino,
        manifestId: "installed-repair-package",
        manifestSha256: hashBuffer(manifest),
        motionSha256: hashBuffer(motion),
        motionCanonicalSha256: canonicalJsonSha256(JSON.parse(motion.toString("utf8"))),
      };
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory, undefined, "installed-repair-pair", outputLineage);
      await prepareImmutableJsonPair(directory, input);

      const repair = createHostLayoutAuthorityPairRepair(root);
      await expect(repair.repairNextPage()).resolves.toEqual({
        actions: [{ key: input.key, action: "finalized_installed_output" }],
        complete: true,
      });
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).resolves.toMatchObject({
        recordKind: "layout-application",
        receipt: { id: "receipt" },
        authority: { id: "authority" },
      });
      await expect(readdir(directory.path)).resolves.toEqual([
        `${input.key}.authority.json`, `${input.key}.pair.json`, `${input.key}.receipt.json`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a separate host lock contender rather than reclaiming its live prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-concurrent-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      let releaseFirst: (() => void) | undefined;
      const firstReady = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let entered: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = writeImmutableJsonPair(directory, descriptor(directory, {
        async beforeCommitStep(step) {
          if (step !== "receipt") return;
          entered?.();
          await firstReady;
        },
      }));
      await firstEntered;
      expect(await readdir(directory.path)).toContain(`.${key}.pair.lock`);
      await expect(writeImmutableJsonPair(directory, input)).rejects.toThrow(/host writer lock/i);
      releaseFirst?.();
      await expect(first).resolves.toContain(`${key}.pair.json`);
      const names = await readdir(directory.path);
      expect(names).toContain(`${key}.pair.json`);
      await expect(readImmutableJsonPair(directory, readDescriptor(input))).resolves.toMatchObject({ recordKind: "layout-application" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an independent-process lock contender without publishing pair members", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-process-lock-"));
    let release: (() => Promise<void>) | undefined;
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const lockPath = join(directory.path, `.${key}.pair.lock`);
      release = await holdIndependentProcessLock(lockPath);

      await expect(writeImmutableJsonPair(directory, descriptor(directory))).rejects.toThrow(/host writer lock/i);
      expect(await readdir(directory.path)).toEqual([`.${key}.pair.lock`]);
      await release();
      release = undefined;
      await expect(writeImmutableJsonPair(directory, descriptor(directory))).resolves.toContain(`${key}.pair.json`);
    } finally {
      await release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the pair lock through journal admission so a contender only refuses", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-journal-race-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      let releaseFirst: (() => void) | undefined;
      const firstReady = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let entered: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const first = writeImmutableJsonPair(directory, descriptor(directory, {
        async beforeJournalAdmissionLink() {
          entered?.();
          await firstReady;
        },
      }));
      await firstEntered;
      const before = await readdir(directory.path);

      await expect(writeImmutableJsonPair(directory, input)).rejects.toThrow(/host writer lock/i);
      expect(await readdir(directory.path)).toEqual(before);
      releaseFirst?.();
      await expect(first).resolves.toContain(`${key}.pair.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an unproven pre-journal hard-link set untouched during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-competing-recovery-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPair(directory, input);
      const receiptStage = join(directory.path, `.${key}.receipt.stage`);
      const extraLink = join(directory.path, ".unproven-receipt-link");
      await link(receiptStage, extraLink);
      await expect(repairInterruptedImmutableJsonPairForTrustedHost(
        directory,
        readDescriptor(input),
      )).rejects.toThrow(/exclusive member ownership/i);
      expect(await readdir(directory.path)).toEqual(expect.arrayContaining([
        `${key}.receipt.json`,
        `${key}.authority.json`,
        `.${key}.receipt.stage`,
        `.${key}.authority.stage`,
        `.${key}.pair.pending`,
        ".unproven-receipt-link",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates every interrupted member before leaving a foreign replacement untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-authority-pair-foreign-prefix-"));
    try {
      const directory = await trustedAuthorityDirectory(root, true);
      const input = descriptor(directory);
      await seedInterruptedPrefix(directory, input, 2);
      const receiptStage = join(directory.path, `.${key}.receipt.stage`);
      const authorityStage = join(directory.path, `.${key}.authority.stage`);
      const receiptBefore = await readFile(receiptStage, "utf8");
      await writeFile(authorityStage, canonicalJson({ foreign: true }), { mode: 0o600 });

      await expect(repairInterruptedImmutableJsonPairForTrustedHost(
        directory,
        readDescriptor(input),
      )).rejects.toThrow(/stage hash is stale/i);
      await expect(readFile(receiptStage, "utf8")).resolves.toBe(receiptBefore);
      await expect(readFile(authorityStage, "utf8")).resolves.toBe(canonicalJson({ foreign: true }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function descriptor(
  directory: Awaited<ReturnType<typeof trustedAuthorityDirectory>>,
  hooks?: Parameters<typeof writeImmutableJsonPair>[1]["hooks"],
  keyOverride = key,
  outputLineageOverride?: unknown,
) {
  const outputLineage = outputLineageOverride ?? {
    path: join(directory.path, `never-installed-${keyOverride}`),
    dev: 7,
    ino: 9,
    manifestId: "never-installed-package",
    manifestSha256: "a".repeat(64),
    motionSha256: "b".repeat(64),
    motionCanonicalSha256: "c".repeat(64),
  };
  return {
    key: keyOverride,
    recordKind: "layout-application",
    outputLineage,
    receipt: { id: "receipt", output: "one" },
    receiptMaximumBytes: 1024,
    authority: { id: "authority", receiptsRoot: directory.root },
    authorityMaximumBytes: 1024,
    ...(hooks ? { hooks } : {}),
  };
}

function readDescriptor(input: ReturnType<typeof descriptor>) {
  return {
    key: input.key,
    recordKinds: [input.recordKind],
    outputLineage: input.outputLineage,
    receiptMaximumBytes: input.receiptMaximumBytes,
    authorityMaximumBytes: input.authorityMaximumBytes,
  };
}

async function seedInterruptedPair(
  directory: Awaited<ReturnType<typeof trustedAuthorityDirectory>>,
  input: ReturnType<typeof descriptor>,
): Promise<void> {
  await seedInterruptedPrefix(directory, input, 6);
  const paths = pairPaths(directory, input.key);
  const receiptStage = paths.receiptStagePath;
  const authorityStage = paths.authorityStagePath;
  expect((await stat(receiptStage)).nlink).toBe(2);
  expect((await stat(authorityStage)).nlink).toBe(2);
}

/** Prefix 0 is lock-only; 6 is the complete pre-journal linked prefix. */
async function seedInterruptedPrefix(
  directory: Awaited<ReturnType<typeof trustedAuthorityDirectory>>,
  input: ReturnType<typeof descriptor>,
  prefix: 0 | 1 | 2 | 3 | 4 | 5 | 6,
): Promise<void> {
  const paths = pairPaths(directory, input.key);
  await acquirePairWriterLock(directory, paths, input.key);
  const receiptBytes = Buffer.from(canonicalJson(input.receipt), "utf8");
  const authorityBytes = Buffer.from(canonicalJson(input.authority), "utf8");
  const receiptName = paths.receiptName;
  const authorityName = paths.authorityName;
  const pending = {
    schema: "shellx-motion/timeline-layout-authority-pair-pending@2",
    key: input.key,
    recordKind: input.recordKind,
    receiptsRoot: directory.root,
    outputLineage: input.outputLineage,
    outputLineageSha256: canonicalJsonSha256(input.outputLineage),
    receipt: { basename: receiptName, sha256: canonicalJsonSha256(input.receipt) },
    authority: { basename: authorityName, sha256: canonicalJsonSha256(input.authority) },
  };
  const receiptStage = paths.receiptStagePath;
  const authorityStage = paths.authorityStagePath;
  if (prefix < 1) return;
  await writeFile(paths.pendingPath, canonicalJson({ ...pending }), { mode: 0o600 });
  if (prefix < 2) return;
  await writeFile(receiptStage, receiptBytes, { mode: 0o600 });
  if (prefix < 3) return;
  await writeFile(authorityStage, authorityBytes, { mode: 0o600 });
  if (prefix < 4) return;
  await writeFile(
    paths.journalStagePath,
    canonicalJson({ ...pending, schema: "shellx-motion/timeline-layout-authority-pair@2" }),
    { mode: 0o600 },
  );
  if (prefix < 5) return;
  await link(receiptStage, join(directory.path, receiptName));
  if (prefix < 6) return;
  await link(authorityStage, join(directory.path, authorityName));
}

async function holdIndependentProcessLock(
  path: string,
  contents = "lock",
  retainOnExit = false,
): Promise<() => Promise<void>> {
  const source = [
    "const fs = require('node:fs');",
    "const path = process.argv[1]; const contents = process.argv[2]; const retain = process.argv[3] === 'retain';",
    "fs.open(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600, (error, descriptor) => {",
    "  if (error) { process.stderr.write(String(error)); process.exit(1); }",
    "  fs.writeSync(descriptor, contents); fs.closeSync(descriptor); process.stdout.write('ready\\n');",
    "  const release = () => { if (!retain) { try { fs.unlinkSync(path); } catch {} } process.exit(0); };",
    "  process.on('SIGTERM', release); process.on('SIGINT', release); setInterval(() => {}, 1000);",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source, path, contents, retainOnExit ? "retain" : "remove"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stderr.once("data", (chunk: Buffer) => reject(new Error(chunk.toString("utf8"))));
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString("utf8") === "ready\n") resolve();
      else reject(new Error("Independent authority-lock contender did not become ready."));
    });
    child.once("exit", (code) => reject(new Error(`Independent authority-lock contender exited (${code}).`)));
  });
  return async () => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };
}
