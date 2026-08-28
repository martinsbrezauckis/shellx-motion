import { dirname } from "node:path";
import type { CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import { hashBuffer, readBoundedStableFile } from "@shellx-motion/core";
import type { ConnectorArtifact } from "./artifacts";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { createPrivateConnectorDelivery } from "./connector-delivery";
import { resolveConnectorPath } from "./path-utils";
import { assertP2BExternalInput, assertP2BLinuxBeforeInput, P2B_MAX_MEDIA_BYTES } from "./p2b-connector-delivery";
import { materializeP2BScriptToCut } from "./script-to-cut-materializer";

/** P2B public input: real Browser-to-FFmpeg rendered media only. */
export interface ScriptToCutConnectorInput {
  /** Exactly one of scriptPath or script is required. Inline data is never persisted at a caller path. */
  scriptPath?: string;
  script?: unknown;
  outDir: string;
  cutPlacement?: CutRenderedMediaPlacement;
  /** Coordinator-owned cancellation for this private P2B delivery. */
  signal?: AbortSignal;
  /** Explicit compatibility spelling; only real rendered media is accepted. */
  cutImportMode?: "rendered_media";
}

export interface ScriptToCutConnectorResult {
  ok: true;
  packageDir: string;
  preview: { ok: true; lane: "browser"; failureFatal: false; receiptPath: string; outputPath: string };
  render: { ok: true; required: true; dryRun: false; lane: "ffmpeg"; frameLane: "browser"; receiptPath: string; outputPath: string };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runScriptToCutConnector(input: ScriptToCutConnectorInput): Promise<ScriptToCutConnectorResult> {
  throwIfConnectorAborted(input.signal, "before Script-to-Cut admission");
  assertP2BLinuxBeforeInput();
  assertP2BScriptLegacyFields(input);
  const outDir = resolveConnectorPath(input.outDir);
  const externalScriptPath = typeof input.scriptPath === "string" && input.scriptPath.length > 0
    ? resolveConnectorPath(input.scriptPath)
    : undefined;
  if (externalScriptPath) assertP2BExternalInput(outDir, externalScriptPath, "Script-to-Cut input");
  const scriptInput = await readP2BScriptInput(input);
  throwIfConnectorAborted(input.signal, "after Script-to-Cut input admission");
  const delivery = await createPrivateConnectorDelivery(outDir);
  try {
    const materialized = await materializeP2BScriptToCut({
      delivery,
      outDir,
      script: scriptInput.script,
      inputEvidence: { label: scriptInput.label, sha256: hashBuffer(scriptInput.bytes), byteLength: scriptInput.bytes.byteLength },
      externalInputPaths: externalScriptPath ? [externalScriptPath] : [],
      signal: input.signal,
      ...(input.cutPlacement ? { cutPlacement: input.cutPlacement } : {})
    });
    throwIfConnectorAborted(input.signal, "after Script-to-Cut materialization and before delivery commit");
    await delivery.commit(materialized.expectedInventory);
    return materialized.result;
  } catch (error) {
    await delivery.abort();
    throw error;
  }
}

async function readP2BScriptInput(input: ScriptToCutConnectorInput): Promise<{ label: string; bytes: Buffer; script: unknown }> {
  const hasPath = typeof input.scriptPath === "string" && input.scriptPath.length > 0;
  const hasInline = input.script !== undefined;
  if (hasPath === hasInline) throw new Error("Script-to-Cut requires exactly one input source: scriptPath or inline script.");
  if (hasInline) {
    // Serialize exactly once: callers can supply accessors or mutate their object after admission.
    // The parsed owned bytes, never the caller object, are the sole converter input.
    const encoded = JSON.stringify(input.script);
    if (typeof encoded !== "string") throw new Error("Script-to-Cut inline script must have a defined JSON encoding.");
    const bytes = Buffer.from(`${encoded}\n`, "utf8");
    if (bytes.byteLength > P2B_MAX_MEDIA_BYTES) throw new Error("Script-to-Cut inline script exceeds P2B's 64MiB input limit.");
    try {
      return { label: "inline-scripted-video.json", bytes, script: JSON.parse(encoded) };
    } catch (error) {
      throw new Error(`Script-to-Cut inline script is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const path = resolveConnectorPath(input.scriptPath!);
  const source = await readBoundedStableFile(path, { label: "Scripted-video input", maxBytes: P2B_MAX_MEDIA_BYTES, withinRoot: dirname(path), requireSingleLink: true });
  try {
    return { label: "scripted-video.json", bytes: source.bytes, script: JSON.parse(source.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`Scripted-video input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertP2BScriptLegacyFields(input: ScriptToCutConnectorInput): void {
  const legacy = input as ScriptToCutConnectorInput & Record<string, unknown>;
  if (legacy.cutImportMode !== undefined && legacy.cutImportMode !== "rendered_media") throw new Error("Script-to-Cut P2B accepted delivery refuses legacy cutImportMode other than rendered_media.");
  const rejected = ["force", "previewLane", "renderLane", "frameLane", "dryRunRender", "receiptOperation", "streamingRenderer", "ffmpegRunner", "now"]
    .find((key) => legacy[key] !== undefined);
  if (rejected) throw new Error(`Script-to-Cut P2B accepted delivery does not support legacy ${rejected}; it always produces real Browser-preview and Browser-frame-to-FFmpeg rendered_media.`);
}
