/** Bounded, governed authoring of data-only procedural audio envelopes. */
import {
  canonicalJson,
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  upsertMotionProceduralAudioEnvelope,
  validateDocument,
  type MotionProceduralAudioEnvelope,
} from "@shellx-motion/core";
import { resolvePackageAudioInputs } from "@shellx-motion/connectors";
import { sampleAudioEnvelope } from "@shellx-motion/renderer-ffmpeg";
import { resolve } from "node:path";
import type { MotionDebugResult } from "../command-registry.js";
import { nonNegativeNumberArg, objectArg, stringArg } from "./args.js";
import {
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputRoot,
  AuthoringRootPolicyError,
} from "./authoring-root-policy.js";
import { commitMotionDocumentEdit, PackageEditTransactionError } from "./package-edit-transaction.js";
import {
  failure,
  invalid,
  proceduralReceipt,
  relationshipState,
  unavailable,
  type ProceduralAuthoringServices,
} from "./procedural-domain-support.js";

interface ParsedEnvelopeProducer {
  packageRoot: string;
  outDir: string;
  receiptsRoot?: string;
  createdBy?: string;
  sourceLayerId: string;
  envelopeId: string;
  sampleEveryMs: number;
  receiptInput: Record<string, unknown>;
}

/** Decode one trusted local source into a bounded, data-only RMS envelope. */
export async function produceProceduralAudioEnvelope(
  args: unknown,
  services: ProceduralAuthoringServices,
): Promise<MotionDebugResult> {
  const parsed = envelopeProducerArgs(args);
  if ("ok" in parsed) return parsed;
  if (!services.packageLoader) return unavailable("Procedural audio-envelope production is unavailable.");
  // The Debug dispatcher always supplies the caller-bound governed decoder.
  // Refuse a direct domain invocation that omits it rather than falling back to
  // a second, unattributed process-launch path.
  if (!services.ffmpegRunner) return unavailable("Governed procedural audio-envelope decoding is unavailable.");
  if (parsed.receiptsRoot && !services.writeReceipt) return unavailable("Procedural receipt persistence is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(parsed.packageRoot, services.authoringInputRoots);
    await assertConfiguredAuthoringOutputRoot(parsed.outDir, services.authoringOutputRoots);
    const pkg = await services.packageLoader(parsed.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots);
    const sourceLayer = pkg.motion.layers.find((layer) => layer.id === parsed.sourceLayerId);
    if (!sourceLayer || sourceLayer.type !== "audio") {
      throw new Error("Audio envelope sourceLayerId must identify a self-contained local audio layer.");
    }
    if (sourceLayer.muted === true) {
      throw new Error("Audio envelope sourceLayerId must identify an audible source layer.");
    }
    // Source-time conversion must be exact. The renderer can realize these controls,
    // but the producer is intentionally not allowed to approximate them into a graph.
    if (sourceLayer.trimStartMs !== undefined || sourceLayer.trimDurationMs !== undefined
      || sourceLayer.loop === true || (sourceLayer.playbackRate !== undefined && sourceLayer.playbackRate !== 1)) {
      throw new Error("Audio envelope production currently requires an untrimmed, non-looping source layer at playbackRate 1.");
    }
    const source = resolvePackageAudioInputs(pkg).find((input) => input.layerId === sourceLayer.id);
    if (!source) throw new Error("Audio envelope source must resolve to an audible local package asset.");
    const availableDurationMs = Math.min(sourceLayer.durationMs, pkg.motion.durationMs - sourceLayer.startMs);
    if (!Number.isFinite(availableDurationMs) || availableDurationMs <= 0) {
      throw new Error("Audio envelope source layer has no renderable document-time duration.");
    }
    const decoded = await sampleAudioEnvelope(source.path, {
      sampleEveryMs: parsed.sampleEveryMs,
      durationMs: availableDurationMs,
      runner: services.ffmpegRunner,
      inputRoots: [pkg.root],
    });
    const envelope: MotionProceduralAudioEnvelope = {
      id: parsed.envelopeId,
      sourceLayerId: sourceLayer.id,
      channel: "mix",
      samples: decoded.samples.map((sample) => ({
        atMs: Math.min(pkg.motion.durationMs, sourceLayer.startMs + sample.atMs),
        value: sample.value,
      })),
    };
    const edit = upsertMotionProceduralAudioEnvelope(pkg.motion, envelope);
    const validation = await validateDocument(await loadSchema("motion"), edit.motion);
    if (!validation.ok) {
      throw new Error(`Patched Motion document failed validation: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    }
    const operation = "procedural.audio-envelope.produce";
    const outputRoot = resolve(parsed.outDir);
    const state = relationshipState(edit.motion);
    const receiptFileName = "procedural-audio-envelope-produce.receipt.json";
    const envelopeEvidence = {
      id: envelope.id,
      sourceLayerId: envelope.sourceLayerId,
      channel: envelope.channel,
      sampleEveryMs: parsed.sampleEveryMs,
      sampleCount: envelope.samples.length,
      samplesSha256: hashBuffer(Buffer.from(canonicalJson(envelope.samples), "utf8")),
    };
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      // Bind the receipt to the same immutable bytes the governed FFmpeg decoder consumed.
      [`audio-source:${sourceLayer.id}`]: decoded.input.sha256,
      producer: hashBuffer(Buffer.from(canonicalJson(parsed.receiptInput), "utf8")),
    };
    const output = {
      packageRoot: outputRoot,
      changedPaths: [edit.changedPath],
      state,
      validation,
      envelope: envelopeEvidence,
      // This is genuine local-job evidence from the governed decoder only.
      // An injected runner may deliberately omit it, in which case the receipt
      // makes no resource-control claim.
      ...(decoded.resources ? { resources: decoded.resources } : {}),
      ...(parsed.createdBy ? { createdBy: parsed.createdBy } : {}),
    };
    const receipt = proceduralReceipt(operation, "audio-envelope-produce", pkg, inputHashes, output, outputRoot, receiptFileName);
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
    return {
      ok: true,
      receiptId: receipt.id,
      result: {
        ...output,
        packageId: pkg.manifest.id,
        motionPath: installed.motionPath,
        receiptPath: installed.receiptPath,
        receipt,
        ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {}),
      },
      visibleState: {
        panel: "proceduralRelationships",
        operation,
        packageId: pkg.manifest.id,
        packageRoot: outputRoot,
        changedPaths: [edit.changedPath],
        envelope: envelopeEvidence,
      },
      warnings: [],
    };
  } catch (error) {
    const code = error instanceof AuthoringRootPolicyError || error instanceof PackageEditTransactionError
      ? error.code
      : "procedural_audio_envelope_produce_failed";
    return failure(code, error);
  }
}

function envelopeProducerArgs(args: unknown): ParsedEnvelopeProducer | MotionDebugResult {
  const input = objectArg(args);
  const packageRoot = stringArg(args, "packageRoot");
  const outDir = stringArg(args, "outDir");
  const sourceLayerId = stringArg(args, "sourceLayerId") ?? stringArg(args, "sourceLayer");
  const envelopeId = stringArg(args, "envelopeId") ?? stringArg(args, "id");
  const sampleEveryMs = nonNegativeNumberArg(args, "sampleEveryMs");
  const channel = stringArg(args, "channel");
  if (!input || !packageRoot || !outDir || !sourceLayerId || !envelopeId) {
    return invalid("motion.procedural.audio-envelope.produce requires packageRoot, outDir, sourceLayerId, and envelopeId.");
  }
  if (sampleEveryMs === false || (sampleEveryMs !== null && (sampleEveryMs < 16 || sampleEveryMs > 1_000))) {
    return invalid("motion.procedural.audio-envelope.produce sampleEveryMs must be from 16 to 1000.");
  }
  if (channel !== null && channel !== "mix") {
    return invalid('motion.procedural.audio-envelope.produce currently supports channel "mix" only.');
  }
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? undefined;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  return {
    packageRoot,
    outDir,
    sourceLayerId,
    envelopeId,
    sampleEveryMs: sampleEveryMs ?? 50,
    ...(receiptsRoot ? { receiptsRoot } : {}),
    ...(createdBy ? { createdBy } : {}),
    receiptInput: Object.fromEntries(Object.entries(input).filter(([key]) => !["packageRoot", "outDir", "receiptsRoot"].includes(key))),
  };
}
