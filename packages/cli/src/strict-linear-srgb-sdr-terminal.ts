import { dirname } from "node:path";
import { bindFinalRenderReceiptLineage } from "@shellx-motion/core";
import {
  abortStrictSdrCandidateHeldPair,
  closeStrictSdrCandidateHeldWorkspace,
  commitStrictSdrCandidateHeldPair,
  currentStrictSdrCandidateHeldWorkspace,
  openStrictSdrCandidateHeldPair,
  stageStrictSdrCandidateFinalReceipt,
  strictSdrCandidateOutputPublication,
  strictSdrCandidateTerminalBinding,
  withStrictSdrCandidateHeldPairRendering,
  type StrictSdrCandidateHeldPair,
} from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import { recordReceiptFfprobeProvenance } from "@shellx-motion/debug-api";
import {
  renderStreamingFinal,
  type RenderStreamingFinalInput,
} from "@shellx-motion/renderer-ffmpeg";
import { PairedOutputReceiptCommitUncertainError, PairedOutputReceiptPublication } from "./paired-output-receipt-publication";
import { pairedPublicationUncertaintyError, pairedPublicationUncertaintyFields } from "./cli-publication-uncertainty";
import {
  abortPreparedRenderCatalog,
  commitPreparedRenderCatalog,
  prepareRenderReceipt,
  renderReceiptPathForOutput,
  writeRenderReceiptFile,
  type RenderReceiptFinalizeResult,
} from "./render-receipt-file";
import {
  remapPrivatePublicationResultPaths,
  remapReceiptOutputPath,
  renderQualityManifestFailure,
  workflowCatalogFields,
} from "./render-delivery-publication-support";
import { enrichRenderReceiptWithQualityManifest } from "./quality-manifest-retention";
import { mediaTypeForPath } from "./sidecar-publication";
import {
  combinedFailure,
  completed,
  failure,
  preparedCatalogFailure,
  requiredQualityCheck,
  type StrictLinearSrgbSdrTerminalInput,
  type StrictLinearSrgbSdrTerminalResult,
} from "./strict-linear-srgb-sdr-terminal-result";

export type {
  StrictLinearSrgbSdrTerminalCliResult,
  StrictLinearSrgbSdrTerminalInput,
  StrictLinearSrgbSdrTerminalResult,
} from "./strict-linear-srgb-sdr-terminal-result";

/**
 * Shared strict terminal. The ordinary CLI reaches this with no Core candidate scope and keeps its
 * existing paired publication. The private child enters the Core scope before calling this function;
 * that swaps only the internal paired publication and renderer activation, never CLI arguments.
 */
export async function runStrictLinearSrgbSdrTerminal(
  input: StrictLinearSrgbSdrTerminalInput,
): Promise<StrictLinearSrgbSdrTerminalResult> {
  const workspace = input.preparation ? currentStrictSdrCandidateHeldWorkspace() : undefined;
  let pair: StrictSdrCandidateHeldPair | undefined;
  if (workspace) {
    try {
      pair = await openStrictSdrCandidateHeldPair(workspace);
    } catch (error) {
      try {
        await closeStrictSdrCandidateHeldWorkspace(workspace);
      } catch (cleanupError) {
        throw combinedFailure("Strict-SDR candidate pair acquisition and unused-workspace closure both failed", error, cleanupError);
      }
      throw error;
    }
  }
  if (pair && input.qualityManifestPath) {
    const refusal = {
      code: "strict_sdr_candidate_quality_unsupported",
      message: "The nonqualifying strict-SDR candidate route does not run a quality-manifest evaluator.",
    };
    await abortAfterFailure(pair, undefined, refusal);
    return { result: failure(input, refusal) };
  }

  let ordinaryPublication: PairedOutputReceiptPublication | undefined;
  if (!pair) {
    ordinaryPublication = await PairedOutputReceiptPublication.acquire({
      outputPath: input.outputPath,
      receiptPath: renderReceiptPathForOutput(input.pkg.manifest.id, input.outputPath, "ffmpeg"),
      outputArtifact: { role: "rendered_media", mediaType: mediaTypeForPath(input.outputPath), primary: true },
      receiptArtifact: { role: "render_receipt", mediaType: "application/json" },
      ...(input.force ? { forceOutput: true, forceReceipt: true } : {}),
    });
  }

  let outputPath: string;
  let receiptPath: string;
  let renderInput: RenderStreamingFinalInput;
  if (pair) {
    try {
      const binding = strictSdrCandidateTerminalBinding(pair);
      outputPath = binding.outputPath;
      receiptPath = binding.receiptPath;
      renderInput = {
        ...input.renderInput,
        outputPublication: strictSdrCandidateOutputPublication(pair),
        ...(input.preparation ? { linearSrgbSdrFinalPreparation: input.preparation } : {}),
        outputPath,
        outputRoots: [dirname(outputPath)],
      };
    } catch (error) {
      await abortAfterFailure(pair, ordinaryPublication, error);
      throw error;
    }
  } else {
    outputPath = input.outputPath;
    receiptPath = renderReceiptPathForOutput(input.pkg.manifest.id, input.outputPath, "ffmpeg");
    renderInput = {
      ...input.renderInput,
      outputPublication: ordinaryPublication!.outputPublication,
      ...(input.preparation ? { linearSrgbSdrFinalPreparation: input.preparation } : {}),
    };
  }

  let streamed: Awaited<ReturnType<typeof renderStreamingFinal>>;
  try {
    streamed = pair
      ? await withStrictSdrCandidateHeldPairRendering(pair, input.preparation!.fingerprint, async () => await renderStreamingFinal(renderInput))
      : await renderStreamingFinal(renderInput);
  } catch (error) {
    await abortAfterFailure(pair, ordinaryPublication, error);
    throw error;
  }
  if (!streamed.ok) {
    await abortAfterFailure(pair, ordinaryPublication, streamed.error);
    return { result: failure(input, streamed.error) };
  }

  const finalCommand = {
    ...streamed.command,
    args: pair
      ? streamed.command.args
      : streamed.command.args.map((arg) => arg === ordinaryPublication!.outputPublication.stagingPath ? input.outputPath : arg),
  };

  const rawQualityCheck = input.qualityManifestPath
    ? await requiredQualityCheck(input.qualityCheck, ordinaryPublication!.outputPublication.stagingPath)
    : undefined;
  const qualityCheck = rawQualityCheck
    ? remapPrivatePublicationResultPaths(rawQualityCheck, ordinaryPublication!.outputPublication.stagingPath, input.outputPath)
    : undefined;
  if (input.qualityManifestPath && qualityCheck) {
    await enrichRenderReceiptWithQualityManifest(streamed.receipt, input.qualityManifestPath, qualityCheck);
    await recordReceiptFfprobeProvenance(streamed.receipt, { contributed: true, ...(input.ffmpegRunner ? { runner: input.ffmpegRunner } : {}) });
    if (!qualityCheck.ok) {
      await bindFinalRenderReceiptLineage(streamed.receipt, input.pkg, input.lineage);
      if (pair) {
        await abortAfterFailure(pair, ordinaryPublication, qualityCheck.error);
        return { result: failure(input, qualityCheck.error) };
      }
      remapReceiptOutputPath(streamed.receipt, ordinaryPublication!.outputPublication.stagingPath, input.outputPath);
      await ordinaryPublication!.abort();
      return {
        result: await renderQualityManifestFailure({
          packageId: input.pkg.manifest.id,
          lane: "ffmpeg",
          frameLane: input.frameLane,
          preset: input.preset,
          outputPath: input.outputPath,
          receipt: streamed.receipt,
          qualityManifestPath: input.qualityManifestPath,
          qualityCheck,
          force: input.force,
          extra: { frameTransport: input.frameTransport, ffmpeg: finalCommand },
        }),
      };
    }
  }

  if (pair) {
    try {
      await bindFinalRenderReceiptLineage(streamed.receipt, input.pkg, input.lineage);
    } catch (error) {
      await abortAfterFailure(pair, ordinaryPublication, error);
      throw error;
    }
  } else {
    await bindFinalRenderReceiptLineage(streamed.receipt, input.pkg, input.lineage);
  }
  let workflowCatalog: RenderReceiptFinalizeResult | undefined;
  try {
    const preparedCatalog = await prepareRenderReceipt({
      packageId: input.pkg.manifest.id,
      receipt: streamed.receipt,
      outputPath,
      receiptPath,
      atMs: 0,
      workflowCatalogPath: input.workflowCatalogPath,
      failOnDrift: input.failOnDrift,
      force: input.force,
    });
    workflowCatalog = preparedCatalog;
    if (preparedCatalog.error) {
      await abortPreparedRenderCatalog(preparedCatalog);
      streamed.receipt.status = "failed";
      if (pair) {
        await abortAfterFailure(pair, ordinaryPublication, preparedCatalog.error);
        return { result: failure(input, preparedCatalog.error) };
      }
      remapReceiptOutputPath(streamed.receipt, ordinaryPublication!.outputPublication.stagingPath, input.outputPath);
      await ordinaryPublication!.abort();
      preparedCatalog.receiptPath = await writeRenderReceiptFile(streamed.receipt, receiptPath, { force: input.force });
      preparedCatalog.artifacts = streamed.receipt.artifacts;
      return { result: preparedCatalogFailure(input, streamed.receipt, preparedCatalog, qualityCheck, finalCommand) };
    }
    if (pair) {
      await stageStrictSdrCandidateFinalReceipt(pair, streamed.receipt);
      await commitStrictSdrCandidateHeldPair(pair, { cancelled: () => input.signal?.aborted === true });
    } else {
      await ordinaryPublication!.stageReceipt(streamed.receipt);
      await ordinaryPublication!.commit({ cancelled: () => input.signal?.aborted === true });
    }
  } catch (error) {
    await abortPreparedRenderCatalog(workflowCatalog).catch(() => undefined);
    await abortAfterFailure(pair, ordinaryPublication, error);
    if (error instanceof PairedOutputReceiptCommitUncertainError) {
      return { result: { ok: false, command: "render", lane: "ffmpeg", frameLane: input.frameLane, preset: input.preset, ...pairedPublicationUncertaintyFields(error, "renderCommitUncertain"), error: pairedPublicationUncertaintyError(error) } };
    }
    throw error;
  }

  let committedCatalog: RenderReceiptFinalizeResult;
  try {
    committedCatalog = await commitPreparedRenderCatalog(workflowCatalog!, streamed.receipt);
  } catch (error) {
    return completed(pair, {
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane: input.frameLane,
      preset: input.preset,
      renderCommitted: true,
      ...(input.audioPath ? { audioPath: input.audioPath } : {}),
      ...(input.audio ? { audio: input.audio } : {}),
      ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
      ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
      outputPath,
      output: streamed.receipt.output,
      receipt: streamed.receipt,
      receiptPath,
      ...(qualityCheck ? { qualityCheck } : {}),
      warnings: streamed.receipt.warnings,
      frameTransport: input.frameTransport,
      ffmpeg: finalCommand,
      error: { code: "render_catalog_update_failed", message: error instanceof Error ? error.message : String(error) },
    });
  }

  return completed(pair, {
    ok: true,
    command: "render",
    lane: "ffmpeg",
    frameLane: input.frameLane,
    preset: input.preset,
    ...workflowCatalogFields(committedCatalog),
    ...(input.audioPath ? { audioPath: input.audioPath } : {}),
    ...(input.audio ? { audio: input.audio } : {}),
    ...(input.audioTracks ? { audioTracks: input.audioTracks } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
    outputPath,
    output: streamed.receipt.output,
    receipt: streamed.receipt,
    receiptPath,
    ...(qualityCheck ? { qualityCheck } : {}),
    warnings: streamed.receipt.warnings,
    frameTransport: input.frameTransport,
    ffmpeg: finalCommand,
  });
}

async function abort(pair: StrictSdrCandidateHeldPair | undefined, ordinary: PairedOutputReceiptPublication | undefined): Promise<void> {
  if (pair) await abortStrictSdrCandidateHeldPair(pair);
  else await ordinary?.abort();
}

/** Ordinary delivery preserved best-effort aborts; a held pair retains any cleanup uncertainty. */
async function abortAfterFailure(
  pair: StrictSdrCandidateHeldPair | undefined,
  ordinary: PairedOutputReceiptPublication | undefined,
  primary: unknown,
): Promise<void> {
  if (!pair) {
    await ordinary?.abort().catch(() => undefined);
    return;
  }
  try {
    await abort(pair, ordinary);
  } catch (cleanupError) {
    throw combinedFailure("Strict-SDR candidate pair cleanup failed after terminal failure", primary, cleanupError);
  }
}
