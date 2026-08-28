/**
 * workbench-update.ts — bounded GitHub release-channel checks for ShellX Motion.
 *
 * Role: implement `POST /workbench/update-check` and `POST /workbench/update-apply`.
 * This mirrors the ShellX family updater pattern used by ShellX Cut (a GitHub
 * releases feed, with the engine version as the source of truth), adapted to
 * Motion's loopback Node server, which has no packaged desktop shell yet.
 *
 * Honesty and privacy invariants:
 * - The shared controller invokes this check at CLI startup, every thirty minutes,
 *   and on an explicit user refresh. Every caller reads the same cached result.
 *   Only release metadata is requested; no project content or telemetry is sent.
 * - Release builds default to the official repository. Hosts may override or
 *   explicitly disable it; a disabled channel returns `configured: false`.
 * - A network/parse failure returns an honest error payload; it never fabricates
 *   an "up to date" or "update available" result.
 * - Apply does not download and run unverified release bytes. Motion has no
 *   signed release channel yet (Cut verifies a public key before installing), and
 *   a source checkout is updated through git, not an in-place binary swap. Apply
 *   therefore reports the truthful install-mode state instead of pretending.
 *
 * Network boundary (matches docs/public/security-model.md:45-54):
 * The update fetch honors the repository's documented public-network policy, reusing
 * the SAME pinned SSRF guard the source-import path uses (`@shellx-motion/core`'s
 * `network-policy`): every hostname is resolved first, private/reserved addresses are
 * rejected, one public address is pinned into the connection, each redirect hop is
 * re-validated, an HTTPS->HTTP downgrade is refused, the response body is streamed and
 * aborted the moment the byte ceiling is crossed (never fully buffered first), a JSON
 * media type is required, and the request timeout is enforced. In normal operation the
 * API base is restricted to the exact GitHub API origin. An operator can point the
 * channel elsewhere (or at a loopback fixture) ONLY through the explicitly unsafe
 * development override `SHELLX_MOTION_UPDATE_ALLOW_UNSAFE_BASE`, whose active state is
 * recorded in the response payload (`unsafeNetworkOverride`) so it is receipt-visible.
 *
 * Dependencies: node http/https for the pinned transport (injectable for tests) and the
 * core network policy. No shell, no disk writes.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  assertNetworkUrl,
  defaultNetworkAddressResolver,
  resolveNetworkTarget,
  type NetworkAddressResolver,
  type ResolvedNetworkAddress
} from "@shellx-motion/core";
import { compareEngineVersions, parseEngineVersion } from "./workbench-update-semver.js";

export { compareEngineVersions } from "./workbench-update-semver.js";

/** Bounded ceiling for a GitHub release JSON response body. */
const MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Release notes are truncated to keep the workbench payload bounded. */
const MAX_RELEASE_NOTES_CHARS = 8 * 1024;
/** Cap on the number of release assets echoed back to the client. */
const MAX_RELEASE_ASSETS = 20;
/** Default upstream request timeout. */
const DEFAULT_UPDATE_TIMEOUT_MS = 5000;
/** Bounded redirect hops the update fetch will follow (each re-validated). */
const DEFAULT_UPDATE_MAX_REDIRECTS = 4;
/** `owner/repo` slug validation, matching GitHub's allowed name characters. */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** The only API origin the update channel talks to in normal (non-override) operation. */
const GITHUB_API_ORIGIN = "https://api.github.com";
/** Development-only override that relaxes the origin restriction AND allows private addresses. */
export const UNSAFE_UPDATE_BASE_ENV = "SHELLX_MOTION_UPDATE_ALLOW_UNSAFE_BASE";
/** User-Agent Motion sends to the release feed. */
const UPDATE_USER_AGENT = "shellx-motion-engine-room";

/**
 * Per-hop transport init handed to an {@link UpdateFetch}. This mirrors the source-import fetcher
 * contract: the SSRF policy has already resolved and pinned ONE public (or, under the unsafe
 * override, explicitly permitted) address, so the transport connects to that exact address while
 * presenting the original host — never re-resolving DNS itself. `redirect: "manual"` is mandatory so
 * every hop is re-validated by the policy loop, not silently followed by the transport.
 */
export interface UpdateFetchInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
  redirect: "manual";
  /** The exact address the policy loop pinned for this hop. */
  resolvedAddress: ResolvedNetworkAddress;
  /** Byte ceiling the transport MUST enforce while streaming the body (abort, do not buffer past it). */
  maxBytes: number;
}

/** Minimal response shape the update channel consumes (satisfied by the pinned node transport). */
export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  /** Streamed body read; MUST reject once `maxBytes` is exceeded rather than buffering the whole body. */
  text: () => Promise<string>;
  /** Release an unread body (redirect / error hops) without buffering it. */
  discard?: () => void;
}

/** Pinned fetcher signature used by the update channel (default: {@link defaultUpdateFetcher}). */
export type UpdateFetch = (url: string, init: UpdateFetchInit) => Promise<UpdateFetchResponse>;

/** Resolved configuration for one update-channel operation. */
export interface WorkbenchUpdateConfig {
  /** `owner/repo` slug, or null when the channel is not configured. */
  repo: string | null;
  /** GitHub API base (overridable for tests). Defaults to https://api.github.com. */
  apiBaseUrl: string;
  /** Packaged-install root, or null when running from a source checkout. */
  installRoot: string | null;
  /** Canonical engine version to compare against the release feed. */
  currentVersion: string;
  /** Upstream request timeout in milliseconds. */
  timeoutMs?: number;
  /** Streamed response byte ceiling. Defaults to 2 MiB; exposed for tests to prove early abort. */
  maxBytes?: number;
  /** Bounded redirect hops to follow (each re-validated). Defaults to 4. */
  maxRedirects?: number;
  /**
   * When true the unsafe development override is active: the API base may be any http(s) origin and
   * private/reserved addresses are permitted (so a loopback fixture server can be used). This state is
   * echoed back in the result as `unsafeNetworkOverride`. NEVER set in production.
   */
  allowUnsafeBase?: boolean;
  /** DNS resolver used by the pinned network policy; defaults to the platform resolver (injectable for tests). */
  resolver?: NetworkAddressResolver;
  /** Injected pinned fetch implementation; defaults to the pinned node transport. */
  fetchImpl?: UpdateFetch;
}

/** A single release asset echoed back to the workbench. */
export interface ReleaseAssetInfo {
  name: string;
  size: number | null;
  contentType: string | null;
  downloadUrl: string | null;
}

/** Result envelope for an update check. `unsafeNetworkOverride` is receipt-visible provenance. */
export type UpdateCheckResult =
  | { ok: true; configured: false; currentVersion: string; message: string; unsafeNetworkOverride: boolean }
  | {
      ok: true;
      configured: true;
      currentVersion: string;
      latestVersion: string;
      upToDate: boolean;
      notesUrl: string | null;
      releasedAt: string | null;
      releaseName: string | null;
      prerelease: boolean;
      draft: boolean;
      notes: string | null;
      assets: ReleaseAssetInfo[];
      unsafeNetworkOverride: boolean;
    }
  | { ok: false; configured: true; currentVersion: string; error: { code: string; message: string }; unsafeNetworkOverride: boolean };

/** Result envelope for a user-requested update apply. */
export type UpdateApplyResult =
  | {
      ok: true;
      applied: false;
      mode: "source-checkout";
      updateChannelConfigured: boolean;
      message: string;
    }
  | {
      ok: true;
      applied: false;
      mode: "manual-download";
      updateChannelConfigured: boolean;
      releasePageUrl: string | null;
      message: string;
    };

/** Typed feed error so the check can map a transport/policy failure to a stable payload code. */
class UpdateFeedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "UpdateFeedError";
  }
}

/**
 * Run one update check against the configured GitHub releases feed.
 * Returns a truthful state for every outcome: unconfigured, up to date, update
 * available, or upstream failure. The upstream fetch runs on the pinned public-network
 * policy (per-hop DNS resolution, private-address rejection, address pinning, redirect
 * re-validation, HTTPS-downgrade refusal, streamed byte ceiling, JSON media type, timeout).
 */
export async function runWorkbenchUpdateCheck(config: WorkbenchUpdateConfig): Promise<UpdateCheckResult> {
  const unsafeNetworkOverride = config.allowUnsafeBase === true;
  if (!config.repo) {
    return {
      ok: true,
      configured: false,
      currentVersion: config.currentVersion,
      message: "The ShellX Motion update channel is disabled on this host. Set SHELLX_MOTION_UPDATE_REPO=<owner>/<repo> to configure a release feed.",
      unsafeNetworkOverride
    };
  }
  if (!REPO_SLUG_PATTERN.test(config.repo)) {
    return {
      ok: false,
      configured: true,
      currentVersion: config.currentVersion,
      error: { code: "invalid_update_repo", message: "The configured update repository must be an owner/repo slug." },
      unsafeNetworkOverride
    };
  }
  if (!parseEngineVersion(config.currentVersion)) {
    return {
      ok: false,
      configured: true,
      currentVersion: config.currentVersion,
      error: { code: "update_current_version_invalid", message: "The running ShellX Motion engine version is not valid SemVer." },
      unsafeNetworkOverride
    };
  }

  // Base-origin policy. In normal operation the base must be exactly the GitHub API origin; only the
  // explicitly unsafe development override may point the channel elsewhere (or at a loopback fixture).
  const base = resolveUpdateApiBase(config.apiBaseUrl, unsafeNetworkOverride);
  if (!base.ok) {
    return { ok: false, configured: true, currentVersion: config.currentVersion, error: base.error, unsafeNetworkOverride };
  }
  const releasesUrl = `${base.value}/repos/${config.repo}/releases/latest`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS);
  try {
    const bodyText = await fetchUpdateReleaseJson(releasesUrl, {
      fetchImpl: config.fetchImpl ?? defaultUpdateFetcher,
      resolver: config.resolver ?? defaultNetworkAddressResolver,
      signal: controller.signal,
      maxBytes: config.maxBytes ?? MAX_RELEASE_RESPONSE_BYTES,
      maxRedirects: config.maxRedirects ?? DEFAULT_UPDATE_MAX_REDIRECTS,
      allowPrivate: unsafeNetworkOverride
    });
    const release = parseRelease(bodyText);
    if (!release.ok) {
      return { ok: false, configured: true, currentVersion: config.currentVersion, error: { code: "update_feed_invalid", message: release.message }, unsafeNetworkOverride };
    }
    const latestVersion = release.latestVersion;
    const comparison = compareEngineVersions(config.currentVersion, latestVersion);
    // parseRelease and the configuration check above make this unreachable in normal operation,
    // but keeping the guard preserves the fail-closed contract if either parser changes later.
    if (comparison === null) {
      return {
        ok: false,
        configured: true,
        currentVersion: config.currentVersion,
        error: { code: "update_version_invalid", message: "The update version could not be compared as SemVer." },
        unsafeNetworkOverride
      };
    }
    return {
      ok: true,
      configured: true,
      currentVersion: config.currentVersion,
      latestVersion,
      upToDate: comparison >= 0,
      notesUrl: release.notesUrl,
      releasedAt: release.releasedAt,
      releaseName: release.releaseName,
      prerelease: release.prerelease,
      draft: release.draft,
      notes: release.notes,
      assets: release.assets,
      unsafeNetworkOverride
    };
  } catch (error) {
    return { ok: false, configured: true, currentVersion: config.currentVersion, error: classifyUpdateFeedError(error), unsafeNetworkOverride };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an explicit update apply. Reports the truthful install-mode state:
 * a source checkout is updated through git; a packaged install has no signed
 * in-place channel yet, so the server points the user at the manual download
 * instead of running unverified bytes.
 */
export function runWorkbenchUpdateApply(config: WorkbenchUpdateConfig): UpdateApplyResult {
  const channelConfigured = Boolean(config.repo && REPO_SLUG_PATTERN.test(config.repo));
  if (!config.installRoot || config.installRoot.trim() === "") {
    return {
      ok: true,
      applied: false,
      mode: "source-checkout",
      updateChannelConfigured: channelConfigured,
      message: "ShellX Motion is running from a source checkout. Update it through your source workflow — pull the latest commit, then run pnpm install --frozen-lockfile and rebuild — rather than replacing an installed binary. Automatic signed in-place updates apply only to packaged installs."
    };
  }
  return {
    ok: true,
    applied: false,
    mode: "manual-download",
    updateChannelConfigured: channelConfigured,
    releasePageUrl: channelConfigured ? `https://github.com/${config.repo}/releases/latest` : null,
    message: "Automatic in-place update is not available yet: ShellX Motion has no signed release channel, so the server will not download and run an unverified release asset. Open the release page and install the latest release manually."
  };
}

/**
 * Validate the configured API base against the origin policy. In normal operation the base must be
 * exactly the GitHub API origin; the unsafe override permits any http(s) origin (and later, private
 * addresses). Returns the trailing-slash-trimmed base string, or a stable error payload.
 */
function resolveUpdateApiBase(
  apiBaseUrl: string,
  allowUnsafeBase: boolean
): { ok: true; value: string } | { ok: false; error: { code: string; message: string } } {
  let url: URL;
  try {
    // allowPrivate mirrors the override: a private base is only shape-valid under the override; the
    // per-hop DNS pinning below is what actually enforces the address policy on the live connection.
    url = assertNetworkUrl(apiBaseUrl, { purpose: "update feed base", allowPrivate: allowUnsafeBase });
  } catch (error) {
    return { ok: false, error: { code: "update_base_invalid", message: `The update feed base URL is invalid: ${error instanceof Error ? error.message : String(error)}.` } };
  }
  if (!allowUnsafeBase && url.origin !== GITHUB_API_ORIGIN) {
    return {
      ok: false,
      error: {
        code: "update_base_not_allowed",
        message: `The update feed base must be ${GITHUB_API_ORIGIN}. Set ${UNSAFE_UPDATE_BASE_ENV}=1 to allow a different origin in development (unsafe).`
      }
    };
  }
  return { ok: true, value: apiBaseUrl.replace(/\/+$/, "") };
}

/**
 * Fetch the release JSON on the pinned public-network policy. Each hop is resolved and pinned; the
 * body is only read after status/redirect/content-type validation, and it is streamed with a byte
 * ceiling (never fully buffered before the size check). Throws {@link UpdateFeedError} for a stable
 * caller-visible code, or the raw policy error for an SSRF/private-address rejection.
 */
async function fetchUpdateReleaseJson(
  rawUrl: string,
  context: {
    fetchImpl: UpdateFetch;
    resolver: NetworkAddressResolver;
    signal: AbortSignal;
    maxBytes: number;
    maxRedirects: number;
    allowPrivate: boolean;
  }
): Promise<string> {
  let currentUrl = new URL(rawUrl);
  for (let redirectCount = 0; redirectCount <= context.maxRedirects; redirectCount += 1) {
    // Per-hop: resolve every hostname, reject private/reserved (unless override), pin ONE address.
    const target = await resolveNetworkTarget(currentUrl, {
      resolver: context.resolver,
      purpose: "update feed",
      signal: context.signal,
      allowPrivate: context.allowPrivate
    });
    const response = await context.fetchImpl(target.url.href, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": UPDATE_USER_AGENT,
        "x-github-api-version": "2022-11-28"
      },
      signal: context.signal,
      redirect: "manual",
      resolvedAddress: target.pinnedAddress,
      maxBytes: context.maxBytes
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      response.discard?.();
      if (!location) throw new UpdateFeedError("update_feed_invalid", "The update feed returned a redirect without a location.");
      if (redirectCount >= context.maxRedirects) throw new UpdateFeedError("update_feed_error", `The update feed exceeded ${context.maxRedirects} redirects.`);
      const nextUrl = new URL(location, target.url);
      if (target.url.protocol === "https:" && nextUrl.protocol !== "https:") {
        throw new UpdateFeedError("update_feed_redirect_blocked", "The update feed refused an HTTPS-to-HTTP redirect downgrade.");
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      response.discard?.();
      throw new UpdateFeedError("update_feed_unavailable", `The update feed returned HTTP ${response.status} ${response.statusText}.`);
    }
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!isJsonContentType(contentType)) {
      response.discard?.();
      throw new UpdateFeedError("update_feed_wrong_content_type", `The update feed returned an unexpected content type: ${contentType || "missing"}.`);
    }
    // Streamed read: the transport rejects the moment maxBytes is crossed. The re-check below is
    // defense-in-depth for an injected fetcher that does not stream.
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > context.maxBytes) {
      throw new UpdateFeedError("update_feed_too_large", "The update feed response exceeded the size bound.");
    }
    return text;
  }
  throw new UpdateFeedError("update_feed_error", `The update feed exceeded ${context.maxRedirects} redirects.`);
}

/** Map a thrown transport/policy error to the stable check-result error payload. */
function classifyUpdateFeedError(error: unknown): { code: string; message: string } {
  if ((error as { name?: string }).name === "AbortError") {
    return { code: "update_feed_timeout", message: "The update feed did not respond before the request timeout." };
  }
  if (error instanceof UpdateFeedError) {
    if (error.code === "update_feed_too_large") {
      return { code: error.code, message: error.message };
    }
    return { code: error.code, message: error.message };
  }
  // Raw policy rejections (private/reserved address, invalid resolver answer) surface as blocked.
  const message = error instanceof Error ? error.message : String(error);
  if (/refusing to fetch|private IP|did not resolve|invalid IP address|local host/i.test(message)) {
    return { code: "update_feed_network_blocked", message: `The update feed was blocked by the network policy: ${message}.` };
  }
  return { code: "update_feed_error", message: `The update feed could not be reached: ${message}.` };
}

/**
 * Default pinned transport: a node http/https GET that connects to the policy-pinned address while
 * presenting the original host (and SNI), follows no redirects, and streams the body with a hard byte
 * ceiling — aborting the connection the instant the ceiling is crossed rather than buffering first.
 */
function defaultUpdateFetcher(url: string, init: UpdateFetchInit): Promise<UpdateFetchResponse> {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const requestOptions = {
      protocol: target.protocol,
      hostname: init.resolvedAddress.address,
      family: init.resolvedAddress.family,
      port: target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { ...init.headers, host: target.host },
      signal: init.signal,
      ...(target.protocol === "https:" ? { servername: target.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "") } : {})
    };
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(requestOptions, (response) => {
      let consumed = false;
      const discard = (): void => {
        if (consumed) return;
        consumed = true;
        response.destroy();
      };
      resolvePromise({
        ok: typeof response.statusCode === "number" && response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        headers: {
          get: (name: string) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : null;
          }
        },
        text: async () => {
          if (consumed) throw new Error("update feed response body was already consumed");
          consumed = true;
          const contentLength = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(contentLength) && contentLength > init.maxBytes) {
            response.destroy();
            throw new UpdateFeedError("update_feed_too_large", "The update feed response exceeded the size bound.");
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > init.maxBytes) {
              response.destroy();
              throw new UpdateFeedError("update_feed_too_large", "The update feed response exceeded the size bound.");
            }
            chunks.push(buffer);
          }
          return Buffer.concat(chunks).toString("utf8");
        },
        discard
      });
    });
    request.once("error", reject);
    request.end();
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** The update feed must return JSON: `application/json` or a `+json` structured-suffix (GitHub's vnd.github+json). */
function isJsonContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

/** Parse the fields the workbench needs out of a GitHub `releases/latest` payload. */
function parseRelease(text: string):
  | {
      ok: true;
      latestVersion: string;
      notesUrl: string | null;
      releasedAt: string | null;
      releaseName: string | null;
      prerelease: boolean;
      draft: boolean;
      notes: string | null;
      assets: ReleaseAssetInfo[];
    }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "The update feed response was not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "The update feed response was not a release object." };
  }
  const record = parsed as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name.trim() : "";
  if (!tag) {
    return { ok: false, message: "The update feed response did not include a release tag." };
  }
  const version = parseEngineVersion(tag);
  if (!version) {
    return { ok: false, message: "The update feed release tag is not valid SemVer." };
  }
  const notes = typeof record.body === "string" ? record.body.slice(0, MAX_RELEASE_NOTES_CHARS) : null;
  return {
    ok: true,
    latestVersion: version.normalized,
    notesUrl: typeof record.html_url === "string" ? record.html_url : null,
    releasedAt: typeof record.published_at === "string" ? record.published_at : null,
    releaseName: typeof record.name === "string" ? record.name : null,
    prerelease: record.prerelease === true,
    draft: record.draft === true,
    notes,
    assets: parseAssets(record.assets)
  };
}

/** Extract bounded, echo-safe asset descriptors from a release payload. */
function parseAssets(value: unknown): ReleaseAssetInfo[] {
  if (!Array.isArray(value)) return [];
  const assets: ReleaseAssetInfo[] = [];
  for (const entry of value) {
    if (assets.length >= MAX_RELEASE_ASSETS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    if (!name) continue;
    assets.push({
      name,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : null,
      contentType: typeof record.content_type === "string" ? record.content_type : null,
      downloadUrl: typeof record.browser_download_url === "string" ? record.browser_download_url : null
    });
  }
  return assets;
}
