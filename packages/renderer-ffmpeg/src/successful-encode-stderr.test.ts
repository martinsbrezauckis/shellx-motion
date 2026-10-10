/**
 * Coverage for grading a successful encode's stderr.
 *
 * The fixture covers FFmpeg's progress and muxing output, including a merged
 * progress/muxing-overhead line that may appear when stderr is not a TTY.
 */
import { describe, expect, it } from "vitest";
import { summarizeSuccessfulEncodeStderr } from "./index";

// Synthetic representative MP4 stderr: routine banners, metadata, progress, and side data.
const CLEAN_ENCODE_STDERR = [
  "ffmpeg version synthetic",
  "Input #0, lavfi, from 'synthetic-input':",
  "  Duration: N/A, start: 0.000000, bitrate: N/A",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (rawvideo (native) -> h264 (libx264))",
  "Press [q] to stop, [?] for help",
  "[libx264 @ 0x1] using SAR=1/1",
  "[libx264 @ 0x1] profile High, level 1.0, 4:2:0, 8-bit",
  "Output #0, mp4, to 'synthetic-output':",
  "  Metadata:",
  "    encoder         : synthetic",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "frame=    0 fps=0.0 q=0.0 size=0kB time=N/A bitrate=N/A speed=N/A    [out#0/mp4 @ 0x2] video:1kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 1%",
  "frame=    1 fps=0.0 q=0.0 Lsize=1kB time=00:00:00.10 bitrate=1kbits/s speed=1x"
].join("\n");

describe("summarizeSuccessfulEncodeStderr", () => {
  it("reports nothing for a clean encode", () => {
    // Before this classifier the receipt recorded the last two lines — always the progress and
    // muxing-overhead summary — so every successful render appeared to have warned.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_ENCODE_STDERR)).toBe("");
  });

  it("keeps a diagnostic that appears among routine output", () => {
    const withProblem = `${CLEAN_ENCODE_STDERR}\n[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;`;
    expect(summarizeSuccessfulEncodeStderr(withProblem)).toContain("Non-monotonous DTS");
  });

  it("keeps a diagnostic after FFmpeg's bare-carriage-return progress update", () => {
    const withProblem = "frame=   10 fps=0.0 q=25.0 size=3kB time=00:00:00.70 bitrate=32.1kbits/s speed=115x\r"
      + "[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;";
    expect(summarizeSuccessfulEncodeStderr(withProblem))
      .toBe("[mp4 @ [address]] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;");
  });

  it("keeps an unrecognised line rather than hiding it", () => {
    // The classifier is a denylist on purpose: a line it has never seen must survive.
    const surprising = `${CLEAN_ENCODE_STDERR}\nsomething nobody anticipated happened here`;
    expect(summarizeSuccessfulEncodeStderr(surprising)).toBe("something nobody anticipated happened here");
  });

  it("collapses a repeated complaint and bounds the total", () => {
    const repeated = Array.from({ length: 400 }, () => "[mp4 @ 0x1] Past duration 0.999992 too large").join("\n");
    const distinct = Array.from({ length: 9 }, (_, index) => `[mp4 @ 0x1] problem number ${index}`).join("\n");

    expect(summarizeSuccessfulEncodeStderr(repeated)).toBe("[mp4 @ [address]] Past duration 0.999992 too large");
    // Bounded so a pathological encode cannot fill the receipt.
    expect(summarizeSuccessfulEncodeStderr(distinct).split("problem number").length - 1).toBe(5);
  });

  it("redacts secrets that reached the command line", () => {
    const leaked = "AWS_SECRET_ACCESS_KEY=abc123 could not open output";
    expect(summarizeSuccessfulEncodeStderr(leaked)).toContain("[redacted]");
    expect(summarizeSuccessfulEncodeStderr(leaked)).not.toContain("abc123");
  });

  it("bounds raw success diagnostics before processing a partial token or terminal-safe path", () => {
    const partial = `sk-proj-${"a".repeat(20_000)}`;
    const summary = summarizeSuccessfulEncodeStderr(`${partial}\nC:\\Users\\TestUser\\private.txt /opt/fixture/private\u001b[8m\u202E`);

    expect(summary).toContain("[redacted]");
    expect(summary).not.toContain(partial.slice(0, 24));
    expect(summary).not.toContain("C:\\Users\\TestUser");
    expect(summary).not.toContain("/opt/fixture/private");
    expect(summary).not.toContain("\u001b");
    expect(summary).not.toContain("\u202E");
  });

  it("reports nothing for empty stderr", () => {
    expect(summarizeSuccessfulEncodeStderr("")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("   \n  \n")).toBe("");
  });
});

/**
 * Synthetic representative audio-mux input. Loudnorm measurement labels, channel-layout
 * inference, and thread-queue advice are routine output; actual filter failures remain visible.
 */
// Synthetic representative audio mux stderr: loudnorm measurements and benign queue chatter.
const CLEAN_AUDIO_ENCODE_STDERR = [
  "ffmpeg version synthetic",
  "Input #0, image2, from 'synthetic-video':",
  "Input #1, wav, from 'synthetic-audio':",
  "[aist#1:0/pcm_s16le @ 0x1] Guessed Channel Layout: mono",
  "Stream mapping:",
  "  Stream #1:0 (pcm_s16le) -> loudnorm:default (graph 0)",
  "  Stream #0:0 -> #0:0 (png (native) -> h264 (libx264))",
  "  loudnorm:default (graph 0) -> Stream #0:1 (aac)",
  "Press [q] to stop, [?] for help",
  "[in#0/image2 @ 0x2] Thread message queue blocking; consider raising the thread_queue_size option (current value: 8)",
  "Output #0, mp4, to 'synthetic-output':",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "frame=    1 fps=0.0 q=0.0 size=1kB time=00:00:00.10 bitrate=1kbits/s speed=1x",
  "[Parsed_loudnorm_0 @ 0x3]",
  "Input Integrated:    -20.0 LUFS",
  "Input True Peak:     -18.0 dBTP",
  "Input LRA:             0.0 LU",
  "Input Threshold:     -30.0 LUFS",
  "Output Integrated:   -16.0 LUFS",
  "Output True Peak:    -12.0 dBTP",
  "Output LRA:            0.0 LU",
  "Output Threshold:    -26.0 LUFS",
  "Normalization Type:   Linear",
  "Target Offset:        +0.0 LU"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on synthetic audio stderr", () => {
  it("reports nothing for a successful loudness-normalized audio mux", () => {
    expect(summarizeSuccessfulEncodeStderr(CLEAN_AUDIO_ENCODE_STDERR)).toBe("");
  });

  it("still surfaces a genuine loudnorm failure among the measurement block", () => {
    // The measurement labels are matched exactly, so an actual filter error — which does not use
    // that vocabulary — cannot hide inside the block that was filtered.
    const broken = `${CLEAN_AUDIO_ENCODE_STDERR}\n[Parsed_loudnorm_0 @ 0x1] Invalid loudness target`;
    expect(summarizeSuccessfulEncodeStderr(broken)).toBe("[Parsed_loudnorm_0 @ [address]] Invalid loudness target");
  });

  it("treats the whole x264 statistics block as routine, including the ref/consecutive lines", () => {
    const stats = [
      "[libx264 @ 0x1] consecutive B-frames:  25.0% 25.0% 25.0% 25.0%",
      "[libx264 @ 0x1] ref P L0: 50.0% 50.0%",
      "[libx264 @ 0x1] ref B L0: 50.0% 50.0%",
      "[libx264 @ 0x1] ref B L1: 50.0% 50.0%",
      "[aac @ 0x1] Qavg: 100.0"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(stats)).toBe("");
  });
});

/**
 * Synthetic representative VP9/WebM input. A bare libvpx version banner is informational;
 * a line containing a warning after the version must remain actionable.
 */
// Synthetic representative VP9 stderr: a bare libvpx version banner is routine output.
const CLEAN_WEBM_VP9_ENCODE_STDERR = [
  "ffmpeg version synthetic",
  "Input #0, image2, from 'synthetic-input':",
  "Stream mapping:",
  "  Stream #0:0 -> #0:0 (png (native) -> vp9 (libvpx-vp9))",
  "Press [q] to stop, [?] for help",
  "[libvpx-vp9 @ 0x1] v1.14.0",
  "Output #0, webm, to 'synthetic-output':",
  "    Side data:",
  "      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "frame=    1 fps=0.0 q=0.0 Lsize=1kB time=00:00:00.10 bitrate=1kbits/s speed=1x"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on synthetic WebM VP9 stderr", () => {
  it("reports nothing for a successful VP9 encode", () => {
    // An encoder version banner must not downgrade a clean WebM receipt to `warning`.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_WEBM_VP9_ENCODE_STDERR)).toBe("");
  });

  it("still surfaces a genuine libvpx warning from the same encoder instance", () => {
    // `ffmpeg -c:v libvpx-vp9 -crf 32` with no `-b:v` can succeed with a warning.
    // The filter is anchored to a bare version token, so this prose diagnostic — printed by
    // the same `[libvpx-vp9 @ ...]` instance whose banner was filtered — survives into the receipt.
    const warned = [
      CLEAN_WEBM_VP9_ENCODE_STDERR,
      "[libvpx-vp9 @ 0x1] Neither bitrate nor constrained quality specified, using default CRF of 32"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(warned))
      .toBe("[libvpx-vp9 @ [address]] Neither bitrate nor constrained quality specified, using default CRF of 32");
  });

  it("filters the VP8 spelling of the banner and nothing that merely starts like it", () => {
    // VP8 uses the `[libvpx @ ...]` banner. Text after the version must survive.
    expect(summarizeSuccessfulEncodeStderr("[libvpx @ 0x1] v1.14.0")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0 is too old for this stream"))
      .toBe("[libvpx-vp9 @ [address]] v1.14.0 is too old for this stream");
  });

  it("keeps libvpx diagnostics that are not a version banner", () => {
    // Representative libvpx errors are not bare version tokens and must remain visible.
    const diagnostics = [
      "[libvpx-vp9 @ 0x1] CQ level 32 must be between minimum and maximum quantizer value (40-20)",
      "[libvpx-vp9 @ 0x1] Failed to initialize encoder: Invalid parameter",
      "[libvpx-vp9 @ 0x1] v1.14.0 build is missing VP9 support"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(diagnostics);
    expect(summary).toContain("CQ level 32 must be between minimum and maximum quantizer value");
    expect(summary).toContain("Failed to initialize encoder: Invalid parameter");
    expect(summary).toContain("build is missing VP9 support");
  });

  it("filters libvpx development-build version strings without loosening the anchor", () => {
    // libvpx reports non-release builds as "v1.14.0-rc1" / "v1.14.0-172-g0e0e5d7d1".
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0-rc1")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("[libvpx-vp9 @ 0x1] v1.14.0-172-g0e0e5d7d1")).toBe("");
    // A different encoder announcing a version is not covered by this pattern and still surfaces,
    // because the denylist stays per-encoder rather than becoming "any line ending in a version".
    expect(summarizeSuccessfulEncodeStderr("[libaom-av1 @ 0x1] v3.8.0")).toBe("[libaom-av1 @ [address]] v3.8.0");
  });
});

/**
 * Synthetic representative GIF input. Filtergraph mapping and palette-size reports are
 * informational; palettegen and paletteuse diagnostics remain visible.
 */
// Synthetic representative GIF stderr: mapping and palette-size output are routine.
const CLEAN_GIF_ENCODE_STDERR = [
  "ffmpeg version synthetic",
  "Input #0, image2, from 'synthetic-input':",
  "Stream mapping:",
  "  Stream #0:0 (png) -> split:default",
  "  paletteuse:default -> Stream #0:0 (gif)",
  "Press [q] to stop, [?] for help",
  "[Parsed_palettegen_1 @ 0x1] 2(+1) colors generated out of 2 colors; ratio=1.000000",
  "Output #0, gif, to 'synthetic-output':",
  "frame=    1 fps=0.0 q=0.0 Lsize=1kB time=00:00:00.10 bitrate=1kbits/s speed=1x"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on synthetic GIF stderr", () => {
  it("reports nothing for a successful palettegen/paletteuse GIF encode", () => {
    // Mapping and palette-size output must not downgrade a successful GIF receipt.
    expect(summarizeSuccessfulEncodeStderr(CLEAN_GIF_ENCODE_STDERR)).toBe("");
  });

  it("produces identical output for two runs that differ only in the heap pointer", () => {
    // Varying heap addresses must produce the same receipt text.
    const secondRun = CLEAN_GIF_ENCODE_STDERR.replaceAll("0x1", "0x2");
    expect(secondRun).not.toBe(CLEAN_GIF_ENCODE_STDERR);
    expect(summarizeSuccessfulEncodeStderr(secondRun)).toBe(summarizeSuccessfulEncodeStderr(CLEAN_GIF_ENCODE_STDERR));
  });

  it("still surfaces a genuine palettegen warning printed by the filtered instance", () => {
    // `Duped color` is an AV_LOG_WARNING, while the palette-size report is informational.
    // It comes from the same `[Parsed_palettegen_1 @ ...]` instance whose INFO line is filtered.
    const warned = `${CLEAN_GIF_ENCODE_STDERR}\n[Parsed_palettegen_1 @ 0x1] Duped color: FFDCDDE0`;
    expect(summarizeSuccessfulEncodeStderr(warned)).toBe("[Parsed_palettegen_1 @ [address]] Duped color: FFDCDDE0");
  });

  it("still surfaces genuine palettegen and paletteuse errors", () => {
    // These diagnostics cover `palettegen=max_colors=2` (which
    // conflicts with the reserved transparent slot) and a `paletteuse` fed an 8x8 palette instead
    // of a 256-pixel one. None of them is the palette-size report, so none can be filtered.
    const broken = [
      CLEAN_GIF_ENCODE_STDERR,
      "[Parsed_palettegen_1 @ 0x1] max_colors=2 is only allowed without reserving a transparent color slot",
      "[Parsed_paletteuse_0 @ 0x1] Palette input must contain exactly 256 pixels. Specified input has 8x8=64 pixels",
      "[Parsed_paletteuse_0 @ 0x1] Failed to configure input pad on Parsed_paletteuse_0"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(broken);
    expect(summary).toContain("max_colors=2 is only allowed without reserving a transparent color slot");
    expect(summary).toContain("Palette input must contain exactly 256 pixels");
    expect(summary).toContain("Failed to configure input pad on Parsed_paletteuse_0");
  });

  it("keeps a palette-size report that carries anything extra", () => {
    // The anchor runs to end-of-line, so a hypothetical future ffmpeg that appends a complaint to
    // the same line is not silently swallowed by the pattern that hides the clean form.
    expect(summarizeSuccessfulEncodeStderr("[Parsed_palettegen_1 @ 0x1] 255(+1) colors generated out of 19505 colors; ratio=0.013074 (palette truncated)"))
      .toBe("[Parsed_palettegen_1 @ [address]] 255(+1) colors generated out of 19505 colors; ratio=0.013074 (palette truncated)");
    // And the vocabulary is per-filter: a different filter reporting colours is not this banner.
    expect(summarizeSuccessfulEncodeStderr("[Parsed_showpalette_0 @ 0x1] 255(+1) colors generated out of 19505 colors; ratio=0.013074"))
      .toBe("[Parsed_showpalette_0 @ [address]] 255(+1) colors generated out of 19505 colors; ratio=0.013074");
  });

  it("filters the filtergraph mapping line without swallowing indented prose", () => {
    // The mapping pattern now accepts both spellings of the same banner block.
    expect(summarizeSuccessfulEncodeStderr("  paletteuse:default -> Stream #0:0 (gif)")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("  loudnorm:default (graph 0) -> Stream #0:1 (aac)")).toBe("");
    // ffmpeg diagnostics start at column 0 with a `[tag @ addr]` prefix, never as an indented
    // `label -> Stream #n:m` mapping, so a real complaint cannot take this shape.
    expect(summarizeSuccessfulEncodeStderr("[fc#0 @ 0x1] Error reinitializing filters!"))
      .toBe("[fc#0 @ [address]] Error reinitializing filters!");
    // (leading indentation is preserved verbatim; the summarizer only trims line ENDS)
    expect(summarizeSuccessfulEncodeStderr("  paletteuse could not map -> Stream is broken"))
      .toBe("  paletteuse could not map -> Stream is broken");
  });
});

/**
 * A Windows-style FFmpeg output variant with routine CPB and MP4 faststart lines.
 * A single receipt warning may contain both lines; neither is an encode failure.
 * Windows pointer formatting may omit the `0x` prefix.
 */
const WINDOWS_FASTSTART_CHATTER = [
  "      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A",
  "[mp4 @ 0000000000000001] Starting second pass: moving the moov atom to the beginning of the file"
].join("\n");

describe("summarizeSuccessfulEncodeStderr on newer-FFmpeg MP4 chatter", () => {
  it("reports nothing for the CPB + faststart pair", () => {
    expect(summarizeSuccessfulEncodeStderr(WINDOWS_FASTSTART_CHATTER)).toBe("");
  });

  it("filters both spellings of the same CPB side-data line", () => {
    // Older and newer spellings of the identical side data.
    expect(summarizeSuccessfulEncodeStderr("      cpb: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A")).toBe("");
    expect(summarizeSuccessfulEncodeStderr("      CPB properties: bitrate max/min/avg: 800000/0/400000 buffer size: 2000000 vbv_delay: 0")).toBe("");
  });

  it("keeps a genuine bitrate or buffering diagnostic that merely mentions CPB", () => {
    // The anchor is the exact HRD field sequence, so prose about the same subject survives.
    const diagnostics = [
      "[libx264 @ 0x1] CPB properties are inconsistent with the requested level",
      "[mp4 @ 0x1] Buffer underflow: VBV buffer size 0 is too small for bitrate 8000000",
      "      CPB properties: bitrate max/min/avg: 0/0/0 buffer size: 0 vbv_delay: N/A but the stream is non-conformant"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(diagnostics);
    expect(summary).toContain("CPB properties are inconsistent with the requested level");
    expect(summary).toContain("Buffer underflow");
    expect(summary).toContain("but the stream is non-conformant");
  });

  it("keeps a genuine mp4-muxer diagnostic from the instance whose faststart line is filtered", () => {
    // The same muxer tag can carry actionable diagnostics distinct from the faststart banner.
    const warned = [
      WINDOWS_FASTSTART_CHATTER,
      "[mp4 @ 0000000000000001] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;",
      "[mp4 @ 0000000000000001] Starting second pass failed: could not seek in the output file"
    ].join("\n");
    const summary = summarizeSuccessfulEncodeStderr(warned);
    expect(summary).toContain("Non-monotonous DTS");
    expect(summary).toContain("Starting second pass failed: could not seek in the output file");
  });

  it("stays scoped to the ISOBMFF muxers that implement faststart", () => {
    expect(summarizeSuccessfulEncodeStderr("[mov @ 0x1] Starting second pass: moving the moov atom to the beginning of the file")).toBe("");
    // A different muxer claiming the same sentence is not this banner and is not hidden.
    expect(summarizeSuccessfulEncodeStderr("[matroska @ 0x1] Starting second pass: moving the moov atom to the beginning of the file"))
      .toBe("[matroska @ [address]] Starting second pass: moving the moov atom to the beginning of the file");
  });

  it("produces identical output for two faststart runs that differ only in the instance pointer", () => {
    const secondRun = WINDOWS_FASTSTART_CHATTER.replaceAll("0000000000000001", "0000000000000002");
    expect(secondRun).not.toBe(WINDOWS_FASTSTART_CHATTER);
    expect(summarizeSuccessfulEncodeStderr(secondRun)).toBe(summarizeSuccessfulEncodeStderr(WINDOWS_FASTSTART_CHATTER));
  });
});

describe("summarizeSuccessfulEncodeStderr on Matroska stream metadata", () => {
  const MATROSKA_STREAM_METADATA = [
    "      ENCODER         : synthetic ffv1",
    "      DURATION        : 00:00:01.000000000"
  ].join("\n");

  it("filters uppercase encoder and duration tags from a successful FFV1 segment", () => {
    expect(summarizeSuccessfulEncodeStderr(MATROSKA_STREAM_METADATA)).toBe("");
  });

  it("keeps a Matroska muxer diagnostic beside routine stream metadata", () => {
    const warned = [
      MATROSKA_STREAM_METADATA,
      "[matroska @ 0x1] Error writing trailer: Invalid argument"
    ].join("\n");
    expect(summarizeSuccessfulEncodeStderr(warned))
      .toBe("[matroska @ [address]] Error writing trailer: Invalid argument");
  });
});
