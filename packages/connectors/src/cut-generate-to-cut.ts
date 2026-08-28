/**
 * Compatibility façade for the pre-P2B Cut Generate route.
 * It hardcodes its distinct receipt operation and deliberately exposes no generic operation selector.
 */
import type { CutRenderedMediaPlacement } from "@shellx-motion/adapters-cut";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import type { ConnectorArtifact } from "./artifacts";
import type { CutImportModeRequest } from "./cut-import-mode";
import { runCutGenerateToCutLegacy } from "./cut-generate-to-cut-legacy";
import type { ConnectorRequestedFinalFrameLane, ConnectorStreamingFinalRenderer } from "./streaming-final";

export interface CutGenerateToCutConnectorInput {
  scriptPath?: string;
  script?: unknown;
  outDir: string;
  force?: boolean;
  previewLane?: "native";
  renderLane?: "ffmpeg";
  frameLane?: ConnectorRequestedFinalFrameLane;
  dryRunRender?: boolean;
  cutImportMode?: CutImportModeRequest;
  cutPlacement?: CutRenderedMediaPlacement;
  streamingRenderer?: ConnectorStreamingFinalRenderer;
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface CutGenerateToCutConnectorResult {
  ok: boolean;
  packageDir: string;
  preview: { ok: boolean; lane: "native"; failureFatal: boolean; receiptPath: string; outputPath: string | null };
  render: { ok: boolean; required: boolean; dryRun: boolean; lane: "ffmpeg"; frameLane?: ConnectorRequestedFinalFrameLane; receiptPath: string; outputPath?: string };
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runCutGenerateToCutConnector(input: CutGenerateToCutConnectorInput): Promise<CutGenerateToCutConnectorResult> {
  return await runCutGenerateToCutLegacy(input);
}
