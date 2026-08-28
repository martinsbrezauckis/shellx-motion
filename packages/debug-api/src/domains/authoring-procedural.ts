/** Atomic, receipt-backed authoring for deterministic procedural relationships. */
import {
  bakeMotionProceduralRelationships,
  detachMotionProceduralRelationship,
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  setMotionProceduralRelationship,
  setMotionProceduralRelationshipEnabled,
  validateDocument,
  type MotionDocument,
  type MotionProceduralRelationship,
} from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import {
  booleanArg,
  nonNegativeNumberArg,
  objectArg,
  positiveIntegerArg,
  recordArg,
  stringArg,
  stringArrayArg,
} from "./args.js";
import { commitMotionDocumentEdit, PackageEditTransactionError } from "./package-edit-transaction.js";
import { produceProceduralAudioEnvelope } from "./procedural-audio-envelope.js";
import {
  failure,
  invalid,
  proceduralReceipt,
  relationshipState,
  unavailable,
  type ProceduralAuthoringServices,
  type ProceduralMutation,
} from "./procedural-domain-support.js";
import {
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputRoot,
  AuthoringRootPolicyError,
} from "./authoring-root-policy.js";

export type { ProceduralAuthoringServices } from "./procedural-domain-support.js";

export async function dispatchProceduralAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: ProceduralAuthoringServices,
): Promise<MotionDebugResult | null> {
  if (command === "motion.procedural.inspect") return inspect(args, services);
  if (command === "motion.procedural.audio-envelope.produce") return produceProceduralAudioEnvelope(args, services);
  if (command === "motion.procedural.relationship.set") return mutate(command, "set", args, services);
  if (command === "motion.procedural.relationship.enabled.set") return mutate(command, "enabled.set", args, services);
  if (command === "motion.procedural.relationship.bake") return mutate(command, "bake", args, services);
  if (command === "motion.procedural.relationship.detach") return mutate(command, "detach", args, services);
  return null;
}

async function inspect(args: unknown, services: ProceduralAuthoringServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  const atMs = nonNegativeNumberArg(args, "atMs");
  if (!packageRoot) return invalid("motion.procedural.inspect requires packageRoot.");
  if (atMs === false) return invalid("motion.procedural.inspect atMs must be non-negative.");
  if (!services.packageLoader) return unavailable("Procedural relationship inspection is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(packageRoot, services.authoringInputRoots);
    const pkg = await services.packageLoader(packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots);
    const state = relationshipState(pkg.motion, atMs ?? undefined);
    return {
      ok: true,
      receiptId: `procedural-inspect-${pkg.manifest.id}-${state.fingerprint?.slice(0, 16) ?? "empty"}`,
      result: { packageId: pkg.manifest.id, packageRoot: pkg.root, state },
      visibleState: { panel: "proceduralRelationships", packageId: pkg.manifest.id, state },
      warnings: [],
    };
  } catch (error) {
    return failure(error instanceof AuthoringRootPolicyError ? error.code : "procedural_inspect_failed", error);
  }
}

async function mutate(
  command: MotionDebugCommand,
  mutation: ProceduralMutation,
  args: unknown,
  services: ProceduralAuthoringServices,
): Promise<MotionDebugResult> {
  const parsed = mutationArgs(command, mutation, args);
  if ("ok" in parsed) return parsed;
  if (!services.packageLoader) return unavailable("Atomic procedural relationship editing is unavailable.");
  if (parsed.receiptsRoot && !services.writeReceipt) return unavailable("Procedural receipt persistence is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(parsed.packageRoot, services.authoringInputRoots);
    await assertConfiguredAuthoringOutputRoot(parsed.outDir, services.authoringOutputRoots);
    const pkg = await services.packageLoader(parsed.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots);
    const edit = applyMutation(pkg.motion, mutation, parsed);
    const validation = await validateDocument(await loadSchema("motion"), edit.motion);
    if (!validation.ok) {
      throw new Error(`Patched Motion document failed validation: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    }
    const operation = `procedural.relationship.${mutation}`;
    const outputRoot = resolve(parsed.outDir);
    const state = relationshipState(edit.motion);
    const receiptFileName = `procedural-relationship-${mutation.replace(".", "-")}.receipt.json`;
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      mutation: hashBuffer(Buffer.from(JSON.stringify({ operation, args: parsed.receiptInput }), "utf8")),
    };
    const output = {
      packageRoot: outputRoot,
      changedPaths: edit.changedPaths,
      state,
      validation,
      ...(edit.bake ? { bake: edit.bake } : {}),
      ...(parsed.createdBy ? { createdBy: parsed.createdBy } : {}),
    };
    const receipt = proceduralReceipt(operation, mutation, pkg, inputHashes, output, outputRoot, receiptFileName);
    await assertConfiguredAuthoringOutputRoot(outputRoot, services.authoringOutputRoots);
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot,
      authoringInputRoots: services.authoringInputRoots!,
      authoringOutputRoots: services.authoringOutputRoots!,
      patchedMotion: edit.motion,
      receipt,
      receiptFileName,
      ...(parsed.receiptsRoot ? { receiptsRoot: parsed.receiptsRoot, writeHostReceipt: services.writeReceipt! } : {}),
    });
    const result = {
      ...output,
      packageId: pkg.manifest.id,
      motionPath: installed.motionPath,
      receiptPath: installed.receiptPath,
      receipt,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
    };
    return {
      ok: true,
      receiptId: receipt.id,
      result,
      visibleState: {
        panel: "proceduralRelationships",
        operation,
        packageId: pkg.manifest.id,
        packageRoot: outputRoot,
        changedPaths: edit.changedPaths,
        state,
      },
      warnings: [],
    };
  } catch (error) {
    const code = error instanceof AuthoringRootPolicyError || error instanceof PackageEditTransactionError
      ? error.code
      : `procedural_relationship_${mutation.replace(".", "_")}_failed`;
    return failure(code, error);
  }
}

interface ParsedMutation {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
  relationship?: Record<string, unknown>;
  relationshipId?: string;
  enabled?: boolean;
  relationshipIds?: string[];
  startMs?: number;
  endMs?: number;
  sampleEveryFrames?: number;
  receiptInput: Record<string, unknown>;
}

function mutationArgs(command: string, mutation: ProceduralMutation, args: unknown): ParsedMutation | MotionDebugResult {
  const input = objectArg(args);
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  if (!input || !packageRoot) return invalid(`${command} requires packageRoot.`);
  if (!outDir) return invalid(`${command} requires outDir.`);
  const relationship = recordArg(args, "relationship") ?? undefined;
  const relationshipId = stringArg(args, "relationshipId") ?? undefined;
  const enabled = booleanArg(args, "enabled") ?? undefined;
  const relationshipIds = stringArrayArg(args, "relationshipIds") ?? undefined;
  const startMs = nonNegativeNumberArg(args, "startMs");
  const endMs = nonNegativeNumberArg(args, "endMs");
  const sampleEveryFrames = positiveIntegerArg(args, "sampleEveryFrames");
  if (mutation === "set" && !relationship) return invalid(`${command} requires relationship.`);
  if ((mutation === "enabled.set" || mutation === "detach") && !relationshipId) return invalid(`${command} requires relationshipId.`);
  if (mutation === "enabled.set" && enabled === undefined) return invalid(`${command} requires boolean enabled.`);
  if (Object.hasOwn(input, "relationshipIds") && !relationshipIds) return invalid(`${command} relationshipIds must be a string array.`);
  if (relationshipIds?.length === 0) return invalid(`${command} relationshipIds must not be empty.`);
  if (startMs === false || endMs === false) return invalid(`${command} bake times must be non-negative.`);
  if (sampleEveryFrames === false) return invalid(`${command} sampleEveryFrames must be a positive integer.`);
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? undefined;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const receiptInput = Object.fromEntries(Object.entries(input).filter(([key]) => !["packageRoot", "outDir", "receiptsRoot"].includes(key)));
  return {
    packageRoot,
    outDir,
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(relationship ? { relationship } : {}),
    ...(relationshipId ? { relationshipId } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(relationshipIds ? { relationshipIds } : {}),
    ...(typeof startMs === "number" ? { startMs } : {}),
    ...(typeof endMs === "number" ? { endMs } : {}),
    ...(typeof sampleEveryFrames === "number" ? { sampleEveryFrames } : {}),
    receiptInput,
  };
}

function applyMutation(motion: MotionDocument, mutation: ProceduralMutation, args: ParsedMutation) {
  if (mutation === "set") {
    const result = setMotionProceduralRelationship(motion, structuredClone(args.relationship) as unknown as MotionProceduralRelationship);
    return { motion: result.motion, changedPaths: [result.changedPath] };
  }
  if (mutation === "enabled.set") {
    const result = setMotionProceduralRelationshipEnabled(motion, args.relationshipId!, args.enabled!);
    return { motion: result.motion, changedPaths: [result.changedPath] };
  }
  if (mutation === "detach") {
    const result = detachMotionProceduralRelationship(motion, args.relationshipId!);
    return { motion: result.motion, changedPaths: [result.changedPath] };
  }
  const baked = bakeMotionProceduralRelationships(motion, {
    ...(args.relationshipIds ? { relationshipIds: args.relationshipIds } : {}),
    ...(args.startMs !== undefined ? { startMs: args.startMs } : {}),
    ...(args.endMs !== undefined ? { endMs: args.endMs } : {}),
    ...(args.sampleEveryFrames !== undefined ? { sampleEveryFrames: args.sampleEveryFrames } : {}),
  });
  return {
    motion: baked.motion,
    changedPaths: baked.changedPaths,
    bake: {
      relationshipIds: baked.relationshipIds,
      sampleCount: baked.sampleCount,
      keyframeCount: baked.keyframeCount,
      fingerprint: baked.fingerprint,
    },
  };
}
