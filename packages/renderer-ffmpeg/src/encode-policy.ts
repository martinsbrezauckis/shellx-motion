/**
 * encode-policy.ts — centralized hardware-encode policy and probe cache.
 *
 * Role: give every final-render call path — CLI, debug-api, and the four Canvas/Cut connector paths
 * (canvas-to-mp4, canvas-to-cut, template-to-cut, script-to-cut) — ONE shared way to decide which
 * encoder to use, so the same eligible host selects the same encoder everywhere, and so the
 * per-machine hardware usability probe is not re-run on every render.
 *
 * Design:
 * - A bounded-lifetime cache stores the hardware usability probe (SUCCESS and FAILURE both — a failed
 *   probe is evidence too, and re-probing a machine with no GPU on every render is pure waste). The
 *   cache key is the FFmpeg binary identity (resolved executable path), platform, architecture, codec
 *   family, and the software-override state. The captured FFmpeg version is bound to the entry (for
 *   receipt provenance) and the entry's bounded TTL bounds any binary-version drift; the sync-computable
 *   key is deliberately version-free so a cache hit costs zero subprocesses.
 * - The probe stays LAZY: this module hands `encodeImageSequence` a cache-aware resolver that it calls
 *   only AFTER the frame quality gate, so a doomed frame sequence never triggers a probe (preserving the
 *   engine's existing gate-before-probe optimization).
 * - `SHELLX_MOTION_FORCE_SOFTWARE_ENCODE` (and an explicit `forceSoftwareEncode`) is preserved exactly:
 *   `encodeImageSequence` short-circuits before calling the resolver, so forced-software renders stay
 *   deterministic and probe-free.
 * - On a real hardware encode failure at render time (encodeImageSequence retries software and receipts
 *   the fallback), the cache entry is invalidated so the next render re-probes rather than re-selecting
 *   a hardware encoder that just failed.
 * - The cache provenance (fresh probe vs cached) is recorded in the render receipt's `encoderProbe`, so a
 *   receipt reader sees whether the hardware decision was freshly proved on this render or reused.
 *
 * Home: this module lives in renderer-ffmpeg because it already owns every probe primitive and the encode
 * function; all five call paths already depend on renderer-ffmpeg, so no new cross-package dependency is
 * introduced. Callers use {@link encodeImageSequenceWithPolicy} in place of a bare `encodeImageSequence`.
 */
import { arch, platform } from "node:os";
import {
  encodeImageSequence,
  probeFfmpegHardwareEncoderUsability,
  resolveExportPreset,
  resolveFfmpegExecutable,
  type EncodeImageSequenceInput,
  type EncodeResult,
  type FfmpegHardwareEncoderUsability,
  type FfmpegRunner,
  type FfmpegVideoCodecFamily,
  type HardwareProbeResolverInput,
  type ResolvedHardwareProbe
} from "./index.js";

/** Default bounded cache lifetime (5 minutes) — long enough to serve a batch, short enough to pick up a binary swap. */
const DEFAULT_ENCODE_POLICY_TTL_MS = 5 * 60 * 1000;

/** One cached hardware-usability probe result plus the identity it was captured under. */
interface EncodePolicyCacheEntry {
  probe: FfmpegHardwareEncoderUsability;
  /** FFmpeg version string captured at probe time (when the caller supplied it), for receipt provenance. */
  version: string | null;
  family: FfmpegVideoCodecFamily;
  /** Absolute epoch-ms after which this entry is stale. */
  expiresAt: number;
}

/**
 * A minimal, injectable probe cache. The default is a process-lifetime singleton; tests (and any caller
 * that wants isolation) can pass their own via {@link createEncodePolicyCache}.
 */
export interface EncodePolicyCache {
  get(key: string): EncodePolicyCacheEntry | undefined;
  set(key: string, entry: EncodePolicyCacheEntry): void;
  delete(key: string): void;
  clear(): void;
}

/** Create a fresh, empty encode-policy cache (Map-backed). */
export function createEncodePolicyCache(): EncodePolicyCache {
  const store = new Map<string, EncodePolicyCacheEntry>();
  return {
    get: (key) => store.get(key),
    set: (key, entry) => void store.set(key, entry),
    delete: (key) => void store.delete(key),
    clear: () => store.clear()
  };
}

/** Process-lifetime default cache shared by all five call paths. */
export const defaultEncodePolicyCache: EncodePolicyCache = createEncodePolicyCache();

/** Clear the shared default cache. Intended for test isolation between renders. */
export function clearDefaultEncodePolicyCache(): void {
  defaultEncodePolicyCache.clear();
}

/**
 * Preserve the exact `SHELLX_MOTION_FORCE_SOFTWARE_ENCODE` semantics used by `encodeImageSequence`
 * (1/true/yes). Kept identical here so this module's force-software decisions agree with the encode.
 */
function envForceSoftwareEncode(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.SHELLX_MOTION_FORCE_SOFTWARE_ENCODE?.trim() ?? "");
}

/** Build the sync-computable cache key: binary identity + platform + arch + codec family + override state. */
export function encodePolicyCacheKey(family: FfmpegVideoCodecFamily): string {
  return [resolveFfmpegExecutable(), platform(), arch(), family, "force:false"].join(" ");
}

/** Options for {@link resolveCachedHardwareProbe}. */
export interface ResolveCachedHardwareProbeOptions extends HardwareProbeResolverInput {
  /** Probe cache to consult/populate; defaults to the shared {@link defaultEncodePolicyCache}. */
  cache?: EncodePolicyCache;
  /** Known FFmpeg version, bound to the cache entry for provenance. */
  version?: string | null;
  /** Cache entry lifetime in ms; defaults to 5 minutes. */
  ttlMs?: number;
  /** Clock for the TTL (testable); defaults to `Date.now`. */
  now?: () => number;
}

/** A cache-aware probe result carrying the cache key it used (for invalidation) and the bound version. */
export interface CachedHardwareProbeResult extends ResolvedHardwareProbe {
  cacheKey: string;
  version: string | null;
}

/**
 * Resolve the hardware usability probe for one codec family, reusing a cached entry within its TTL or
 * running a fresh probe (and caching it — success OR failure). Never called for a forced-software or
 * no-hardware-policy render (encodeImageSequence skips the resolver in those cases).
 */
export async function resolveCachedHardwareProbe(options: ResolveCachedHardwareProbeOptions): Promise<CachedHardwareProbeResult> {
  const cache = options.cache ?? defaultEncodePolicyCache;
  const now = options.now ?? Date.now;
  const key = encodePolicyCacheKey(options.family);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) {
    return { probe: cached.probe, provenance: "cached", cacheKey: key, version: cached.version };
  }
  // Fresh probe, restricted to this family's candidates so no irrelevant probes are spawned. A machine
  // with none of these encoders compiled runs zero init probes (only the one `-encoders` discovery).
  const probe = await probeFfmpegHardwareEncoderUsability({ runner: options.runner, encoders: options.encoders });
  const version = options.version ?? null;
  cache.set(key, { probe, version, family: options.family, expiresAt: now() + (options.ttlMs ?? DEFAULT_ENCODE_POLICY_TTL_MS) });
  return { probe, provenance: "fresh-probe", cacheKey: key, version };
}

/** Extra, policy-only fields layered on top of {@link EncodeImageSequenceInput}. */
export interface EncodeImageSequenceWithPolicyInput extends EncodeImageSequenceInput {
  /** Probe cache to use; defaults to the shared default cache. */
  cache?: EncodePolicyCache;
  /** Cache entry lifetime in ms. */
  ttlMs?: number;
  /** Known FFmpeg version for cache/receipt provenance (CLI/debug-api pass their checkFfmpeg version). */
  ffmpegVersion?: string | null;
  /** Clock for the policy cache TTL (testable). */
  policyNow?: () => number;
}

/**
 * Centralized final-render encode: run the encode with a shared, cache-aware hardware-probe resolver so
 * the same eligible host selects the same encoder across CLI/debug-api/connectors and the probe is reused
 * across renders. Invalidates the cache entry if a probe-selected hardware encoder actually failed and
 * fell back to software at render time. Software-force and gate-before-probe are preserved by
 * `encodeImageSequence` itself (it skips the resolver when software is forced, and only calls it after the
 * frame quality gate).
 */
export async function encodeImageSequenceWithPolicy(input: EncodeImageSequenceWithPolicyInput): Promise<EncodeResult> {
  const { cache, ttlMs, ffmpegVersion, policyNow, ...encodeInput } = input;
  const usedCache = cache ?? defaultEncodePolicyCache;
  const now = policyNow ?? Date.now;
  const forceSoftwareEncode = encodeInput.forceSoftwareEncode ?? envForceSoftwareEncode();
  const family = resolveExportPreset(encodeInput.preset).hardwareEncode?.family ?? null;

  const result = await encodeImageSequence({
    ...encodeInput,
    // Forwarded, not consumed: the version identifies the encode on the receipt (the tool-identity invariant) as well as
    // keying the hardware-probe cache.
    ...(ffmpegVersion !== undefined ? { ffmpegVersion } : {}),
    // Lazy, cached hardware-probe resolver. encodeImageSequence calls it only after the quality gate and
    // never when software is forced or the preset has no hardware candidates.
    hardwareProbeResolver: (probeInput: HardwareProbeResolverInput) => resolveCachedHardwareProbe({
      ...probeInput,
      cache: usedCache,
      version: ffmpegVersion ?? null,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      now
    })
  });

  // A probe-selected hardware encoder that failed at render time (encodeImageSequence already retried
  // software and receipted the fallback) means the cached "usable" verdict is stale — drop it so the
  // next render re-probes instead of re-selecting the failing encoder.
  if (result.ok && family && !forceSoftwareEncode && receiptShowsHardwareFallback(result)) {
    usedCache.delete(encodePolicyCacheKey(family));
  }
  return result;
}

/** True when a successful render fell back from a probe-selected hardware encoder to software at run time. */
function receiptShowsHardwareFallback(result: EncodeResult): boolean {
  if (!result.ok) return false;
  const output = result.receipt.output;
  if (!output || typeof output !== "object") return false;
  const record = output as { encoderReason?: string; encoderFallback?: unknown };
  return record.encoderReason === "hardware-fallback" || record.encoderFallback !== undefined;
}
