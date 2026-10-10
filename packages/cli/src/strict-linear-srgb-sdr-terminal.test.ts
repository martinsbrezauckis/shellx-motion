import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ bindLineage: vi.fn() }));
const held = vi.hoisted(() => ({
  workspace: vi.fn(),
  open: vi.fn(),
  closeWorkspace: vi.fn(),
  abort: vi.fn(),
  stage: vi.fn(),
  commit: vi.fn(),
  output: vi.fn(),
  binding: vi.fn(),
  withRendering: vi.fn(),
}));
const renderer = vi.hoisted(() => ({ render: vi.fn() }));
const paired = vi.hoisted(() => ({ acquire: vi.fn() }));
const receipt = vi.hoisted(() => ({ prepare: vi.fn(), commit: vi.fn() }));

vi.mock("@shellx-motion/core", () => ({ bindFinalRenderReceiptLineage: core.bindLineage }));
vi.mock("@shellx-motion/core/internal/strict-sdr-candidate-held-pair", () => ({
  currentStrictSdrCandidateHeldWorkspace: held.workspace,
  openStrictSdrCandidateHeldPair: held.open,
  closeStrictSdrCandidateHeldWorkspace: held.closeWorkspace,
  abortStrictSdrCandidateHeldPair: held.abort,
  stageStrictSdrCandidateFinalReceipt: held.stage,
  commitStrictSdrCandidateHeldPair: held.commit,
  strictSdrCandidateOutputPublication: held.output,
  strictSdrCandidateTerminalBinding: held.binding,
  withStrictSdrCandidateHeldPairRendering: held.withRendering,
}));
vi.mock("@shellx-motion/debug-api", () => ({ recordReceiptFfprobeProvenance: vi.fn() }));
vi.mock("@shellx-motion/renderer-ffmpeg", () => ({ renderStreamingFinal: renderer.render }));
vi.mock("./paired-output-receipt-publication.js", () => ({
  PairedOutputReceiptCommitUncertainError: class PairedOutputReceiptCommitUncertainError extends Error {},
  PairedOutputReceiptPublication: { acquire: paired.acquire },
}));
vi.mock("./render-receipt-file.js", () => ({
  // Production abortPreparedRenderCatalog is async even when there is no catalog.
  // Keep this mock promise-shaped so the terminal's best-effort `.catch()` path
  // tests the stage failure rather than a fixture-only TypeError.
  abortPreparedRenderCatalog: vi.fn(async () => undefined),
  commitPreparedRenderCatalog: receipt.commit,
  prepareRenderReceipt: receipt.prepare,
  renderReceiptPathForOutput: (_packageId: string, outputPath: string) => `${outputPath}.receipt.json`,
  writeRenderReceiptFile: vi.fn(),
}));
vi.mock("./render-delivery-publication-support.js", () => ({
  remapPrivatePublicationResultPaths: vi.fn(),
  remapReceiptOutputPath: vi.fn(),
  renderQualityManifestFailure: vi.fn(),
  workflowCatalogFields: () => ({}),
}));
vi.mock("./quality-manifest-retention.js", () => ({ enrichRenderReceiptWithQualityManifest: vi.fn() }));
vi.mock("./sidecar-publication.js", () => ({ mediaTypeForPath: (path: string) => path.endsWith(".mp4") ? "video/mp4" : undefined }));

import { runStrictLinearSrgbSdrTerminal } from "./strict-linear-srgb-sdr-terminal.js";

const OUTPUT = "/delivery/final.mp4";
const STAGE = "/private/stage.mp4";
const PAIR = Object.freeze({});
const WORKSPACE = Object.freeze({});
const PREPARATION = Object.freeze({ fingerprint: "a".repeat(64) });

beforeEach(() => {
  vi.clearAllMocks();
  held.workspace.mockReturnValue(undefined);
  paired.acquire.mockResolvedValue(publication(STAGE));
  receipt.prepare.mockResolvedValue({});
  receipt.commit.mockResolvedValue({});
  renderer.render.mockResolvedValue(success(STAGE));
  core.bindLineage.mockResolvedValue(undefined);
  held.withRendering.mockImplementation(async (_pair: unknown, _fingerprint: string, operation: () => Promise<unknown>) => await operation());
});

describe("strict linear-sRGB SDR shared terminal", () => {
  it("keeps the ordinary paired-publication route and public command projection", async () => {
    const result = await runStrictLinearSrgbSdrTerminal(input());

    expect(paired.acquire).toHaveBeenCalledWith(expect.objectContaining({
      outputPath: OUTPUT,
      receiptPath: `${OUTPUT}.receipt.json`,
      outputArtifact: { role: "rendered_media", mediaType: "video/mp4", primary: true },
    }));
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      outputPath: OUTPUT,
      outputRoots: ["/ordinary-root"],
      outputPublication: expect.objectContaining({ stagingPath: STAGE }),
    }));
    expect(result).toMatchObject({
      result: {
        ok: true,
        outputPath: OUTPUT,
        receiptPath: `${OUTPUT}.receipt.json`,
        ffmpeg: { args: ["-i", OUTPUT] },
      },
    });
    expect(result).not.toHaveProperty("committedHeldPair");
  });

  it("keeps the ordinary render error when its best-effort abort also fails", async () => {
    const ordinary = publication(STAGE);
    ordinary.abort.mockRejectedValueOnce(new Error("ordinary abort failed"));
    paired.acquire.mockResolvedValueOnce(ordinary);
    renderer.render.mockRejectedValueOnce(new Error("renderer failed"));

    await expect(runStrictLinearSrgbSdrTerminal(input())).rejects.toThrow("renderer failed");
    expect(ordinary.abort).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary stage failure when its best-effort abort also fails", async () => {
    const ordinary = publication(STAGE);
    ordinary.stageReceipt.mockRejectedValueOnce(new Error("stage failed"));
    ordinary.abort.mockRejectedValueOnce(new Error("ordinary abort failed"));
    paired.acquire.mockResolvedValueOnce(ordinary);

    await expect(runStrictLinearSrgbSdrTerminal(input())).rejects.toThrow("stage failed");
    expect(ordinary.abort).toHaveBeenCalledTimes(1);
  });

  it("uses the active Core scope only for the held pair and returns its opaque committed handle", async () => {
    const heldStage = "/held/output.mp4";
    held.workspace.mockReturnValue(WORKSPACE);
    held.open.mockResolvedValue(PAIR);
    held.binding.mockReturnValue({ outputPath: heldStage, receiptPath: `${heldStage}.receipt.json` });
    held.output.mockReturnValue({ stagingPath: heldStage });
    renderer.render.mockResolvedValue(success(heldStage));

    const result = await runStrictLinearSrgbSdrTerminal(input({ preparation: PREPARATION }));

    expect(paired.acquire).not.toHaveBeenCalled();
    expect(held.withRendering).toHaveBeenCalledWith(PAIR, PREPARATION.fingerprint, expect.any(Function));
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({ outputPath: heldStage, outputRoots: ["/held"] }));
    expect(held.stage).toHaveBeenCalledWith(PAIR, expect.any(Object));
    expect(held.commit).toHaveBeenCalledWith(PAIR, expect.any(Object));
    expect(result).toMatchObject({ result: { ok: true, outputPath: heldStage, receiptPath: `${heldStage}.receipt.json` }, committedHeldPair: PAIR });
  });

  it("aborts an open candidate pair when final lineage binding rejects after rendering", async () => {
    const heldStage = "/held/output.mp4";
    held.workspace.mockReturnValue(WORKSPACE);
    held.open.mockResolvedValue(PAIR);
    held.binding.mockReturnValue({ outputPath: heldStage, receiptPath: `${heldStage}.receipt.json` });
    held.output.mockReturnValue({ stagingPath: heldStage });
    renderer.render.mockResolvedValue(success(heldStage));
    core.bindLineage.mockRejectedValueOnce(new Error("lineage changed"));

    await expect(runStrictLinearSrgbSdrTerminal(input({ preparation: PREPARATION }))).rejects.toThrow("lineage changed");
    expect(held.abort).toHaveBeenCalledWith(PAIR);
  });

  it("refuses a private quality evaluator before renderer allocation and preserves pre-pair cleanup failure", async () => {
    held.workspace.mockReturnValue(WORKSPACE);
    held.open.mockResolvedValue(PAIR);
    const quality = await runStrictLinearSrgbSdrTerminal(input({ preparation: PREPARATION, qualityManifestPath: "/quality.json" }));
    expect(quality).toMatchObject({ result: { ok: false, error: { code: "strict_sdr_candidate_quality_unsupported" } } });
    expect(held.abort).toHaveBeenCalledWith(PAIR);
    expect(renderer.render).not.toHaveBeenCalled();

    held.abort.mockRejectedValueOnce(new Error("held abort failed"));
    renderer.render.mockRejectedValueOnce(new Error("candidate render failed"));
    await expect(runStrictLinearSrgbSdrTerminal(input({ preparation: PREPARATION })))
      .rejects.toThrow("Strict-SDR candidate pair cleanup failed after terminal failure: candidate render failed; workspace cleanup: held abort failed");

    held.open.mockRejectedValueOnce(new Error("pair unavailable"));
    held.closeWorkspace.mockRejectedValueOnce(new Error("workspace close failed"));
    await expect(runStrictLinearSrgbSdrTerminal(input({ preparation: PREPARATION })))
      .rejects.toThrow("pair acquisition and unused-workspace closure both failed: pair unavailable; workspace cleanup: workspace close failed");
  });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    pkg: { manifest: { id: "pkg_terminal" } },
    lineage: {},
    frameLane: "gpu",
    frameTransport: { delivery: "streamed", reason: "stream_default" },
    preset: "mp4-h264",
    ffmpegPlan: { executable: "ffmpeg", args: ["-i", OUTPUT], shell: false },
    outputPath: OUTPUT,
    audioPath: undefined,
    audio: undefined,
    audioTracks: undefined,
    qualityManifestPath: undefined,
    workflowCatalogPath: undefined,
    failOnDrift: false,
    force: false,
    signal: undefined,
    ffmpegRunner: undefined,
    renderInput: { outputPath: OUTPUT, outputRoots: ["/ordinary-root"] },
    preparation: undefined,
    ...overrides,
  } as any;
}

function publication(stagingPath: string) {
  return {
    outputPublication: { stagingPath },
    stageReceipt: vi.fn(),
    commit: vi.fn(),
    abort: vi.fn(),
  };
}

function success(stagingPath: string) {
  return {
    ok: true,
    command: { executable: "ffmpeg", args: ["-i", stagingPath], shell: false },
    receipt: { operation: "render.final", status: "passed", output: {}, inputHashes: {}, warnings: [] },
  };
}
