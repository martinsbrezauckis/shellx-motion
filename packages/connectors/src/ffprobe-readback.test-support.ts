/**
 * ffprobe answers for connector tests that inject a fake FFmpeg runner.
 *
 * Role: under the current contract a successful encode reads the delivered file's colour tags back with
 * ffprobe (`verifyDeliveredColor`, now default-on), so a connector test that injects a runner is
 * handed TWO kinds of command: the encode, and a readback that must not be treated as one.
 *
 * Why this is not optional bookkeeping. A fake runner written before the readback existed does
 * `writeFile(command.args.at(-1), fakeMp4Bytes(...))` — and the readback's last argument is the
 * DELIVERED FILE, so an unguarded runner rewrites the artifact it was asked to inspect. Worse, the
 * runners that assert on the command they receive (`expect(command.executable).toBe(ffmpeg)`) throw
 * those assertions inside `probeMedia`, where `gradeDeliveredColor` deliberately swallows every
 * readback failure — so the expectation fails silently and the test keeps passing on a lie.
 *
 * Answering the readback with a real ffprobe payload also makes `output.color.observed` a genuine
 * observation in these tests rather than an absent measurement, which is the whole point of the
 * feature: `output.color` alone is the preset's intent, and intent is not evidence.
 *
 * Dependencies: none. Primary callers: the connector test suites with an injected `ffmpegRunner`.
 */

/** The ffprobe colour keys, exactly as ffprobe spells them on a video stream. */
export interface DeliveredColorTags {
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
}

/** A file that carries everything `sdr-bt709` promises. What Linux FFmpeg 6.1.1 delivers. */
export const SDR_BT709_DELIVERED_TAGS: DeliveredColorTags = {
  color_space: "bt709",
  color_transfer: "bt709",
  color_primaries: "bt709",
  color_range: "tv"
};

/**
 * The shape measured on a Windows FFmpeg N-125773 (8.x dev) build during cross-host verification: matrix and range
 * survive to the container, `transfer` and `primaries` do not — while the receipt still declared
 * `sdr-bt709`. This is the exact reading the honesty check exists to catch.
 */
export const UNTAGGED_TRANSFER_DELIVERED_TAGS: DeliveredColorTags = {
  color_space: "bt709",
  color_range: "tv"
};

/**
 * Whether an injected runner is being handed the delivered-colour readback rather than an encode.
 *
 * Matched on `-show_streams`, which only the ffprobe command carries.
 */
export function isDeliveredColorReadback(command: { args: readonly string[] }): boolean {
  return command.args.includes("-show_streams");
}

/**
 * A minimal but well-formed ffprobe `-print_format json -show_streams -show_format` payload.
 *
 * @param tags Colour tags the delivered file should report. Omit a key to say the file lacks it.
 * @returns JSON text suitable as an injected runner's `stdout` for a readback command.
 */
export function ffprobeReadbackStdout(tags: DeliveredColorTags = SDR_BT709_DELIVERED_TAGS): string {
  return JSON.stringify({
    streams: [{
      codec_type: "video",
      codec_name: "h264",
      width: 640,
      height: 360,
      pix_fmt: "yuv420p",
      avg_frame_rate: "2/1",
      duration: "1.000000",
      ...tags
    }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.000000" }
  });
}
