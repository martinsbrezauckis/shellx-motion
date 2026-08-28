/** Exact source facts captured before a caller reserves aggregate staging space. */
export interface FfmpegMediaInputInspection {
  sourcePath: string;
  path: string;
  byteLength: number;
  device: number;
  inode: number;
}

/** A process-private immutable FFmpeg input copy. */
export interface FfmpegMediaInputSnapshot {
  sourcePath: string;
  path: string;
  sha256: string;
  byteLength: number;
  root: string;
  release(): Promise<void>;
}

/** Optional caller-owned private root and lower copy bound for an aggregate staging operation. */
export interface FfmpegMediaInputSnapshotOptions {
  stagingRoot?: string;
  /** Internal authority captured by the enclosing operation; do not accept this from public arguments. */
  stagingAuthority?: RetainedDirectoryAuthority;
  maxBytes?: number;
  expected?: FfmpegMediaInputInspection;
}
import type { RetainedDirectoryAuthority } from "@shellx-motion/core";
