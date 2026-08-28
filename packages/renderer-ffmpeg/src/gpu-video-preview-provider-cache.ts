import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import type { RetainedDirectoryAuthority } from "@shellx-motion/core";
import { trackingFfmpegMediaInputArgs } from "./ffmpeg-media-input-fence.js";
import { resolveFfmpegExecutable } from "./index.js";
import {
  MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES,
  MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES,
  MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES,
  abortReason,
  privateChildPath,
  rationalSeconds,
  rgbaBytes,
  throwIfAborted,
  type GpuPreviewFfmpegRunner,
  type PreviewSource
} from "./gpu-video-preview-provider-primitives.js";
import type { GpuPreviewVideoCacheStats } from "./gpu-video-preview-provider-contracts.js";

export interface DecodedVideoFrame { key: string; rgba: Buffer; sha256: string; bytes: number; decodedPts: bigint; source: PreviewSource; }
interface DecodeWork { key: string; source: PreviewSource; decodedPts: bigint; controller: AbortController; waiters: Set<symbol>; settled: boolean; promise: Promise<DecodedVideoFrame>; resolve(value: DecodedVideoFrame): void; reject(reason: unknown): void; }
export interface GpuPreviewVideoFrameCacheOptions {
  runner: GpuPreviewFfmpegRunner;
  privateRoot(): string | undefined;
  privateAuthority(): RetainedDirectoryAuthority | undefined;
  onStats(stats: Readonly<GpuPreviewVideoCacheStats>): void;
}

/** One serial raw-RGBA decoder plus deterministic completed-entry LRU. */
export class GpuPreviewVideoFrameCache {
  readonly #runner: GpuPreviewFfmpegRunner;
  readonly #privateRoot: () => string | undefined;
  readonly #privateAuthority: () => RetainedDirectoryAuthority | undefined;
  readonly #onStats: (stats: Readonly<GpuPreviewVideoCacheStats>) => void;
  readonly #cache = new Map<string, DecodedVideoFrame>();
  readonly #inFlight = new Map<string, DecodeWork>();
  readonly #queue: DecodeWork[] = [];
  readonly #stats: GpuPreviewVideoCacheStats = { hits: 0, misses: 0, evictions: 0, deduplicated: 0, entries: 0, bytes: 0, highWaterEntries: 0, highWaterBytes: 0, inFlightBytes: 0, inFlightHighWaterBytes: 0 };
  #decoding = false;
  #closed = false;

  constructor(input: GpuPreviewVideoFrameCacheOptions) {
    this.#runner = input.runner; this.#privateRoot = input.privateRoot; this.#privateAuthority = input.privateAuthority; this.#onStats = input.onStats;
  }

  async get(key: string, source: PreviewSource, decodedPts: bigint, signal: AbortSignal): Promise<{ entry: DecodedVideoFrame; cache: "hit" | "miss" | "deduplicated" }> {
    if (this.#closed) throw new Error("GPU preview video frame cache is closed.");
    if (signal.aborted) throw abortReason(signal);
    const prior = this.#cache.get(key);
    if (prior) { this.#cache.delete(key); this.#cache.set(key, prior); this.#count("hits"); return { entry: prior, cache: "hit" }; }
    const existing = this.#inFlight.get(key), cache = existing ? "deduplicated" as const : "miss" as const;
    if (existing) { this.#stats.deduplicated += 1; this.#emit(); } else this.#count("misses");
    return { entry: await this.#wait(existing ?? this.#start(key, source, decodedPts), signal), cache };
  }

  abort(reason: unknown): void { for (const work of this.#inFlight.values()) work.controller.abort(reason); }
  async close(): Promise<number> {
    if (this.#closed) return 0;
    this.#closed = true; this.abort(new Error("GPU preview video provider closed."));
    await Promise.allSettled([...this.#inFlight.values()].map(async (work) => await work.promise));
    const released = this.#cache.size; this.#cache.clear(); this.#sync(); return released;
  }

  #start(key: string, source: PreviewSource, decodedPts: bigint): DecodeWork {
    const controller = new AbortController(); let resolveWork!: (value: DecodedVideoFrame) => void; let rejectWork!: (reason: unknown) => void;
    const work: DecodeWork = { key, source, decodedPts, controller, waiters: new Set(), settled: false, promise: new Promise((resolveWorkInner, rejectWorkInner) => { resolveWork = resolveWorkInner; rejectWork = rejectWorkInner; }), resolve: (value) => resolveWork(value), reject: (reason) => rejectWork(reason) };
    this.#inFlight.set(key, work); this.#queue.push(work); void this.#drain(); return work;
  }

  async #wait(work: DecodeWork, signal: AbortSignal): Promise<DecodedVideoFrame> {
    if (signal.aborted) throw abortReason(signal);
    const waiter = Symbol("gpu-preview-video-waiter"); work.waiters.add(waiter);
    return await new Promise((resolveWaiter, rejectWaiter) => {
      let done = false;
      const finish = () => { if (done) return; done = true; work.waiters.delete(waiter); signal.removeEventListener("abort", abort); };
      const abort = () => { finish(); if (!work.settled && work.waiters.size === 0) work.controller.abort(abortReason(signal)); rejectWaiter(abortReason(signal)); };
      signal.addEventListener("abort", abort, { once: true });
      work.promise.then((value) => { if (!done) { finish(); resolveWaiter(value); } }, (error) => { if (!done) { finish(); rejectWaiter(error); } });
      if (signal.aborted) abort();
    });
  }

  async #drain(): Promise<void> {
    if (this.#decoding) return;
    this.#decoding = true;
    try {
      for (;;) {
        const work = this.#queue.shift(); if (!work) return;
        if (work.controller.signal.aborted || this.#closed) { work.settled = true; this.#inFlight.delete(work.key); work.reject(abortReason(work.controller.signal)); continue; }
        try {
          const entry = await this.#decode(work.key, work.source, work.decodedPts, work.controller.signal);
          if (work.controller.signal.aborted || this.#closed) throw abortReason(work.controller.signal);
          this.#insert(entry); work.settled = true; this.#inFlight.delete(work.key); work.resolve(entry);
        } catch (error) { work.settled = true; this.#inFlight.delete(work.key); work.reject(error); }
      }
    } finally { this.#decoding = false; }
  }

  async #decode(key: string, source: PreviewSource, decodedPts: bigint, signal: AbortSignal): Promise<DecodedVideoFrame> {
    const bytes = rgbaBytes(source.width, source.height);
    if (bytes > MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES) throw new Error(`GPU preview video frame exceeds the ${MAX_GPU_PREVIEW_VIDEO_IN_FLIGHT_RGBA_BYTES}-byte in-flight RGBA limit.`);
    throwIfAborted(signal); await this.#privateAuthority()?.assertCurrent();
    const path = privateChildPath(this.#privateRoot(), `.decode-${randomUUID()}.rgba`);
    this.#stats.inFlightBytes = bytes; this.#stats.inFlightHighWaterBytes = Math.max(this.#stats.inFlightHighWaterBytes, bytes); this.#emit();
    try {
      const result = await this.#runner({ executable: resolveFfmpegExecutable(), shell: false, args: ["-v", "error", "-nostdin", "-n", ...trackingFfmpegMediaInputArgs(source.snapshot.path), "-ss", rationalSeconds(decodedPts * source.timeBase.numerator, source.timeBase.denominator), "-map", "0:v:0", "-an", "-sn", "-dn", "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", path] }, signal);
      throwIfAborted(signal);
      if (result.exitCode !== 0) throw new Error("GPU preview FFmpeg decoder refused the immutable source frame.");
      await this.#privateAuthority()?.assertCurrent();
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== bytes) throw new Error("GPU preview FFmpeg decoder did not produce exactly one tightly packed RGBA frame.");
      const rgba = await readFile(path); throwIfAborted(signal);
      if (rgba.byteLength !== bytes) throw new Error("GPU preview FFmpeg decoder produced a truncated RGBA frame.");
      return { key, rgba, sha256: createHash("sha256").update(rgba).digest("hex"), bytes, decodedPts, source };
    } finally { this.#stats.inFlightBytes = 0; this.#emit(); await rm(path, { force: true }).catch(() => undefined); }
  }

  #insert(entry: DecodedVideoFrame): void {
    if (entry.bytes > MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES) throw new Error(`GPU preview video frame exceeds the ${MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES}-byte cache limit.`);
    while (this.#cache.size >= MAX_GPU_PREVIEW_VIDEO_CACHE_ENTRIES || this.#stats.bytes + entry.bytes > MAX_GPU_PREVIEW_VIDEO_CACHE_BYTES) {
      const victim = this.#cache.keys().next().value as string | undefined;
      if (!victim) throw new Error("GPU preview video cache has no completed entry eligible for eviction.");
      const removed = this.#cache.get(victim)!; this.#cache.delete(victim); this.#stats.bytes -= removed.bytes; this.#count("evictions");
    }
    this.#cache.set(entry.key, entry); this.#stats.bytes += entry.bytes; this.#sync();
  }

  #count(key: "hits" | "misses" | "evictions"): void { this.#stats[key] += 1; this.#sync(); }
  #sync(): void { this.#stats.entries = this.#cache.size; this.#stats.highWaterEntries = Math.max(this.#stats.highWaterEntries, this.#stats.entries); this.#stats.highWaterBytes = Math.max(this.#stats.highWaterBytes, this.#stats.bytes); this.#emit(); }
  #emit(): void { this.#onStats({ ...this.#stats }); }
}
