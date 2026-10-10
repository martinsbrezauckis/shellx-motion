import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { AgentScriptProvenanceRefusal, removeFirstMarkupAttribute, resolvePackageAsset, scanMarkupAttributeTagPairs, type MotionPackage, type ReceiptArtifact, type DerivedOutputPublication } from "@shellx-motion/core";
import { canonicalPathForBrowserSafety, isPathInsideOrEqual } from "./browser-package-safety";
import type { BrowserPackageFulfillment } from "./browser-package-fulfillment";
import { injectBrowserCaptureBase, packageRootBaseHref, safeBrowserCaptureFileToken } from "./browser-capture-html-document";
import { publishBrowserOutput } from "./browser-output-publication";
import { remoteOrigin } from "./browser-network-state";

export interface BrowserCaptureHtmlPreparation {
  html?: string;
  artifactPath?: string;
  artifactSha256?: string;
  artifacts: ReceiptArtifact[];
}

export async function prepareBrowserCaptureHtml(
  pkg: MotionPackage,
  source: string,
  outDir: string,
  fulfillment: BrowserPackageFulfillment,
  allowCompositionInlining = true,
  privateArtifactPublication?: DerivedOutputPublication,
  signal?: AbortSignal,
  abortError: (signal?: AbortSignal) => Error = (current) => current?.reason instanceof Error ? current.reason : new Error("Browser frame render was cancelled.")
): Promise<BrowserCaptureHtmlPreparation> {
  if (signal?.aborted) throw abortError(signal);
  const sourcePath = resolvePackageAsset(pkg, source);
  const html = (await fulfillment.readPath(sourcePath, "Browser capture HTML")).bytes.toString("utf8");
  if (signal?.aborted) throw abortError(signal);
  if (!allowCompositionInlining && scanMarkupAttributeTagPairs(html, "data-composition-src").length > 0) {
    throw new AgentScriptProvenanceRefusal("Approved-agent-entry script sources cannot inline secondary package compositions.");
  }
  const baseHref = packageRootBaseHref(pkg.root);
  const inlineResult = await inlineBrowserCompositionSources(pkg, sourcePath, html, fulfillment, baseHref, signal, abortError);
  if (inlineResult.sourceCount === 0) return { artifacts: [] };

  if (signal?.aborted) throw abortError(signal);
  const preparedHtml = injectBrowserCaptureBase(inlineResult.html, baseHref);
  if (Buffer.byteLength(preparedHtml, "utf8") > MAX_BROWSER_CAPTURE_HTML_BYTES) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
  if (signal?.aborted) throw abortError(signal);
  const artifactSha256 = sha256(preparedHtml);
  const artifactDir = privateArtifactPublication
    ? await privateBrowserCaptureArtifactDirectory(outDir, privateArtifactPublication)
    : join(resolve(outDir), "browser-capture-html");
  const artifactPath = join(artifactDir, `${safeBrowserCaptureFileToken(pkg.manifest.id)}-${artifactSha256.slice(0, 16)}.html`);
  // Companion HTML follows the same private directory-child policy as the primary PNG. This
  // must not become a separately writable structural artifact path just because it is evidence.
  if (signal?.aborted) throw abortError(signal);
  const verifiedArtifactSha256 = await publishBrowserOutput(artifactPath, Buffer.from(preparedHtml), privateArtifactPublication);
  if (verifiedArtifactSha256 !== artifactSha256) throw new Error("Browser capture HTML changed while its private evidence bytes were verified.");
  const artifacts: ReceiptArtifact[] = [{
    role: "browser_capture_html",
    path: artifactPath,
    status: "available",
    mediaType: "text/html",
    primary: true
  }];
  return { html: preparedHtml, artifactPath, artifactSha256, artifacts };
}

async function privateBrowserCaptureArtifactDirectory(outDir: string, publication: DerivedOutputPublication): Promise<string> {
  if (publication.kind === "file") return await publication.createPrivateCompanionDirectory("browser-capture-html");
  const candidate = resolve(outDir);
  if (!isPathInsideOrEqual(publication.stagingPath, candidate)) {
    throw new Error("Browser private artifact output must remain below its governed directory stage.");
  }
  return join(candidate, "browser-capture-html");
}

// The fulfillment budget charges retained input files once. Each inline reference expands those
// bytes again, so the derived HTML needs its own ceiling before concatenation and publication.
const MAX_BROWSER_CAPTURE_HTML_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_COMPOSITION_REFERENCES = 4_096;

async function inlineBrowserCompositionSources(
  pkg: MotionPackage,
  sourcePath: string,
  html: string,
  fulfillment: BrowserPackageFulfillment,
  baseHref: string,
  signal: AbortSignal | undefined,
  abortError: (signal?: AbortSignal) => Error
): Promise<{ html: string; sourceCount: number }> {
  // Bounded scan, not a regex. This used
  // `/<([A-Za-z][\w:-]*)\b([^>]*\bdata-composition-src\s*=\s*(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi`,
  // whose lazy body plus `\1` backreference re-scans the document once per candidate opening tag.
  // Repeated candidate tags can make that pattern rescan an untrusted package's HTML. The
  // sibling importer accepts large inputs, so this path needs a bounded forward scan.
  // `scanMarkupAttributeTagPairs` preserves the supported match set in a single pass.
  const matches = scanMarkupAttributeTagPairs(html, "data-composition-src");
  if (signal?.aborted) throw abortError(signal);
  if (matches.length === 0) return { html, sourceCount: 0 };
  if (matches.length > MAX_BROWSER_COMPOSITION_REFERENCES) throw new Error("Browser capture HTML exceeds the 4096 composition reference limit.");

  // Subtract every replaced span first. The remaining original text and the maximum base insertion
  // cannot later shrink, so every wrapper/body charge is positive and can be refused before decode.
  let fixedBytes = Buffer.byteLength(html, "utf8") + Buffer.byteLength(injectBrowserCaptureBase("", baseHref), "utf8");
  for (const match of matches) fixedBytes -= Buffer.byteLength(html.slice(match.start, match.end), "utf8");
  if (fixedBytes > MAX_BROWSER_CAPTURE_HTML_BYTES) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
  let expandedBytes = fixedBytes;
  const cached = new Map<string, { html: string; bytes: number }>();
  const replacements: { start: number; end: number; open: string; body: string; close: string }[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    if (signal?.aborted) throw abortError(signal);
    // Cached fulfillment and path resolutions may settle entirely in microtasks. Let governor
    // cancellation timers run during long lists of repeated references.
    if (index > 0 && index % 32 === 0) {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      if (signal?.aborted) throw abortError(signal);
    }
    const match = matches[index]!;
    const compositionSource = match.value;
    const compositionPath = await resolveBrowserCompositionSource(pkg, sourcePath, compositionSource);
    if (signal?.aborted) throw abortError(signal);
    const cleanAttrs = removeFirstMarkupAttribute(match.attrText, "data-composition-src");
    const open = `<${match.tagName}${cleanAttrs} data-shellx-motion-inlined-composition-src="${escapeAttr(compositionSource)}">`;
    const close = `</${match.tagName}>`;
    const wrapperBytes = Buffer.byteLength(open, "utf8") + Buffer.byteLength(close, "utf8");
    const remainingBodyBytes = MAX_BROWSER_CAPTURE_HTML_BYTES - expandedBytes - wrapperBytes;
    if (remainingBodyBytes < 0) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
    let composition = cached.get(compositionPath);
    if (!composition) {
      const bytes = (await fulfillment.readPath(compositionPath, "Browser composition HTML")).bytes;
      if (signal?.aborted) throw abortError(signal);
      if (bytes.byteLength > MAX_BROWSER_CAPTURE_HTML_BYTES) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
      // Valid UTF-8 has the same byte count after decoding. For malformed input, measure the
      // replacement-character output exactly before deciding whether it fits.
      if (bytes.byteLength > remainingBodyBytes && isUtf8(bytes)) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
      const body = bytes.toString("utf8");
      composition = { html: body, bytes: Buffer.byteLength(body, "utf8") };
    }
    if (composition.bytes > remainingBodyBytes) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
    cached.set(compositionPath, composition);
    expandedBytes += wrapperBytes + composition.bytes;
    replacements.push({ start: match.start, end: match.end, open, body: composition.html, close });
  }
  if (signal?.aborted) throw abortError(signal);
  if (expandedBytes > MAX_BROWSER_CAPTURE_HTML_BYTES) throw new Error("Browser capture HTML exceeds the 64 MiB expanded output limit.");
  let output = "";
  let lastIndex = 0;
  for (let index = 0; index < replacements.length; index += 1) {
    if (index > 0 && index % 32 === 0) {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      if (signal?.aborted) throw abortError(signal);
    }
    const replacement = replacements[index]!;
    output += html.slice(lastIndex, replacement.start);
    output += replacement.open + replacement.body + replacement.close;
    lastIndex = replacement.end;
  }
  output += html.slice(lastIndex);
  return { html: output, sourceCount: matches.length };
}


async function resolveBrowserCompositionSource(pkg: MotionPackage, sourcePath: string, compositionSource: string): Promise<string> {
  if (remoteOrigin(compositionSource)) {
    throw new Error(`Browser composition source must be package-local: ${compositionSource}`);
  }
  const targetPath = resolve(dirname(sourcePath), compositionSource);
  const packageRootPath = await canonicalPathForBrowserSafety(pkg.root);
  const canonicalTarget = await canonicalPathForBrowserSafety(targetPath);
  if (!isPathInsideOrEqual(packageRootPath, canonicalTarget)) {
    throw new Error(`Browser composition source escapes the Motion package root: ${compositionSource}`);
  }
  return targetPath;
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
