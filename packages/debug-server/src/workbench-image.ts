/**
 * workbench-image.ts — format policy for the two workbench surfaces that hand
 * raw file bytes to the browser: `/workbench/artifact` (rendered preview frames)
 * and `/workbench/poster` (template-pack posters).
 *
 * Role: decide, for a set of already-safely-read bytes, whether they may be
 * served and under which `content-type` / `content-security-policy`. This module
 * owns ONLY the format question. Path safety — absolute-path checks, symlink
 * refusal, realpath containment inside the authenticated artifact roots, and the
 * TOCTOU re-validation around open/read — stays in the caller
 * (`index.ts#readBoundedArtifactBytes`) and is unchanged by anything here.
 *
 * Dependencies: none (pure byte/string inspection). No fs, no network.
 *
 * Primary caller: `@shellx-motion/debug-server` index route handlers
 * (`GET /workbench/artifact`, `GET /workbench/poster`).
 *
 * Why posters need a format split
 * -------------------------------
 * Posters shipped as hand-authored SVG mockups until the July 2026 template pack
 * replaced them with real 1920x1080 PNG renders. SVG is an active document
 * format (script, event handlers, external references, XXE) so it needs content
 * sanitisation before it may be served; PNG/JPEG are inert containers decoded by
 * the browser's image pipeline and need the opposite treatment — a magic-byte
 * check that the bytes really are the declared type, so `nosniff` plus a fixed
 * `content-type` pins how the browser may ever interpret them. Applying the SVG
 * text gate to a raster file is meaningless, and skipping the raster magic check
 * would let a mislabeled file be typed by extension alone. Hence: one endpoint,
 * two format-specific gates, selected by extension.
 *
 * Security invariants:
 * - The served `content-type` is chosen from a fixed table keyed by a
 *   whitelisted extension; it is never derived from caller-supplied data.
 * - Raster bytes must match the magic signature of their declared extension, so
 *   `content-type` + `x-content-type-options: nosniff` cannot disagree with the
 *   actual container.
 * - SVG bytes must pass `assessSvgPosterSafety` — no script, no event handlers,
 *   no DOCTYPE/ENTITY, no non-fragment external references.
 * - Every format carries a `default-src 'none'; sandbox` CSP so a poster opened
 *   directly (rather than through `<img>`) still cannot script or reach the
 *   network. Raster posters additionally drop the `style-src` relaxation that
 *   only inline-styled SVG needs.
 */

/** Raster preview-frame content types, keyed by lowercased file extension. */
export const WORKBENCH_RASTER_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

/** Extensions the `/workbench/artifact` preview-frame endpoint will serve. */
export const WORKBENCH_RASTER_EXTENSIONS = new Set(Object.keys(WORKBENCH_RASTER_CONTENT_TYPES));

/**
 * Extensions the `/workbench/poster` endpoint will serve. Deliberately narrower
 * than the preview-frame set: posters are pack-authored key art, so the two
 * formats packs actually ship (vector SVG, raster PNG/JPEG renders) are allowed
 * and animated/legacy containers are not.
 */
export const WORKBENCH_POSTER_EXTENSIONS = new Set([".svg", ".png", ".jpg", ".jpeg"]);

/** Size bound for a vector poster: an SVG this large is authoring damage, not key art. */
export const MAX_WORKBENCH_SVG_POSTER_BYTES = 4 * 1024 * 1024;

/**
 * Size bound for a raster poster. The shipped 1920x1080 PNG renders top out near
 * 2.2 MB; 16 MiB leaves room for a future 4K poster while staying far below the
 * caller's 64 MiB hard artifact ceiling.
 */
export const MAX_WORKBENCH_RASTER_POSTER_BYTES = 16 * 1024 * 1024;

/** CSP for an SVG poster: inert, but inline `<style>` inside the document is allowed. */
const SVG_POSTER_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** CSP for a raster poster: nothing at all is fetchable or executable. */
const RASTER_POSTER_CSP = "default-src 'none'; sandbox";

/** A poster cleared for serving: fixed content type plus the CSP its format needs. */
export interface WorkbenchPosterPayload {
  contentType: string;
  contentSecurityPolicy: string;
}

/**
 * Confirm raster bytes carry the magic signature of their declared extension.
 *
 * @param bytes Full file bytes as read from disk.
 * @param extension Lowercased file extension, already whitelisted by the caller.
 * @returns true when the container signature matches the declared type.
 */
export function matchesWorkbenchImageMagic(bytes: Buffer, extension: string): boolean {
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (extension === ".webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

/**
 * Apply the format-appropriate poster gate and resolve the response headers.
 *
 * SVG posters get the structural/active-content sanitisation gate; PNG and JPEG
 * posters get a magic-byte identity check instead — sanitising a raster file is
 * not a meaningful operation, whereas proving it is the container we are about
 * to declare is.
 *
 * @param bytes Poster bytes, already read through the bounded safe-file core.
 * @param extension Lowercased extension from the resolved path.
 * @returns ok:true with the headers to serve, else a caller-facing reason.
 */
export function assessWorkbenchPosterPayload(
  bytes: Buffer,
  extension: string
): { ok: true; payload: WorkbenchPosterPayload } | { ok: false; message: string } {
  if (extension === ".svg") {
    if (bytes.byteLength > MAX_WORKBENCH_SVG_POSTER_BYTES) {
      return { ok: false, message: "Workbench template poster exceeds the SVG size bound." };
    }
    const safety = assessSvgPosterSafety(bytes);
    if (!safety.ok) return safety;
    return { ok: true, payload: { contentType: "image/svg+xml", contentSecurityPolicy: SVG_POSTER_CSP } };
  }

  const contentType = WORKBENCH_RASTER_CONTENT_TYPES[extension];
  if (!contentType) {
    // Unreachable while WORKBENCH_POSTER_EXTENSIONS and the table above agree;
    // kept so a future extension added to only one of them fails closed.
    return { ok: false, message: "Workbench template poster format has no serving policy." };
  }
  if (bytes.byteLength > MAX_WORKBENCH_RASTER_POSTER_BYTES) {
    return { ok: false, message: "Workbench template poster exceeds the raster size bound." };
  }
  if (!matchesWorkbenchImageMagic(bytes, extension)) {
    return { ok: false, message: "Workbench template poster bytes do not match the declared image type." };
  }
  return { ok: true, payload: { contentType, contentSecurityPolicy: RASTER_POSTER_CSP } };
}

/**
 * Does this document open as an SVG — optional XML declaration, then any number of comments?
 *
 * Written as a deterministic scan rather than the regex it replaces:
 *
 *   /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i
 *
 * That pattern is an outer `*` over a group whose lazy body can span several comments, so a
 * document that does NOT go on to open an `<svg>` makes the engine enumerate every way of
 * partitioning the comment run. An adversarial regression measured a clean doubling per two comments:
 * 24 comments took 146ms, 30 took 9.3s, and 32 took 37s — from 264 bytes of entirely well-formed
 * input, far under the 4 MiB poster cap. Node is single-threaded, so `GET /workbench/poster` wedged
 * the whole debug server for as long as the caller chose; four more comments buys a quarter hour.
 *
 * The scan below reads the prologue in one forward pass: each item is a processing instruction or a
 * comment, each ends at its own first terminator, and nothing is re-examined — so there is nothing
 * to backtrack over.
 *
 * It is NOT byte-identical to the old pattern, and the two differences are deliberate:
 *
 *   - It accepts several processing instructions. The old pattern appeared to allow exactly one
 *     `<?xml …?>`, but its lazy body could expand PAST the first `?>`, so it also accepted
 *     `<?xml …?><?xml-stylesheet …?><svg>` — and `xml-stylesheet` occurs in real SVG files. A strict
 *     one-declaration reading would have started rejecting posters that work today.
 *   - It accepts a comment BEFORE a processing instruction, which the old pattern rejected. That is
 *     what XML actually permits, and this function only recognizes the document SHAPE: the security
 *     decisions (banned tokens, event handlers, external references) run afterwards on the whole
 *     text regardless, so recognizing a wider set of well-formed prologues weakens nothing.
 *
 * Both differences are pinned by name in the differential test rather than left to be discovered.
 */
/** Prologue items to read before giving up. Real documents use one or two; this only bounds abuse. */
const MAX_PROLOGUE_ITEMS = 64;

export function startsWithSvgDocument(text: string): boolean {
  let index = skipWhitespaceFrom(text, 0);
  for (let item = 0; item < MAX_PROLOGUE_ITEMS; item += 1) {
    const next = matchesAt(text, index, "<?")
      ? endOfDelimited(text, index, 2, "?>")
      : matchesAt(text, index, "<!--") ? endOfDelimited(text, index, 4, "-->") : -1;
    // An opened-but-unterminated prologue item is not a document; the old pattern rejected it too.
    if (next === -2) return false;
    if (next < 0) break;
    index = skipWhitespaceFrom(text, next);
  }
  // Bounded slice: five characters, never a copy of the tail.
  return /^<svg[\s>]/i.test(text.slice(index, index + 5));
}

/** End offset of a `<? … ?>` or `<!-- … -->` item; -2 when it is opened and never closed. */
function endOfDelimited(text: string, index: number, openLength: number, close: string): number {
  const end = text.indexOf(close, index + openLength);
  return end < 0 ? -2 : end + close.length;
}

function skipWhitespaceFrom(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

/** Case-insensitive fixed-token compare at one offset, without copying the tail. */
function matchesAt(text: string, index: number, token: string): boolean {
  return text.slice(index, index + token.length).toLowerCase() === token;
}

/**
 * Structural and safety validation for an SVG poster. Accepts a plain vector
 * document (rects, text, paths, gradients, internal `url(#id)` fill references)
 * and rejects any active or externally-referencing construct: scripts, event
 * handlers, `javascript:` URLs, foreignObject/iframe/embed, DOCTYPE/ENTITY
 * (XXE), and any href/src that is not a same-document `#fragment`.
 *
 * @param bytes Candidate poster bytes.
 * @returns ok:true when the document is a safe static SVG, else a reason.
 */
export function assessSvgPosterSafety(bytes: Buffer): { ok: true } | { ok: false; message: string } {
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!startsWithSvgDocument(text)) {
    return { ok: false, message: "Workbench template poster is not a recognizable SVG document." };
  }
  const lower = text.toLowerCase();
  const bannedTokens = ["<script", "<foreignobject", "<!doctype", "<!entity", "<iframe", "<embed", "javascript:"];
  if (bannedTokens.some((token) => lower.includes(token))) {
    return { ok: false, message: "Workbench template poster contains a disallowed active SVG construct." };
  }
  if (/\son[a-z]+\s*=/i.test(text)) {
    return { ok: false, message: "Workbench template poster contains a disallowed event-handler attribute." };
  }
  // Only same-document fragment references (e.g. gradient fills) are allowed.
  const referencePattern = /(?:xlink:href|href|src)\s*=\s*(["'])(.*?)\1/gi;
  let reference: RegExpExecArray | null;
  while ((reference = referencePattern.exec(text)) !== null) {
    if (!reference[2].trim().startsWith("#")) {
      return { ok: false, message: "Workbench template poster references an external resource." };
    }
  }
  return { ok: true };
}
