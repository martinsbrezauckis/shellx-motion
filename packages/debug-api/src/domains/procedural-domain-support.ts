/** Shared data-only services and receipt helpers for bounded procedural authoring domains. */
import {
  canonicalJson,
  evaluateMotionProceduralLayers,
  hashBuffer,
  proceduralRelationshipGraphFingerprint,
  validateMotionProceduralGraph,
  type MotionDocument,
  type MotionPackage,
  type OperationReceipt,
} from "@shellx-motion/core";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { join } from "node:path";
import type { MotionDebugResult } from "../command-registry.js";

export interface ProceduralAuthoringServices {
  receiptsRoot?: string;
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  /** Host-injected, shell-free FFmpeg runner for bounded local envelope decoding. */
  ffmpegRunner?: FfmpegRunner;
}

export type ProceduralMutation = "set" | "enabled.set" | "bake" | "detach";

export function relationshipState(motion: MotionDocument, atMs?: number) {
  const graph = motion.relationships ? structuredClone(motion.relationships) : null;
  const validation = graph ? validateMotionProceduralGraph(graph, motion) : null;
  const relationships = graph?.relationships.map((relationship) => ({
    id: relationship.id,
    enabled: relationship.enabled,
    target: structuredClone(relationship.target),
    sources: relationship.nodes
      .filter((node) => node.type === "property")
      .map((node) => structuredClone(node.ref)),
    audioEnvelopeIds: relationship.nodes
      .filter((node) => node.type === "audio-envelope")
      .map((node) => node.envelopeId),
    nodeCount: relationship.nodes.length,
    outputNodeId: relationship.outputNodeId,
  })) ?? [];
  const fingerprint = graph ? proceduralRelationshipGraphFingerprint(graph) : null;
  const evaluation = graph && atMs !== undefined
    ? { atMs, values: evaluateMotionProceduralLayers(motion, atMs).values }
    : null;
  return { graph, relationships, validation, fingerprint, evaluation };
}

export function proceduralReceipt(
  operation: string,
  mutation: ProceduralMutation | "audio-envelope-produce",
  pkg: MotionPackage,
  inputHashes: Record<string, string>,
  output: Record<string, unknown>,
  outputRoot: string,
  receiptFileName: string,
): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `procedural-${mutation.replace(".", "-")}-${hashBuffer(Buffer.from(canonicalJson({ packageId: pkg.manifest.id, inputHashes }), "utf8")).slice(0, 16)}`,
    operation,
    status: "passed",
    packageId: pkg.manifest.id,
    inputHashes,
    createdAt: new Date().toISOString(),
    lane: "debug-api",
    output,
    artifacts: [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      {
        role: mutation === "audio-envelope-produce" ? "procedural_audio_envelope_receipt" : "procedural_relationship_receipt",
        path: join(outputRoot, "receipts", receiptFileName),
        status: "available",
        mediaType: "application/json"
      },
    ],
    warnings: [],
  };
}

export function invalid(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

export function unavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] };
}

export function failure(code: string, error: unknown): MotionDebugResult {
  return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] };
}
