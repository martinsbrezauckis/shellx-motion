import { describe, expect, it } from "vitest";
import { planStreamingFinalCommand } from "./index";

const input = {
  fps: 2,
  width: 2,
  height: 2,
  durationMs: 1_000,
  outputPath: "/trusted/out.mp4",
  inputRoots: ["/trusted"],
  outputRoots: ["/trusted"]
};

describe("streaming final command planner", () => {
  it("constructs a canonical image2pipe command without a frame-sequence file input", () => {
    const result = planStreamingFinalCommand(input);
    expect(result).toMatchObject({ ok: true, transport: { delivery: "streamed", reason: "stream_default" } });
    if (!result.ok) return;
    expect(result.command).toMatchObject({ shell: false });
    expect(result.command.args).toEqual(expect.arrayContaining(["-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0"]));
    expect(result.command.args.join(" ")).not.toContain("%06d.png");
  });

  it("constructs canonical rawvideo RGBA input for a GPU producer", () => {
    const result = planStreamingFinalCommand({ ...input, frameFormat: "rgba" });
    expect(result).toMatchObject({ ok: true, transport: { delivery: "streamed" } });
    if (!result.ok) return;
    expect(result.command.args).toEqual(expect.arrayContaining([
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-framerate", "2", "-i", "pipe:0"
    ]));
    expect(result.command.args).not.toContain("image2pipe");
    expect(result.command.args).not.toContain("png");
  });

  it("does not allow an impossible or stale supplied transport plan to force streaming", () => {
    const impossible = planStreamingFinalCommand({
      ...input,
      transport: { delivery: "streamed", reason: "explicit_frame_retention" } as never
    });
    const impossibleMaterialized = planStreamingFinalCommand({
      ...input,
      transport: { delivery: "materialized", reason: "stream_default" } as never
    });
    const stale = planStreamingFinalCommand({
      ...input,
      keepFrames: true,
      transport: { delivery: "streamed", reason: "stream_default" }
    });
    const falseMaterializedReason = planStreamingFinalCommand({
      ...input,
      transport: { delivery: "materialized", reason: "captured_browser_workflow" }
    });
    expect(impossible).toMatchObject({ ok: false, error: { code: "frame_transport_plan_invalid" } });
    expect(impossibleMaterialized).toMatchObject({ ok: false, error: { code: "frame_transport_plan_invalid" } });
    expect(stale).toMatchObject({ ok: false, error: { code: "frame_transport_plan_conflict" }, transport: { reason: "explicit_frame_retention" } });
    expect(falseMaterializedReason).toMatchObject({ ok: false, error: { code: "frame_transport_plan_conflict" }, transport: { delivery: "streamed" } });
  });

  it("refuses materialization before command construction for workflow, exact-source quality, and hash capacity", () => {
    for (const options of [
      { capturedBrowserWorkflow: true, reason: "captured_browser_workflow" },
      { qualityManifest: { exactSourceComparison: "required" as const }, reason: "exact_source_quality" },
      { quality: { minUniqueFrameHashes: 65 }, reason: "streaming_quality_capacity" }
    ]) {
      const result = planStreamingFinalCommand({ ...input, ...options });
      expect(result).toMatchObject({ ok: false, transport: { delivery: "materialized", reason: options.reason }, error: { code: "frame_transport_materialized_required" } });
    }
  });

  it("fails closed on hostile masters and explicitly refuses a master with no resolved audio", () => {
    const hostile = planStreamingFinalCommand({ ...input, audioMaster: { loudness: { integratedLufs: Number.NaN } } as never });
    const unavailable = planStreamingFinalCommand({
      ...input,
      audioMaster: { volume: 0.8 },
    });
    expect(hostile).toMatchObject({ ok: false, error: { code: "audio_master_invalid" } });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "audio_master_unavailable", message: expect.stringMatching(/resolved audio/) } });
  });

  it("preserves the final-audio input refusal code in dry-run command planning", () => {
    const result = planStreamingFinalCommand({ ...input, audio: { path: "/trusted/clip.mp4" } });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "unsafe_input_path",
        message: expect.stringContaining("WAV, FLAC, MP3, Ogg, or Opus")
      }
    });
  });
});
