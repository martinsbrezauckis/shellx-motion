import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hashBuffer } from "./receipts";
import { htmlToMarkdown } from "./source-html-markdown";
import { cleanSourceMarkdownText, extractBoundedSourceUrls } from "./source-import-scanners";
import {
  assertPublicNetworkUrl,
  defaultNetworkAddressResolver,
  resolvePublicNetworkTarget,
  type NetworkAddressResolver,
  type ResolvedNetworkAddress
} from "./network-policy";

export type SourceImportKind = "article" | "repo" | "text" | "svg";

export interface SourceImportDocumentInput {
  url: string;
  title?: string;
  kind?: SourceImportKind;
  markdown: string;
  maxChars?: number;
}

export interface SourceImportDocument {
  url: string;
  title: string;
  kind: SourceImportKind;
  markdown: string;
  truncated: boolean;
  sourceChars: number;
  keptChars: number;
  sha256: string;
}

export interface FetchedSourceDocument {
  markdown: string;
  title?: string;
  kind?: SourceImportKind;
}

export interface SourceImportFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: {
    get: (name: string) => string | null;
  };
  text: () => Promise<string>;
  discard?: () => void;
}

export interface SourceImportFetchInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  redirect: "manual";
  resolvedAddress: ResolvedNetworkAddress;
  maxBytes: number;
}

export type SourceImportFetcher = (
  url: string,
  init: SourceImportFetchInit
) => Promise<SourceImportFetchResponse>;

export interface FetchSourceDocumentOptions {
  fetcher?: SourceImportFetcher;
  resolver?: NetworkAddressResolver;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SourceToScriptedVideoOptions {
  maxFrames?: number;
  frameDurationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  sourcePath?: string;
}

export interface SourceScriptedVideo {
  schema: "shellx-motion/scripted-video@1";
  id: string;
  name: string;
  sourceApp: "shellx-motion";
  workflow: "source-to-scripted-video";
  intent: "source_to_storyboard";
  synopsis: string;
  review: {
    status: "needs-review";
    required: true;
  };
  width: number;
  height: number;
  fps: number;
  frames: SourceScriptedVideoFrame[];
}

export interface SourceScriptedVideoFrame {
  id: string;
  title: string;
  body?: string;
  caption: string;
  durationMs: number;
  background: string;
  accent: string;
  reviewStatus: "needs-review";
  agentNote: string;
  assetRefs: string[];
  sourceRefs: Array<{
    type: SourceImportKind;
    title: string;
    url: string;
    path?: string;
  }>;
  tags: string[];
}

export function extractSourceUrls(text: string, max = 3): string[] {
  return extractBoundedSourceUrls(text, max);
}

export function assertPublicSourceUrl(raw: string): URL {
  return assertPublicNetworkUrl(raw, "source");
}

export function inferSourceImportKind(url: string): SourceImportKind {
  const parsed = assertPublicSourceUrl(url);
  if (parsed.pathname.toLowerCase().endsWith(".svg")) {
    return "svg";
  }
  if (parsed.hostname.toLowerCase() === "github.com" && parsed.pathname.split("/").filter(Boolean).length >= 2) {
    return "repo";
  }
  return "article";
}

const SOURCE_IMPORT_USER_AGENT = "ShellX-Motion-Source-Import/0.1";
const SOURCE_IMPORT_FETCH_TIMEOUT_MS = 12_000;
const SOURCE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const SOURCE_IMPORT_MAX_REDIRECTS = 4;
const SOURCE_IMPORT_MAX_CONCURRENT_FETCHES = 4;
let activeSourceFetches = 0;
const pendingSourceFetches: Array<(release: () => void) => void> = [];

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export async function fetchSourceDocument(rawUrl: string, options: FetchSourceDocumentOptions = {}): Promise<FetchedSourceDocument> {
  const url = assertPublicSourceUrl(rawUrl);
  const context: SourceFetchContext = {
    fetcher: options.fetcher ?? defaultSourceFetcher,
    resolver: options.resolver ?? defaultNetworkAddressResolver,
    maxBytes: readPositiveBound(options.maxBytes, SOURCE_IMPORT_MAX_BYTES, "source import maxBytes"),
    maxRedirects: readNonNegativeBound(options.maxRedirects, SOURCE_IMPORT_MAX_REDIRECTS, "source import maxRedirects")
  };
  const release = await acquireSourceFetchSlot();
  try {
    const repo = parseGithubRepoUrl(url);
    if (repo) return fetchGithubRepoSource(repo, context);
    return { markdown: await fetchSourceMarkdown(url, context) };
  } finally {
    release();
  }
}

interface SourceFetchContext {
  fetcher: SourceImportFetcher;
  resolver: NetworkAddressResolver;
  maxBytes: number;
  maxRedirects: number;
}

async function fetchSourceMarkdown(url: URL, context: SourceFetchContext): Promise<string> {
  const response = await fetchPublicText(url.href, context, {
    "accept": "text/html,text/plain,application/xhtml+xml,application/json;q=0.7,*/*;q=0.4"
  });
  return response.contentType.includes("html") ? htmlToMarkdown(response.text) : response.text;
}

async function fetchGithubRepoSource(repoRef: GitHubRepoRef, context: SourceFetchContext): Promise<FetchedSourceDocument> {
  const api = `https://api.github.com/repos/${encodeURIComponent(repoRef.owner)}/${encodeURIComponent(repoRef.repo)}`;
  const githubHeaders = {
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
  const meta = readRecord(await fetchPublicJson(api, context, githubHeaders)) ?? {};
  const readme = await fetchPublicText(`${api}/readme`, context, {
    ...githubHeaders,
    "accept": "application/vnd.github.raw"
  }).then((response) => response.text.trim()).catch(() => "");
  const contents = await fetchPublicJson(`${api}/contents`, context, githubHeaders).catch(() => []);

  const title = githubString(meta, "full_name") ?? `${repoRef.owner}/${repoRef.repo}`;
  const lines: string[] = [];
  const description = githubString(meta, "description");
  if (description) lines.push(`> ${description}`, "");

  const facts: string[] = [];
  const language = githubString(meta, "language");
  const stars = githubNumber(meta, "stargazers_count");
  const homepage = githubString(meta, "homepage");
  const license = githubLicense(meta);
  const topics = githubTopics(meta);
  if (language) facts.push(`Language: ${language}`);
  if (typeof stars === "number") facts.push(`Stars: ${stars.toLocaleString("en-US")}`);
  if (license) facts.push(`License: ${license}`);
  if (homepage) facts.push(`Homepage: ${homepage}`);
  if (topics.length > 0) facts.push(`Topics: ${topics.join(", ")}`);
  if (facts.length > 0) lines.push(...facts.map((fact) => `- ${fact}`), "");

  const topLevel = githubTopLevelContents(contents);
  if (topLevel.length > 0) {
    lines.push("## Top-level structure", "", ...topLevel.map((entry) => `- ${entry}`), "");
  }
  if (readme) lines.push("## README", "", readme);

  return {
    title,
    kind: "repo",
    markdown: lines.join("\n").trim()
  };
}

async function fetchPublicJson(url: string, context: SourceFetchContext, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchPublicText(url, context, headers);
  return JSON.parse(response.text);
}

async function fetchPublicText(rawUrl: string, context: SourceFetchContext, headers: Record<string, string>): Promise<{ text: string; contentType: string }> {
  const signal = AbortSignal.timeout(SOURCE_IMPORT_FETCH_TIMEOUT_MS);
  let currentUrl = assertPublicSourceUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= context.maxRedirects; redirectCount += 1) {
    const target = await resolvePublicNetworkTarget(currentUrl, { resolver: context.resolver, purpose: "source", signal });
    const response = await context.fetcher(target.url.href, {
      headers: sourceRequestHeaders(headers),
      signal,
      redirect: "manual",
      resolvedAddress: target.pinnedAddress,
      maxBytes: context.maxBytes
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      response.discard?.();
      if (!location) throw new Error(`source redirect ${response.status} did not include a location`);
      if (redirectCount >= context.maxRedirects) throw new Error(`source fetch exceeded ${context.maxRedirects} redirects`);
      const nextUrl = assertPublicSourceUrl(new URL(location, target.url).href);
      if (target.url.protocol === "https:" && nextUrl.protocol !== "https:") {
        throw new Error("source fetch refused an HTTPS-to-HTTP redirect downgrade");
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      response.discard?.();
      throw new Error(`source fetch failed ${response.status}: ${response.statusText}`);
    }
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!isAllowedSourceContentType(contentType)) {
      response.discard?.();
      throw new Error(`source fetch returned unsupported content type: ${contentType || "missing"}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > context.maxBytes) {
      throw new Error(`source fetch response exceeds ${context.maxBytes} bytes`);
    }
    return { text, contentType };
  }
  throw new Error(`source fetch exceeded ${context.maxRedirects} redirects`);
}

async function defaultSourceFetcher(url: string, init: SourceImportFetchInit): Promise<SourceImportFetchResponse> {
  return pinnedSourceRequest(new URL(url), init);
}

function pinnedSourceRequest(url: URL, init: SourceImportFetchInit): Promise<SourceImportFetchResponse> {
  return new Promise((resolvePromise, reject) => {
    const requestOptions = {
      protocol: url.protocol,
      hostname: init.resolvedAddress.address,
      family: init.resolvedAddress.family,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        ...init.headers,
        host: url.host
      },
      signal: init.signal,
      ...(url.protocol === "https:" ? { servername: url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "") } : {})
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(requestOptions, (response) => {
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
          if (consumed) throw new Error("source fetch response body was already consumed");
          consumed = true;
          const contentLength = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(contentLength) && contentLength > init.maxBytes) {
            response.destroy();
            throw new Error(`source fetch response exceeds ${init.maxBytes} bytes`);
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > init.maxBytes) {
              response.destroy();
              throw new Error(`source fetch response exceeds ${init.maxBytes} bytes`);
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

function sourceRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const safeHeaders: Record<string, string> = {
    "user-agent": SOURCE_IMPORT_USER_AGENT
  };
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === "authorization" || normalized === "cookie" || normalized === "proxy-authorization") continue;
    safeHeaders[normalized] = value;
  }
  return safeHeaders;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function isAllowedSourceContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.endsWith("+xml") || [
    "application/json",
    "application/ld+json",
    "application/vnd.github.raw",
    "application/xhtml+xml",
    "application/xml",
    "application/svg+xml",
    "image/svg+xml"
  ].includes(contentType);
}

async function acquireSourceFetchSlot(): Promise<() => void> {
  if (activeSourceFetches >= SOURCE_IMPORT_MAX_CONCURRENT_FETCHES) {
    return new Promise<() => void>((resolvePromise) => pendingSourceFetches.push(resolvePromise));
  }
  activeSourceFetches += 1;
  return createSourceFetchRelease();
}

function createSourceFetchRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSourceFetches -= 1;
    const next = pendingSourceFetches.shift();
    if (next) {
      activeSourceFetches += 1;
      next(createSourceFetchRelease());
    }
  };
}

function readPositiveBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 16 * 1024 * 1024) {
    throw new Error(`${label} must be an integer from 1 to ${16 * 1024 * 1024}`);
  }
  return resolved;
}

function readNonNegativeBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 10) {
    throw new Error(`${label} must be an integer from 0 to 10`);
  }
  return resolved;
}

function parseGithubRepoUrl(url: URL): GitHubRepoRef | null {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const reserved = new Set(["about", "collections", "features", "marketplace", "search", "sponsors", "topics"]);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");
  if (!owner || !repo || reserved.has(owner.toLowerCase())) return null;
  return { owner, repo };
}

function githubString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function githubNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function githubLicense(record: Record<string, unknown>): string | undefined {
  const license = readRecord(record.license);
  const spdx = typeof license?.spdx_id === "string" ? license.spdx_id.trim() : "";
  return spdx && spdx !== "NOASSERTION" ? spdx : undefined;
}

function githubTopics(record: Record<string, unknown>): string[] {
  const topics = record.topics;
  return Array.isArray(topics)
    ? topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0).map((topic) => topic.trim())
    : [];
}

function githubTopLevelContents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const type = typeof record?.type === "string" ? record.type : "";
    return name ? [`${name}${type === "dir" ? "/" : ""}`] : [];
  }).slice(0, 40);
}

export function buildSourceImportDocument(input: SourceImportDocumentInput): SourceImportDocument {
  const parsed = assertPublicSourceUrl(input.url);
  const kind = input.kind ?? inferSourceImportKind(parsed.href);
  const title = normalizeSourceTitle(input.title) || parsed.href;
  const source = normalizeMarkdown(input.markdown);
  const maxChars = input.maxChars ?? 12_000;
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error("maxChars must be a positive number.");
  const truncated = source.length > maxChars;
  const body = truncated ? source.slice(0, maxChars) : source;
  const markdown = `# ${title}\n\nSource: ${parsed.href}\nKind: ${kind}\n\n${body}`;
  return {
    url: parsed.href,
    title,
    kind,
    markdown,
    truncated,
    sourceChars: source.length,
    keptChars: body.length,
    sha256: hashBuffer(Buffer.from(markdown, "utf8"))
  };
}

export function readSourceImportDocumentFromMarkdown(markdown: string, options: {
  url?: string;
  title?: string;
  kind?: SourceImportKind;
  maxChars?: number;
} = {}): SourceImportDocument {
  const normalized = normalizeMarkdown(markdown);
  const parsed = parseImportedMarkdownHeader(normalized);
  const url = options.url ?? parsed.url;
  if (!url) throw new Error("source Markdown must include Source: URL or an explicit url option.");
  const kind = options.kind ?? parsed.kind ?? inferSourceImportKind(url);
  const title = normalizeSourceTitle(options.title ?? parsed.title) || url;
  const maxChars = options.maxChars ?? Math.max(1, normalized.length);
  const truncated = normalized.length > maxChars;
  const kept = truncated ? normalized.slice(0, maxChars) : normalized;
  return {
    url: assertPublicSourceUrl(url).href,
    title,
    kind,
    markdown: kept,
    truncated,
    sourceChars: normalized.length,
    keptChars: kept.length,
    sha256: hashBuffer(Buffer.from(kept, "utf8"))
  };
}

export function buildScriptedVideoFromSourceImport(
  source: SourceImportDocument,
  options: SourceToScriptedVideoOptions = {}
): SourceScriptedVideo {
  const maxFrames = readBoundedInteger(options.maxFrames ?? 5, "maxFrames", 1, 12);
  const frameDurationMs = readBoundedInteger(options.frameDurationMs ?? 2600, "frameDurationMs", 500, 30_000);
  const width = readBoundedInteger(options.width ?? 1280, "width", 16, 7680);
  const height = readBoundedInteger(options.height ?? 720, "height", 16, 4320);
  const fps = readBoundedInteger(options.fps ?? 30, "fps", 1, 120);
  const sections = sourceSections(source.markdown, source.title).slice(0, maxFrames);
  const fallbackSections = sections.length > 0 ? sections : [{ title: source.title, body: source.markdown }];
  const caption = `Source: ${sourceHostLabel(source.url)}`;
  const palette = [
    { background: "#111827", accent: "#38bdf8" },
    { background: "#172554", accent: "#facc15" },
    { background: "#14532d", accent: "#fb7185" },
    { background: "#312e81", accent: "#34d399" }
  ];
  const sourceRef = {
    type: source.kind,
    title: source.title,
    url: source.url,
    ...(options.sourcePath ? { path: options.sourcePath } : {})
  };
  const frames = fallbackSections.map((section, index): SourceScriptedVideoFrame => {
    const colors = palette[index % palette.length];
    return {
      id: `source-${String(index + 1).padStart(3, "0")}`,
      title: frameTitle(section.title, index),
      ...(section.body ? { body: clampText(section.body, 180) } : {}),
      caption,
      durationMs: frameDurationMs,
      background: colors.background,
      accent: colors.accent,
      reviewStatus: "needs-review",
      agentNote: "Review source-derived storyboard text before final render or Cut insertion.",
      assetRefs: [],
      sourceRefs: [sourceRef],
      tags: ["source", source.kind, "needs-review"]
    };
  });

  return {
    schema: "shellx-motion/scripted-video@1",
    id: `source_${slugId(source.title)}`,
    name: source.title,
    sourceApp: "shellx-motion",
    workflow: "source-to-scripted-video",
    intent: "source_to_storyboard",
    synopsis: `${source.title}: ${frames.length} source-derived storyboard frame${frames.length === 1 ? "" : "s"}.`,
    review: { status: "needs-review", required: true },
    width,
    height,
    fps,
    frames
  };
}

function normalizeSourceTitle(title: string | undefined): string {
  return (title ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").trim();
}

function parseImportedMarkdownHeader(markdown: string): { title?: string; url?: string; kind?: SourceImportKind } {
  let title: string | undefined;
  let url: string | undefined;
  let kind: SourceImportKind | undefined;
  for (const line of markdown.split("\n").slice(0, 12)) {
    const trimmed = line.trim();
    if (!title && trimmed.startsWith("# ")) title = normalizeSourceTitle(trimmed.slice(2));
    if (!url && /^source:/i.test(trimmed)) url = trimmed.replace(/^source:\s*/i, "").trim();
    if (!kind && /^kind:/i.test(trimmed)) {
      const value = trimmed.replace(/^kind:\s*/i, "").trim();
      if (value === "article" || value === "repo" || value === "text") kind = value;
    }
  }
  return { ...(title ? { title } : {}), ...(url ? { url } : {}), ...(kind ? { kind } : {}) };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

interface SourceSection {
  title: string;
  body: string;
}

function sourceSections(markdown: string, sourceTitle: string): SourceSection[] {
  const sections: SourceSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];
  const push = (): void => {
    const body = cleanMarkdownText(currentLines.join(" "));
    if (currentTitle || body) {
      sections.push({
        title: cleanMarkdownText(currentTitle || firstSentence(body) || sourceTitle),
        body
      });
    }
    currentTitle = "";
    currentLines = [];
  };

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^source:/i.test(trimmed) || /^kind:/i.test(trimmed)) continue;
    if (trimmed.startsWith("# ")) continue;
    const heading = trimmed.match(/^#{2,6}\s+(.+)$/);
    if (heading) {
      push();
      currentTitle = heading[1] ?? "";
      continue;
    }
    currentLines.push(trimmed);
  }
  push();

  if (sections.length > 0) return sections;
  return normalizeMarkdown(markdown)
    .split(/\n{2,}/)
    .map((paragraph) => cleanMarkdownText(paragraph))
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => ({ title: firstSentence(paragraph) || sourceTitle, body: paragraph }));
}

function cleanMarkdownText(value: string): string {
  return cleanSourceMarkdownText(value);
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
}

function frameTitle(value: string, index: number): string {
  const title = clampText(value, 64);
  return title || `Source point ${index + 1}`;
}

function clampText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sourceHostLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "source";
  }
}

function slugId(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "source";
}

function readBoundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    if (label === "maxFrames") throw new Error("maxFrames must be an integer between 1 and 12.");
    if (label === "frameDurationMs") throw new Error("frameDurationMs must be between 500 and 30000.");
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
