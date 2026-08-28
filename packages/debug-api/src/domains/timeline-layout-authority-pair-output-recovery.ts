/** Exact installed-output lineage inspection and governed quarantine for v2 pair recovery. */
import { randomBytes } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalJsonSha256, hashBuffer, MAX_PACKAGE_SOURCE_BYTES } from "@shellx-motion/core";
import {
  readFileInsideRoot,
  stableDirectory,
} from "./timeline-layout-application-authority-store.js";

export async function expectedOutputState(value: unknown): Promise<"absent" | "exact" | "mismatch"> {
  return (await inspectExpectedOutput(value)).state;
}

export async function inspectExpectedOutput(value: unknown): Promise<{
  state: "absent" | "exact" | "mismatch";
  identityMatches: boolean;
}> {
  const expected = parseExpectedLineage(value);
  let root: Awaited<ReturnType<typeof stableDirectory>>;
  try {
    root = await stableDirectory(expected.path, "layout authority recovery output package root");
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { state: "absent", identityMatches: false }
      : { state: "mismatch", identityMatches: false };
  }
  if (root.path !== expected.path || root.dev !== expected.dev || root.ino !== expected.ino) {
    return { state: "mismatch", identityMatches: false };
  }
  try {
    const manifestBytes = await readFileInsideRoot(root.path, join(root.path, "manifest.json"), MAX_PACKAGE_SOURCE_BYTES);
    const manifest = recordValue(JSON.parse(manifestBytes.toString("utf8")), "layout authority recovery manifest");
    if (manifest.id !== expected.manifestId || typeof manifest.motion !== "string" || !manifest.motion) {
      return { state: "mismatch", identityMatches: true };
    }
    const motionBytes = await readFileInsideRoot(root.path, join(root.path, manifest.motion), MAX_PACKAGE_SOURCE_BYTES);
    const matches = hashBuffer(manifestBytes) === expected.manifestSha256
      && hashBuffer(motionBytes) === expected.motionSha256
      && canonicalJsonSha256(JSON.parse(motionBytes.toString("utf8"))) === expected.motionCanonicalSha256;
    return matches ? { state: "exact", identityMatches: true } : { state: "mismatch", identityMatches: true };
  } catch {
    return { state: "mismatch", identityMatches: true };
  }
}

/** Move only the exact COW inode into a fresh private, same-parent quarantine reservation. */
export async function quarantineExactInstalledOutput(value: unknown): Promise<string> {
  const expected = parseExpectedLineage(value);
  const root = await stableDirectory(expected.path, "layout authority recovery quarantined output");
  if (root.path !== expected.path || root.dev !== expected.dev || root.ino !== expected.ino) {
    throw new Error("Layout authority recovery cannot quarantine a replaced output lineage.");
  }
  const parent = await stableDirectory(dirname(expected.path), "layout authority recovery output parent");
  if (dirname(root.path) !== parent.path || root.dev !== parent.dev) {
    throw new Error("Layout authority recovery output escaped its governed parent.");
  }
  const reservation = await createQuarantineReservation(parent.path, basename(root.path), canonicalJsonSha256(expected));
  const target = join(reservation, "package");
  const before = await stableDirectory(expected.path, "layout authority recovery output changed before quarantine");
  if (before.dev !== expected.dev || before.ino !== expected.ino) {
    throw new Error("Layout authority recovery output changed before quarantine.");
  }
  await rename(expected.path, target);
  const [moved, parentAfter] = await Promise.all([
    stableDirectory(target, "layout authority recovery quarantined output"),
    stableDirectory(parent.path, "layout authority recovery output parent"),
  ]);
  if (moved.dev !== expected.dev || moved.ino !== expected.ino
    || parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino) {
    throw new Error("Layout authority recovery quarantine identity changed.");
  }
  return target;
}

async function createQuarantineReservation(parent: string, leaf: string, fingerprint: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = join(parent, `.${leaf}.shellx-layout-authority-quarantine-${fingerprint.slice(0, 16)}-${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      const reservation = await stableDirectory(candidate, "layout authority recovery quarantine reservation");
      if (dirname(reservation.path) !== parent) throw new Error("Layout authority recovery quarantine reservation escaped its parent.");
      return reservation.path;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Layout authority recovery could not reserve a private quarantine path.");
}

function parseExpectedLineage(value: unknown): {
  path: string; dev: number; ino: number; manifestId: string;
  manifestSha256: string; motionSha256: string; motionCanonicalSha256: string;
} {
  const record = recordValue(value, "Layout authority recovery output lineage");
  const required = ["path", "dev", "ino", "manifestId", "manifestSha256", "motionSha256", "motionCanonicalSha256"];
  if (Object.keys(record).length !== required.length || required.some((key) => !Object.hasOwn(record, key))
    || typeof record.path !== "string" || !record.path || record.path.length > 4096 || record.path.includes("\0")
    || !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino)
    || typeof record.manifestId !== "string" || !record.manifestId || record.manifestId.length > 128
    || !sha256(record.manifestSha256) || !sha256(record.motionSha256) || !sha256(record.motionCanonicalSha256)) {
    throw new Error("Layout authority recovery output lineage is malformed.");
  }
  return record as ReturnType<typeof parseExpectedLineage>;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
  return value as Record<string, unknown>;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
