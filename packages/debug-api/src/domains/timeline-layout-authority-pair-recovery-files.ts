/** Exact no-follow inspection and reclamation of inert authority-pair write prefixes. */
import { lstat, unlink } from "node:fs/promises";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { readRegularFile } from "./timeline-layout-application-authority-store.js";
import type {
  InterruptedPairMember,
  PairMember,
} from "./timeline-layout-authority-pair-files.js";
import type { PairPaths } from "./timeline-layout-authority-pair-records.js";

/**
 * Validate every possible interrupted write prefix before deleting any member. States are:
 * absent (0), private stage (1), and exact stage/final hard-link pair (2).
 */
export async function inspectInterruptedPairPrefix(input: {
  receipt: Omit<InterruptedPairMember, "state">;
  authority: Omit<InterruptedPairMember, "state">;
  journal: Omit<InterruptedPairMember, "state">;
}): Promise<readonly InterruptedPairMember[]> {
  const members = await Promise.all([
    inspectInterruptedMember(input.receipt),
    inspectInterruptedMember(input.authority),
    inspectInterruptedMember(input.journal),
  ]);
  const states = members.map((member) => member.state).join(",");
  if (!new Set(["0,0,0", "1,0,0", "1,1,0", "1,1,1", "2,1,1", "2,2,1"]).has(states)) {
    throw new Error("Layout authority pair recovery found an impossible or concurrent write prefix.");
  }
  return members;
}

export async function reclaimInterruptedPairPrefix(
  members: readonly InterruptedPairMember[],
): Promise<void> {
  for (const member of [...members].reverse()) {
    if (member.state === 2) {
      await reclaimLinkedMember(member);
    } else if (member.state === 1) {
      const stage = await readRequiredStage(member.stagePath, member.maximumBytes, "member");
      if (jsonSha256(stage) !== member.sha256) {
        throw new Error("Layout authority pair recovery stage hash is stale.");
      }
      await unlinkExact(member.stagePath, stage, member.maximumBytes, 1);
    }
  }
}

export async function assertRecoveredPairMembersAbsent(paths: PairPaths): Promise<void> {
  for (const path of [
    paths.receiptPath,
    paths.authorityPath,
    paths.journalPath,
    paths.receiptStagePath,
    paths.authorityStagePath,
    paths.journalStagePath,
  ]) {
    await lstat(path).then(
      () => {
        throw new Error("Layout authority pair recovery found a concurrent or competing member.");
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}

/** The pending journal is private only after every stage/final member was proven absent. */
export async function cleanupRecoveredPending(
  path: string,
  expected: Buffer,
  maximumBytes: number,
): Promise<void> {
  await unlinkExact(path, expected, maximumBytes, 1);
}

export async function unlinkExact(
  path: string,
  expected: Buffer,
  maximumBytes: number,
  expectedNlink: number,
): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== expectedNlink
    || !(await readRegularFile(path, maximumBytes)).equals(expected)) {
    throw new Error("Layout authority pair cleanup cannot prove exclusive member ownership.");
  }
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== expectedNlink) {
    throw new Error("Layout authority pair cleanup target changed.");
  }
  await unlink(path);
}

export async function unlinkLinkedExact(
  member: Pick<PairMember, "finalPath" | "stagePath" | "bytes" | "maximumBytes">,
): Promise<void> {
  const [finalStat, stageStat] = await Promise.all([
    lstat(member.finalPath),
    lstat(member.stagePath),
  ]);
  if (!finalStat.isFile()
    || finalStat.isSymbolicLink()
    || !stageStat.isFile()
    || stageStat.isSymbolicLink()
    || finalStat.dev !== stageStat.dev
    || finalStat.ino !== stageStat.ino
    || finalStat.nlink !== 2
    || stageStat.nlink !== 2) {
    throw new Error("Layout authority pair rollback cannot prove exclusive member ownership.");
  }
  if (!(await readRegularFile(member.finalPath, member.maximumBytes)).equals(member.bytes)) {
    throw new Error("Layout authority pair rollback found a changed member.");
  }
  const [finalAfter, stageAfter] = await Promise.all([
    lstat(member.finalPath),
    lstat(member.stagePath),
  ]);
  if (finalAfter.dev !== finalStat.dev
    || finalAfter.ino !== finalStat.ino
    || finalAfter.nlink !== 2
    || stageAfter.dev !== stageStat.dev
    || stageAfter.ino !== stageStat.ino
    || stageAfter.nlink !== 2) {
    throw new Error("Layout authority pair rollback member changed before unlink.");
  }
  await unlink(member.finalPath);
}

/**
 * A valid final journal is immutable admission. These files are only redundant preparation
 * evidence; exact identity checks ensure best-effort removal can never roll back the admitted
 * receipt or authority member.
 */
export async function cleanupAdmittedPairEvidence(input: {
  pendingPath: string;
  pending: Buffer;
  receipt: Pick<PairMember, "finalPath" | "stagePath" | "bytes" | "maximumBytes">;
  authority: Pick<PairMember, "finalPath" | "stagePath" | "bytes" | "maximumBytes">;
  journal: Pick<PairMember, "finalPath" | "stagePath" | "bytes" | "maximumBytes">;
}): Promise<void> {
  let problem: unknown;
  for (const cleanup of [
    async () => await unlinkAdmittedLinkedStage(input.receipt),
    async () => await unlinkAdmittedLinkedStage(input.authority),
    async () => await unlinkAdmittedLinkedStage(input.journal),
    async () => await unlinkExact(input.pendingPath, input.pending, 24 * 1024, 1),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      problem ??= error;
    }
  }
  if (problem) throw problem;
}

async function unlinkAdmittedLinkedStage(
  member: Pick<PairMember, "finalPath" | "stagePath" | "bytes" | "maximumBytes">,
): Promise<void> {
  const [finalStat, stageStat] = await Promise.all([
    lstat(member.finalPath),
    lstat(member.stagePath),
  ]);
  if (!finalStat.isFile()
    || finalStat.isSymbolicLink()
    || !stageStat.isFile()
    || stageStat.isSymbolicLink()
    || finalStat.dev !== stageStat.dev
    || finalStat.ino !== stageStat.ino
    || finalStat.nlink !== 2
    || stageStat.nlink !== 2
    || !(await readRegularFile(member.finalPath, member.maximumBytes)).equals(member.bytes)) {
    throw new Error("Layout authority admitted pair cleanup cannot prove redundant stage ownership.");
  }
  const [finalAfter, stageAfter] = await Promise.all([
    lstat(member.finalPath),
    lstat(member.stagePath),
  ]);
  if (finalAfter.dev !== finalStat.dev
    || finalAfter.ino !== finalStat.ino
    || finalAfter.nlink !== 2
    || stageAfter.dev !== stageStat.dev
    || stageAfter.ino !== stageStat.ino
    || stageAfter.nlink !== 2) {
    throw new Error("Layout authority admitted pair stage changed before cleanup.");
  }
  await unlink(member.stagePath);
}

async function reclaimLinkedMember(member: InterruptedPairMember): Promise<void> {
  const stage = await readRequiredStage(member.stagePath, member.maximumBytes, "member");
  if (jsonSha256(stage) !== member.sha256) {
    throw new Error("Layout authority pair recovery stage hash is stale.");
  }
  await unlinkLinkedExact({
    finalPath: member.finalPath,
    stagePath: member.stagePath,
    bytes: stage,
    maximumBytes: member.maximumBytes,
  });
  await unlinkExact(member.stagePath, stage, member.maximumBytes, 1);
}

async function readRequiredStage(
  path: string,
  maximumBytes: number,
  label: "member" | "journal",
): Promise<Buffer> {
  try {
    return await readRegularFile(path, maximumBytes);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Layout authority pair recovery found an incomplete ${label} stage.`);
    }
    throw error;
  }
}

async function inspectInterruptedMember(
  member: Omit<InterruptedPairMember, "state">,
): Promise<InterruptedPairMember> {
  const stage = await lstat(member.stagePath).catch(missing);
  const final = await lstat(member.finalPath).catch(missing);
  if (!stage && !final) return { ...member, state: 0 };
  if (!stage || (!final && stage.nlink !== 1)) {
    throw new Error("Layout authority pair recovery cannot prove a private staged member.");
  }
  if (!stage.isFile() || stage.isSymbolicLink()) {
    throw new Error("Layout authority pair recovery stage is not a regular file.");
  }
  const bytes = await readRegularFile(member.stagePath, member.maximumBytes);
  if (jsonSha256(bytes) !== member.sha256) {
    throw new Error("Layout authority pair recovery stage hash is stale.");
  }
  if (!final) return { ...member, state: 1 };
  if (!final.isFile()
    || final.isSymbolicLink()
    || stage.dev !== final.dev
    || stage.ino !== final.ino
    || stage.nlink !== 2
    || final.nlink !== 2
    || jsonSha256(await readRegularFile(member.finalPath, member.maximumBytes)) !== member.sha256) {
    throw new Error("Layout authority pair recovery cannot prove exclusive member ownership.");
  }
  return { ...member, state: 2 };
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT") return null;
  throw error;
}

function jsonSha256(bytes: Buffer): string {
  try {
    return canonicalJsonSha256(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("Layout authority pair recovery stage is not valid JSON.");
  }
}
