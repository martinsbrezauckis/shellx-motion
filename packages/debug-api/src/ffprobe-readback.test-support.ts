/**
 * ffprobe answers and assertions for debug-API tests that inject a fake FFmpeg runner.
 *
 * Role: under the current contract a successful encode reads the delivered file's colour tags back with
 * ffprobe (`verifyDeliveredColor`, now default-on), so every debug command that renders through an
 * injected runner is handed TWO commands: the encode, and a readback that must not be treated as
 * one. A runner written before the readback existed does
 * `writeFile(command.args.at(-1), fakeMp4Bytes(...))`, and the readback's last argument is the
 * DELIVERED FILE — so an unguarded runner rewrites the artifact it was asked to inspect.
 *
 * {@link expectEncodeThenColorReadback} exists so the four connector call sites in `index.test.ts`
 * assert the SHAPE of that pair (encode, then a readback of exactly the file the encode wrote)
 * rather than each bumping a length from 1 to 2 — a bumped number accepts any second subprocess,
 * which is the assertion this feature would most easily hide behind.
 *
 * Deliberately duplicated from `packages/connectors/src/ffprobe-readback.test-support.ts` rather
 * than imported: that module is test scaffolding excluded from its package's `exports` map and from
 * the published tarball, so there is no import path from here that survives a clean install.
 *
 * Dependencies: `vitest` for the assertion helper. Primary caller: `./index.test.ts`.
 */
import { expect } from "vitest";

/** A recorded FFmpeg/ffprobe invocation, reduced to what these helpers read. */
interface RecordedCommand {
  executable: string;
  args: string[];
  shell?: boolean;
}

/** Whether an injected runner is being handed the delivered-colour readback rather than an encode. */
export function isDeliveredColorReadback(command: { args: readonly string[] }): boolean {
  return command.args.includes("-show_streams");
}

/**
 * A minimal but well-formed ffprobe `-print_format json -show_streams -show_format` payload
 * describing a file that carries everything `sdr-bt709` promises.
 */
export function ffprobeReadbackStdout(): string {
  return JSON.stringify({
    streams: [{
      codec_type: "video",
      codec_name: "h264",
      width: 640,
      height: 360,
      pix_fmt: "yuv420p",
      avg_frame_rate: "2/1",
      duration: "1.000000",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      color_range: "tv"
    }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.000000" }
  });
}

/**
 * Assert an injected runner saw exactly one encode followed by the readback of the file it wrote.
 *
 * @param commands Every non-probe command the runner recorded, in order.
 * @param options.executable The FFmpeg executable the encode must have used.
 * @param options.encodeArgs Arguments the encode must contain (e.g. `["-frames:v", "2"]`).
 */
export function expectEncodeThenColorReadback(
  commands: RecordedCommand[],
  options: { executable: string; encodeArgs?: string[] }
): void {
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({ executable: options.executable, shell: false });
  if (options.encodeArgs) expect(commands[0]?.args).toEqual(expect.arrayContaining(options.encodeArgs));
  expect(commands[1]).toMatchObject({ executable: expect.stringContaining("ffprobe"), shell: false });
  expect(commands[1]?.args).toEqual(expect.arrayContaining(["-show_streams"]));
  // The readback must read the file the encode just wrote — the staged artifact, before the move.
  expect(commands[1]?.args.at(-1)).toBe(commands[0]?.args.at(-1));
}
