import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { attachRenderedMediaToCutPlan, planCutImport } from "@shellx-motion/adapters-cut";
import {
  createAttestedArtifactHandleReference,
  hashBuffer,
  hashFile,
  type AttestedArtifactHandle,
  type AttestedArtifactHandleReference,
  type MotionPackage,
} from "@shellx-motion/core";
import type { MotionSdkRenderResponse } from "./types.js";

export async function ensureSdkCutHandoff(input: {
  artifactRoot: string;
  descriptorPath: string;
  handle: AttestedArtifactHandle;
  pkg: MotionPackage;
  operationHash: string;
}): Promise<{
  reference: AttestedArtifactHandleReference;
  handoff: NonNullable<MotionSdkRenderResponse["cutHandoff"]>;
}> {
  const descriptorRelativePath = relative(resolve(input.artifactRoot), resolve(input.descriptorPath)).split(sep).join("/");
  const reference = createAttestedArtifactHandleReference(
    input.handle,
    descriptorRelativePath,
    await hashFile(input.descriptorPath),
  );
  const planPath = join(input.artifactRoot, ".shellx-motion", "cut", `${input.operationHash}.cut-import-plan.json`);
  await assertWritablePathInsideRoot(input.artifactRoot, planPath);
  let verifiedPlan: { value: unknown; sha256: string };
  try {
    verifiedPlan = await readStableJsonNoFollow(input.artifactRoot, planPath, "SDK Cut handoff plan", 4 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const expected = expectedSdkCutPlan(input.pkg, reference);
    await writeJsonExclusive(planPath, expected);
    verifiedPlan = await readStableJsonNoFollow(input.artifactRoot, planPath, "SDK Cut handoff plan", 4 * 1024 * 1024);
  }
  verifySdkCutPlan(verifiedPlan.value, input.pkg, reference);
  return {
    reference,
    handoff: {
      schema: "shellx-motion/cut-handoff@1",
      target: "shellx-cut",
      mode: "rendered_media",
      path: planPath,
      sha256: verifiedPlan.sha256,
      packageId: input.pkg.manifest.id,
      motionId: input.pkg.motion.id,
      artifactHandleId: input.handle.id,
    },
  };
}

export function verifySdkCutPlan(
  value: unknown,
  pkg: MotionPackage,
  reference: AttestedArtifactHandleReference,
): void {
  const plan = plainDataRecord(value, "SDK Cut handoff plan");
  const receipt = plainDataRecord(plan.receipt, "SDK Cut handoff receipt");
  if (typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))) {
    throw new Error("SDK Cut handoff receipt createdAt is invalid.");
  }
  const expected = expectedSdkCutPlan(pkg, reference);
  const normalizedActual = { ...plan, receipt: { ...receipt, createdAt: "<verified>" } };
  const normalizedExpected = { ...expected, receipt: { ...expected.receipt, createdAt: "<verified>" } };
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error("SDK Cut handoff plan operation/receipt does not exactly match the render artifact.");
  }
}

function expectedSdkCutPlan(pkg: MotionPackage, reference: AttestedArtifactHandleReference) {
  return attachRenderedMediaToCutPlan(planCutImport(pkg, {
    targetId: "shellx-cut",
    modes: ["rendered_media"],
    lowerableLayerTypes: [],
  }), { dryRun: false, handle: reference });
}

async function readStableJsonNoFollow(
  root: string,
  path: string,
  label: string,
  maxBytes: number,
): Promise<{ value: unknown; sha256: string }> {
  const [canonicalRoot, canonicalPath, before] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
  if (!inside(canonicalRoot, canonicalPath) || !before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
    throw new Error(`${label} must be a bounded canonical regular file inside its root.`);
  }
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  let openedBefore: Stats;
  let openedAfter: Stats;
  try {
    openedBefore = await handle.stat();
    if (!openedBefore.isFile() || openedBefore.size > maxBytes) throw new Error(`${label} must be a bounded regular file.`);
    bytes = await handle.readFile();
    openedAfter = await handle.stat();
  } finally {
    await handle.close();
  }
  const after = await lstat(canonicalPath);
  if (!sameFile(before, openedBefore) || !stable(openedBefore, openedAfter) || !stable(openedAfter, after)) {
    throw new Error(`${label} changed while it was being verified.`);
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), sha256: hashBuffer(bytes) };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

async function assertWritablePathInsideRoot(root: string, path: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(dirname(path))]);
  if (!inside(canonicalRoot, canonicalParent)) throw new Error("Cut handoff must be inside artifactRoot.");
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must contain only own data properties.`);
  }
  return value as Record<string, unknown>;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stable(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
