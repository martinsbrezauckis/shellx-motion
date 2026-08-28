import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { OutputDirectoryReservation, type RetainedDirectoryAuthority } from "@shellx-motion/core";
import {
  FfmpegMediaInputRefusal,
  inspectSelfContainedFfmpegMediaInput,
  MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES,
  MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES
} from "./ffmpeg-media-input-fence.js";
import type {
  FfmpegMediaInputInspection,
  FfmpegMediaInputSnapshot,
  FfmpegMediaInputSnapshotOptions
} from "./ffmpeg-media-input-snapshot-types.js";

type MediaKind = "final-audio" | "quality" | "tracking-video";

/**
 * Make one immutable media copy. A supplied root is caller-owned: this helper deletes only its
 * exact files, never that root. Output topology admission supplies the Windows DACL and POSIX
 * authority checks; the default legacy root keeps historical non-GPU behaviour unchanged.
 */
export async function snapshotSelfContainedFfmpegMediaInput(
  input: string,
  inputRoots: readonly string[],
  kind: MediaKind,
  options: FfmpegMediaInputSnapshotOptions = {}
): Promise<FfmpegMediaInputSnapshot> {
  const inspected = await inspectSelfContainedFfmpegMediaInput(input, inputRoots, kind);
  if (options.expected && !sameInspection(inspected, options.expected)) {
    throw new FfmpegMediaInputRefusal("FFmpeg media input changed after aggregate staging preflight.");
  }
  const limit = snapshotLimit(kind, options.maxBytes);
  if (inspected.byteLength > limit) throw sizeRefusal(kind, limit);
  const suppliedRoot = options.stagingRoot;
  const suppliedAuthority = options.stagingAuthority;
  if (suppliedAuthority && suppliedRoot !== undefined && suppliedAuthority.path !== suppliedRoot) {
    throw new FfmpegMediaInputRefusal("FFmpeg media snapshot authority does not match its caller-supplied staging root.");
  }
  const reservation: RetainedDirectoryAuthority | undefined = suppliedAuthority ?? (suppliedRoot === undefined ? undefined : await OutputDirectoryReservation.acquire(suppliedRoot, {
    requireExisting: true, requirePrivate: true, requireExclusiveChildAuthority: true, allowExistingContents: true
  }));
  const root = reservation?.path ?? await mkdtemp(join(tmpdir(), "shellx-motion-ffmpeg-media-"));
  let partial: string | undefined;
  let published: string | undefined;
  let retained = false;
  try {
    if (!reservation) await chmod(root, 0o700);
    await reservation?.assertCurrent();
    const extension = extname(inspected.path).toLowerCase() || ".media";
    partial = join(root, `.snapshot-${randomUUID()}${extension}`);
    const source = await open(inspected.path, "r");
    try {
      const before = await source.stat();
      if (!sameSource(before, inspected)) throw new FfmpegMediaInputRefusal("FFmpeg media input changed while it was being admitted.");
      const destination = await open(partial, "wx", 0o600);
      try {
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          if (position > limit) throw new FfmpegMediaInputRefusal(`FFmpeg ${kindLabel(kind)} exceeds the ${limit}-byte snapshot limit.`);
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk);
          await destination.write(chunk);
        }
        const after = await source.stat();
        if (!sameSource(after, inspected) || position !== inspected.byteLength) {
          throw new FfmpegMediaInputRefusal("FFmpeg media input changed while Motion captured its immutable snapshot.");
        }
        await destination.sync();
        await reservation?.assertCurrent();
        const sha256 = digest.digest("hex");
        published = join(root, `${sha256}${extension}`);
        if (reservation && await lstat(published).then(() => true, () => false)) {
          published = join(root, `${sha256}-${randomUUID()}${extension}`);
        }
        await rename(partial, published);
        partial = undefined;
        await chmod(published, 0o400);
        retained = true;
        const path = published;
        return {
          sourcePath: input, path, sha256, byteLength: position, root,
          release: async () => {
            await reservation?.assertCurrent();
            await rm(reservation ? path : root, { recursive: !reservation, force: true });
          }
        };
      } finally {
        await destination.close().catch(() => undefined);
      }
    } finally {
      await source.close().catch(() => undefined);
    }
  } finally {
    if (!retained) {
      const ownedPath = partial ?? published;
      if (reservation) {
        if (ownedPath) await rm(ownedPath, { force: true }).catch(() => undefined);
      } else {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

function sameInspection(left: FfmpegMediaInputInspection, right: FfmpegMediaInputInspection): boolean {
  return left.path === right.path && left.byteLength === right.byteLength && left.device === right.device && left.inode === right.inode;
}
function sameSource(stat: Awaited<ReturnType<typeof lstat>>, expected: FfmpegMediaInputInspection): boolean {
  return stat.isFile() && stat.dev === expected.device && stat.ino === expected.inode && stat.size === expected.byteLength;
}
function snapshotLimit(kind: MediaKind, value: number | undefined): number {
  const maximum = kind === "tracking-video" ? MAX_TRACKING_VIDEO_INPUT_SNAPSHOT_BYTES : MAX_FFMPEG_MEDIA_INPUT_SNAPSHOT_BYTES;
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new FfmpegMediaInputRefusal(`FFmpeg ${kindLabel(kind)} snapshot limit must be an integer within 1..${maximum}.`);
  return value;
}
function sizeRefusal(kind: MediaKind, limit: number): FfmpegMediaInputRefusal {
  return new FfmpegMediaInputRefusal(`FFmpeg ${kindLabel(kind)} must contain 1..${limit} bytes.`);
}
function kindLabel(kind: MediaKind): string {
  return kind === "quality" ? "quality input" : kind === "tracking-video" ? "tracking input" : "media input";
}
