import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeImageSequenceWithPolicy } from "./encode-policy";
import {
  assertQualityFfmpegMediaInput,
  assertSelfContainedFfmpegMediaInputs,
  MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES,
  qualityFfmpegMediaInputArgs,
  selfContainedFfmpegMediaInputArgs,
  snapshotSelfContainedFfmpegMediaInput,
  trackingFfmpegMediaInputArgs
} from "./ffmpeg-media-input-fence";
import { probeMedia } from "./index";
import { prepareStreamingFinalEncodePolicy } from "./streaming-final-encode-policy";

const chmodFault = { path: "", armed: false };
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (path: string, mode: number) => {
      if (chmodFault.armed && path === chmodFault.path && mode === 0o400) {
        chmodFault.armed = false;
        throw new Error("injected immutable chmod failure");
      }
      await actual.chmod(path, mode);
    }
  };
});

const roots: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
afterEach(async () => {
  chmodFault.armed = false;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `shellx-motion-media-fence-${prefix}-`));
  roots.push(root);
  return root;
}

describe("self-contained FFmpeg media inputs", () => {
  it("accepts a real self-contained WAV and locks it to the WAV demuxer", async () => {
    const audio = join(repositoryRoot, "templates", "shellx-product-pack", "audio-launch", "assets", "audio", "shellx-launch-tone.wav");
    const inputRoots = [await realpath(dirname(audio))];
    await expect(assertSelfContainedFfmpegMediaInputs([audio], inputRoots)).resolves.toBeUndefined();
    expect(selfContainedFfmpegMediaInputArgs(audio)).toEqual(["-protocol_whitelist", "file", "-format_whitelist", "wav", "-i", audio]);
    expect(["flac", "mp3", "oga", "ogg", "opus"].map((extension) => selfContainedFfmpegMediaInputArgs(join(dirname(audio), `audio.${extension}`)).slice(2, 4))).toEqual([
      ["-format_whitelist", "flac"], ["-format_whitelist", "mp3"], ["-format_whitelist", "ogg"], ["-format_whitelist", "ogg"], ["-format_whitelist", "ogg"]
    ]);
    expect(() => selfContainedFfmpegMediaInputArgs(join(dirname(audio), "video.mp4"))).toThrow(/WAV, FLAC, MP3, Ogg, or Opus/);
  });

  it("takes a bounded content-addressed private copy before a caller can substitute the admitted pathname", async () => {
    const root = await scratch("snapshot-red-substitution");
    const audio = join(root, "audio.wav");
    const admittedBytes = validWav();
    await writeFile(audio, admittedBytes);

    const snapshot = await snapshotSelfContainedFfmpegMediaInput(audio, [root], "final-audio");
    await writeFile(audio, Buffer.from("RED replacement bytes", "utf8"));

    expect(snapshot.path).toMatch(/shellx-motion-ffmpeg-media-[^/]+\/[a-f0-9]{64}\.wav$/);
    expect(snapshot.sha256).toBe(createHash("sha256").update(admittedBytes).digest("hex"));
    await expect(readFile(snapshot.path)).resolves.toEqual(admittedBytes);
    await snapshot.release();
    await expect(readFile(snapshot.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses a caller-owned aggregate root without deleting that root on release or a one-byte refusal", async () => {
    const root = await scratch("caller-owned-snapshot-root");
    const source = join(root, "audio.wav");
    const operationRoot = join(root, "operation");
    await Promise.all([writeFile(source, validWav()), mkdir(operationRoot, { mode: 0o700 })]);
    const authority = { path: operationRoot, async assertCurrent() {} };
    const bytes = validWav().byteLength;
    await expect(snapshotSelfContainedFfmpegMediaInput(source, [root], "final-audio", {
      stagingRoot: operationRoot, stagingAuthority: authority, maxBytes: bytes - 1
    })).rejects.toThrow(`${bytes - 1} bytes`);
    await expect(readdir(operationRoot)).resolves.toEqual([]);
    const snapshot = await snapshotSelfContainedFfmpegMediaInput(source, [root], "final-audio", {
      stagingRoot: operationRoot, stagingAuthority: authority, maxBytes: bytes
    });
    expect(dirname(snapshot.path)).toBe(operationRoot);
    await snapshot.release();
    await expect(lstat(operationRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readdir(operationRoot)).resolves.toEqual([]);
  });

  it("removes a published snapshot without deleting its caller-owned root when immutable chmod fails", async () => {
    const root = await scratch("caller-owned-post-rename-failure");
    const source = join(root, "audio.wav");
    const operationRoot = join(root, "operation");
    const bytes = validWav();
    await Promise.all([writeFile(source, bytes), mkdir(operationRoot, { mode: 0o700 })]);
    const authority = { path: operationRoot, async assertCurrent() {} };
    chmodFault.path = join(operationRoot, `${createHash("sha256").update(bytes).digest("hex")}.wav`);
    chmodFault.armed = true;
    await expect(snapshotSelfContainedFfmpegMediaInput(source, [root], "final-audio", {
      stagingRoot: operationRoot, stagingAuthority: authority
    })).rejects.toThrow("injected immutable chmod failure");
    await expect(lstat(operationRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readdir(operationRoot)).resolves.toEqual([]);
  });

  it("matches the 16 GiB final-artifact ceiling and rejects a larger snapshot before copying", async () => {
    const root = await scratch("snapshot-size-cap");
    const audio = join(root, "oversized.wav");
    await writeFile(audio, validWav());
    await truncate(audio, MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES + 1);

    expect(MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES).toBe(16 * 1024 * 1024 * 1024);
    await expect(snapshotSelfContainedFfmpegMediaInput(audio, [root], "final-audio"))
      .rejects.toThrow(`${MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES} bytes`);
  });

  it("fails closed on malformed and nested-reference ISO/EBML containers, protocol indirection, and symlinked media", async ({ skip }) => {
    const root = await scratch("hostile");
    const outside = await scratch("outside");
    const manifest = join(root, "nested.mp4");
    const referenceMovie = join(root, "reference.mp4");
    const linkedSegment = join(root, "linked.mkv");
    const chapterLinkedSegment = join(root, "chapter-linked.webm");
    const unknownSizeSegment = join(root, "unknown-size.mkv");
    const malformedMovie = join(root, "malformed.mp4");
    const linked = join(root, "linked.wav");
    const outsideAudio = join(outside, "outside.wav");
    await Promise.all([
      writeFile(manifest, "#EXTM3U\nfile:///etc/passwd\n"),
      writeFile(referenceMovie, externalDataReferenceMovie()),
      writeFile(linkedSegment, linkedMatroskaSegment()),
      writeFile(chapterLinkedSegment, chapterLinkedMatroskaSegment()),
      writeFile(unknownSizeSegment, unknownSizeMatroskaSegment()),
      writeFile(malformedMovie, malformedIsoMovie()),
      writeFile(outsideAudio, validWav())
    ]);
    await expect(assertSelfContainedFfmpegMediaInputs([manifest], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([referenceMovie], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([linkedSegment], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([chapterLinkedSegment], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([unknownSizeSegment], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([malformedMovie], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs([join(root, "..", "outside", "outside.wav")], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertSelfContainedFfmpegMediaInputs(["file:///etc/passwd.wav"], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    try {
      await symlink(outsideAudio, linked);
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip("The standard Windows test account cannot create file symbolic links.");
        return;
      }
      throw error;
    }
    await expect(assertSelfContainedFfmpegMediaInputs([linked], [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
    await expect(assertQualityFfmpegMediaInput(linked, [root])).rejects.toMatchObject({ code: "unsafe_input_path" });
  });

  it("admits expected quality delivery formats with fixed file-only demuxers and disables hostile MOV data references", async () => {
    const root = await scratch("quality-delivery");
    const hostileMp4 = join(root, "hostile.mp4");
    const linkedWebm = join(root, "linked.webm");
    const chapterLinkedWebm = join(root, "chapter-linked.webm");
    const wav = join(root, "delivery.wav");
    const jpeg = join(root, "delivery.jpg");
    await Promise.all([
      writeFile(hostileMp4, externalDataReferenceMovie()),
      writeFile(linkedWebm, linkedMatroskaSegment()),
      writeFile(chapterLinkedWebm, chapterLinkedMatroskaSegment()),
      writeFile(wav, validWav()),
      writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    ]);
    await expect(Promise.all([
      assertQualityFfmpegMediaInput(hostileMp4, [root]),
      assertQualityFfmpegMediaInput(linkedWebm, [root]),
      assertQualityFfmpegMediaInput(chapterLinkedWebm, [root]),
      assertQualityFfmpegMediaInput(wav, [root]),
      assertQualityFfmpegMediaInput(jpeg, [root])
    ])).resolves.toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(qualityFfmpegMediaInputArgs(hostileMp4)).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "mov",
      "-enable_drefs", "0", "-use_absolute_path", "0", "-i", hostileMp4
    ]);
    expect(qualityFfmpegMediaInputArgs(linkedWebm)).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "matroska", "-i", linkedWebm
    ]);
    expect(qualityFfmpegMediaInputArgs(chapterLinkedWebm)).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "matroska", "-i", chapterLinkedWebm
    ]);
    expect(qualityFfmpegMediaInputArgs(wav)).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "wav", "-i", wav
    ]);
    expect(qualityFfmpegMediaInputArgs(jpeg)).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "image2", "-f", "image2", "-pattern_type", "none", "-i", jpeg
    ]);
    expect(qualityFfmpegMediaInputArgs(join(root, "delivery.jpeg"))).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "image2", "-f", "image2", "-pattern_type", "none", "-i", join(root, "delivery.jpeg")
    ]);

    const commands: Array<{ args: string[] }> = [];
    await expect(probeMedia(hostileMp4, {
      inputRoots: [root],
      admittedQualityInput: true,
      runner: async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: JSON.stringify({ streams: [], format: { format_name: "mov,mp4" } }), stderr: "" };
      }
    })).resolves.toMatchObject({ ok: true, path: hostileMp4 });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toContain("-enable_drefs");
    expect(commands[0]?.args).toContain("-use_absolute_path");
    expect(commands[0]?.args).toContain("-protocol_whitelist");
  });

  it("probes a real one-frame JPEG through the fixed image2 demuxer", async () => {
    const root = await scratch("quality-jpeg-probe");
    const jpeg = join(root, "one-frame.jpeg");
    const generated = await runTool("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=2x2:d=0.04:r=25",
      "-frames:v", "1", "-update", "1", jpeg
    ], 5_000);
    expect(generated.completed).toBe(true);
    expect(generated.exitCode).toBe(0);

    await expect(probeMedia(jpeg, { inputRoots: [root], admittedQualityInput: true })).resolves.toMatchObject({
      ok: true,
      path: jpeg,
      codec: "mjpeg",
      width: 2,
      height: 2,
      container: "image2"
    });
  });

  it("locks tracking MP4, MOV, Matroska, and WebM snapshots to file-only fixed demuxers", () => {
    for (const extension of ["mp4", "mov"]) {
      expect(trackingFfmpegMediaInputArgs(`/private/source.${extension}`)).toEqual([
        "-protocol_whitelist", "file", "-format_whitelist", "mov",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-i", `/private/source.${extension}`
      ]);
    }
    expect(trackingFfmpegMediaInputArgs("/private/source.webm")).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "matroska", "-i", "/private/source.webm"
    ]);
    expect(trackingFfmpegMediaInputArgs("/private/source.mkv")).toEqual([
      "-protocol_whitelist", "file", "-format_whitelist", "matroska", "-i", "/private/source.mkv"
    ]);
    expect(() => trackingFfmpegMediaInputArgs("/private/playlist.m3u8")).toThrow(/MP4, MOV, Matroska, or WebM/);
  });

  it.skipIf(process.platform === "win32")("parses hostile linked-segment and chapter metadata without opening its external FIFO", async () => {
    const root = await scratch("quality-matroska-external-open");
    const outside = await scratch("quality-matroska-outside");
    const fifo = join(outside, "must-not-open.webm");
    const source = join(root, "source.webm");
    const hostile = join(root, "hostile.webm");
    await makeFifo(fifo);
    await createTinyWebm(source);
    await writeFile(hostile, injectIntoMatroskaSegment(await readFile(source), hostileMatroskaMetadata(fifo)));
    const result = await runTool("ffprobe", [
      "-v", "error", ...qualityFfmpegMediaInputArgs(hostile).slice(0, -2),
      "-show_entries", "format_tags=title:chapter", "-show_chapters", "-of", "json", hostile
    ], 1_500);
    expect(result.completed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hostile-metadata-parsed");
    expect((JSON.parse(result.stdout) as { chapters?: unknown[] }).chapters).toHaveLength(1);
  });

  it("refuses a reference-bearing MP4 before the legacy encode runner is invoked", async () => {
    const root = await scratch("preflight");
    const referenceMovie = join(root, "attack.mp4");
    await writeFile(referenceMovie, externalDataReferenceMovie());
    let runnerCalls = 0;
    const result = await encodeImageSequenceWithPolicy({
      packageId: "pkg_media_fence",
      framesDir: root,
      fps: 1,
      width: 1,
      height: 1,
      durationMs: 1_000,
      outputPath: join(root, "output.mp4"),
      audio: { path: referenceMovie },
      inputRoots: [root],
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_input_path" } });
    expect(runnerCalls).toBe(0);
  });

  it("returns the same typed refusal before a streamed FFmpeg command is prepared", async () => {
    const root = await scratch("streamed-preflight");
    const referenceMovie = join(root, "attack.mp4");
    await writeFile(referenceMovie, externalDataReferenceMovie());
    let runnerCalls = 0;
    const result = await prepareStreamingFinalEncodePolicy({
      input: { fps: 1, width: 1, height: 1, durationMs: 1_000, outputPath: join(root, "output.mp4"), audio: { path: referenceMovie }, inputRoots: [root] },
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_input_path" } });
    expect(runnerCalls).toBe(0);
  });
});

function externalDataReferenceMovie(): Buffer {
  const externalUrl = isoBox("url ", Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("file:///outside.wav\0")]));
  const dref = isoBox("dref", Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), externalUrl]));
  const dinf = isoBox("dinf", dref);
  const minf = isoBox("minf", dinf);
  const mdia = isoBox("mdia", minf);
  const trak = isoBox("trak", mdia);
  return Buffer.concat([isoBox("ftyp", Buffer.from("isom\0\0\0\0isom")), isoBox("moov", trak)]);
}

function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + header.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function linkedMatroskaSegment(target = "outside.mkv"): Buffer {
  const link = ebmlElement([0x73, 0x84], Buffer.from(target));
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], link);
  return Buffer.concat([ebmlElement([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(0)), ebmlElement([0x18, 0x53, 0x80, 0x67], info)]);
}

function chapterLinkedMatroskaSegment(): Buffer {
  const chapterTarget = ebmlElement([0x6e, 0x67], Buffer.alloc(16, 1));
  const chapterAtom = ebmlElement([0xb6], chapterTarget);
  const edition = ebmlElement([0x45, 0xb9], chapterAtom);
  const chapters = ebmlElement([0x10, 0x43, 0xa7, 0x70], edition);
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], Buffer.alloc(0));
  return Buffer.concat([ebmlElement([0x1a, 0x45, 0xdf, 0xa3], Buffer.alloc(0)), ebmlElement([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, chapters]))]);
}

function hostileMatroskaMetadata(linkTarget: string): Buffer {
  const info = ebmlElement([0x15, 0x49, 0xa9, 0x66], Buffer.concat([
    ebmlElement([0x7b, 0xa9], Buffer.from("hostile-metadata-parsed")),
    ebmlElement([0x73, 0x84], Buffer.from(linkTarget))
  ]));
  const chapter = ebmlElement([0xb6], Buffer.concat([
    ebmlElement([0x73, 0xc4], Buffer.from([1])),
    ebmlElement([0x91], Buffer.from([0])),
    ebmlElement([0x92], Buffer.from([1])),
    ebmlElement([0x6e, 0x67], Buffer.alloc(16, 1))
  ]));
  const chapters = ebmlElement([0x10, 0x43, 0xa7, 0x70], ebmlElement([0x45, 0xb9], chapter));
  return Buffer.concat([info, chapters]);
}

function injectIntoMatroskaSegment(media: Buffer, metadata: Buffer): Buffer {
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const segmentOffset = media.indexOf(segment);
  if (segmentOffset < 0) throw new Error("Tiny WebM fixture is missing a Segment element.");
  const firstSizeByte = media[segmentOffset + segment.length];
  let sizeLength = 1;
  for (let marker = 0x80; sizeLength <= 8 && (firstSizeByte & marker) === 0; marker >>= 1) sizeLength += 1;
  if (sizeLength > 8) throw new Error("Tiny WebM fixture has an invalid Segment size.");
  const insertAt = segmentOffset + segment.length + sizeLength;
  return Buffer.concat([media.subarray(0, insertAt), metadata, media.subarray(insertAt)]);
}

function unknownSizeMatroskaSegment(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff]);
}

function malformedIsoMovie(): Buffer {
  const malformedLength = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76]);
  return Buffer.concat([isoBox("ftyp", Buffer.from("isom\0\0\0\0isom")), malformedLength]);
}

function ebmlElement(id: number[], payload: Buffer): Buffer {
  const size = ebmlSize(payload.length);
  return Buffer.concat([Buffer.from(id), size, payload]);
}

function ebmlSize(payloadLength: number): Buffer {
  for (let sizeLength = 1; sizeLength <= 8; sizeLength += 1) {
    // All value bits set is the EBML unknown-size sentinel, so the largest known value is one below it.
    if (payloadLength > (2 ** (7 * sizeLength)) - 2) continue;
    const size = Buffer.alloc(sizeLength);
    let remaining = payloadLength;
    for (let index = sizeLength - 1; index >= 0; index -= 1) {
      size[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 0x100);
    }
    size[0] |= 1 << (8 - sizeLength);
    return size;
  }
  throw new Error("test fixture EBML payload is too large to encode.");
}

function validWav(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8, "latin1");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1");
  return bytes;
}

async function makeFifo(path: string): Promise<void> {
  const child = spawn("mkfifo", [path], { shell: false, stdio: "ignore" });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`mkfifo failed with exit code ${exitCode}.`);
}

async function createTinyWebm(path: string): Promise<void> {
  const result = await runTool("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=2x2:d=0.04:r=25",
    "-frames:v", "1", "-c:v", "libvpx-vp9", "-f", "webm", "-y", path
  ], 5_000);
  if (!result.completed || result.exitCode !== 0) throw new Error(`Could not create tiny WebM fixture: ${result.stderr}`);
}

async function runTool(executable: string, args: string[], timeoutMs: number): Promise<{
  completed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const outcome = await Promise.race([
    closed.then((exitCode) => ({ completed: true as const, exitCode })),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
  if (outcome !== false) {
    return { completed: true, exitCode: outcome.exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  }
  child.kill("SIGKILL");
  await closed;
  return { completed: false, exitCode: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}
