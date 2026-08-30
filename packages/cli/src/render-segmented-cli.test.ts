/** Trusted CLI binding for the closed durable segmented-final route. */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTinyNativePackage } from "./main.fixtures-packages";

const ffmpeg = vi.hoisted(() => ({
  check: vi.fn(),
  segmented: vi.fn()
}));
const paired = vi.hoisted(() => ({ acquire: vi.fn() }));
const segmentedCli = vi.hoisted(() => ({
  bind: vi.fn((input: Record<string, unknown>) => ({ ...input, privateOutputPublication: Object.freeze({}) }))
}));
vi.mock("@shellx-motion/renderer-ffmpeg", async (importOriginal) => ({
  ...await importOriginal<typeof import("@shellx-motion/renderer-ffmpeg")>(),
  checkFfmpeg: ffmpeg.check,
  renderSegmentedFinal: ffmpeg.segmented
}));
vi.mock("./output-dir-guard.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./output-dir-guard.js")>(),
  outputFileRefusal: async () => undefined
}));
vi.mock("./paired-output-receipt-publication.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./paired-output-receipt-publication.js")>(),
  PairedOutputReceiptPublication: { acquire: paired.acquire }
}));
vi.mock("@shellx-motion/renderer-ffmpeg/internal/segmented-final-cli-publication", () => ({
  withSegmentedFinalCliPublication: segmentedCli.bind
}));

import { runCli } from "./main";

const roots: string[] = [];

afterEach(async () => {
  ffmpeg.check.mockReset();
  ffmpeg.segmented.mockReset();
  paired.acquire.mockReset();
  segmentedCli.bind.mockClear();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("CLI durable segmented final host binding", () => {
  it("forwards the trusted scratch, caller, and cancellation signal without promoting the host job id into an inner lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-segmented-"));
    roots.push(root);
    const scratchRoot = join(root, "host-scratch");
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const packageRoot = await writeTinyNativePackage();
    roots.push(packageRoot);
    const signal = new AbortController().signal;
    ffmpeg.check.mockResolvedValue({ ok: true, command: "ffmpeg", version: "ffmpeg test" });
    const privateOutputPublication = { outputPath: join(root, "final.mp4"), stagingPath: join(root, "private-final.mp4") };
    paired.acquire.mockResolvedValue({ outputPublication: privateOutputPublication, abort: vi.fn() });
    ffmpeg.segmented.mockResolvedValue({
      ok: false,
      error: { code: "job_cancelled", message: "cancelled for binding test", retryable: true, evidence: { phase: "cancelled" } }
    });

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "gpu",
      "--segment-frames", "12", "--resume-segments", "--out", join(root, "final.mp4"),
      "--job-id", "outer-segmented-job"
    ], { scratchRoot, callerId: "host:segmented", signal });

    expect(result).toMatchObject({ ok: false, command: "render" });
    expect(ffmpeg.segmented).toHaveBeenCalledTimes(1);
    expect(segmentedCli.bind).toHaveBeenCalledWith(expect.objectContaining({ frameLane: "gpu" }), privateOutputPublication);
    const [input] = ffmpeg.segmented.mock.calls[0]!;
    expect(input).toMatchObject({
      frameLane: "gpu",
      scratchRoot,
      callerId: "host:segmented",
      signal,
      segmented: { segmentFrames: 12, resume: true }
    });
    // The CLI supplies an opaque renderer-internal authority, never the Core publication object
    // through the public segmented-final request contract.
    expect(input.privateOutputPublication).toEqual({});
    expect(input.privateOutputPublication).not.toBe(privateOutputPublication);
    // `--job-id` identifies the observable CLI host job. The segmented adapter acquires its own
    // governor lease and must not receive that id as an inner lease request.
    expect(input).not.toHaveProperty("jobId");
    // The command only selects the closed segment selector; browser/provider/capture authority is
    // not representable at this route and therefore never reaches the renderer.
    expect(input).not.toHaveProperty("browser");
    expect(input).not.toHaveProperty("provider");
    expect(input).not.toHaveProperty("openVideoProvider");
    expect(input).not.toHaveProperty("openHybridCapture");
    expect(input).not.toHaveProperty("hybridCapture");
    expect(input.toolPolicy).not.toHaveProperty("gpu");
  });
});
