/**
 * workbench-docs.ts — bounded reader for the Engine Room documentation tree.
 *
 * Role: serve `docs/public/index.json` and its markdown pages to the authenticated
 * workbench. The docs tree is the single source of user documentation (the same
 * content that later ships to docs.theshellx.com), so the server exposes it read
 * only and by strict id lookup.
 *
 * Dependencies: node:fs/promises, node:path. No network, no execution.
 *
 * Primary caller: `@shellx-motion/debug-server` index route handler
 * (`GET /workbench/docs/index.json`, `GET /workbench/docs/page?id=`).
 *
 * Security invariants:
 * - The page endpoint maps a caller-supplied page id to a file STRICTLY through
 *   the index.json manifest; the caller can never supply a file path directly.
 * - Even the manifest-declared file path is realpath-contained inside the docs
 *   root and rejected if it is a symlink or escapes the root.
 * - Every read is size-bounded so a docs file cannot exhaust server memory.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";

/** Hard ceiling for the navigation manifest. It is small structured JSON. */
const MAX_DOCS_INDEX_BYTES = 256 * 1024;
/** Hard ceiling for a single markdown page. Generous for long-form prose. */
const MAX_DOCS_PAGE_BYTES = 1024 * 1024;

/** A bounded documentation read result: raw bytes plus its declared content type. */
export type WorkbenchDocsRead =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; code: string; message: string };

/** One navigable page as declared in `index.json`. */
interface DocsIndexPage {
  id: string;
  title: string;
  file: string;
  audience?: "human" | "agent";
}

/**
 * Read and serve the documentation navigation manifest (`index.json`).
 *
 * @param docsRoot Absolute path to the docs/public root.
 * @returns The bounded JSON bytes, or a typed error.
 */
export async function readWorkbenchDocsIndex(docsRoot: string): Promise<WorkbenchDocsRead> {
  const read = await readBoundedDocsFile(join(docsRoot, "index.json"), docsRoot, MAX_DOCS_INDEX_BYTES);
  if (!read.ok) return read;
  const humanIndex = humanDocsIndex(read.bytes);
  if (!humanIndex.ok) return humanIndex;
  return { ok: true, bytes: humanIndex.bytes, contentType: "application/json; charset=utf-8" };
}

/**
 * Read one documentation page, resolving the caller-supplied page id to a file
 * exclusively through the `index.json` manifest.
 *
 * @param docsRoot Absolute path to the docs/public root.
 * @param pageId The page id requested by the workbench (from the `id` query param).
 * @returns The bounded markdown bytes, or a typed error.
 */
export async function readWorkbenchDocsPage(docsRoot: string, pageId: string): Promise<WorkbenchDocsRead> {
  if (typeof pageId !== "string" || pageId.trim() === "") {
    return { ok: false, status: 400, code: "invalid_docs_page_id", message: "Documentation page requests require a non-empty id query parameter." };
  }
  const indexRead = await readBoundedDocsFile(join(docsRoot, "index.json"), docsRoot, MAX_DOCS_INDEX_BYTES);
  if (!indexRead.ok) return indexRead;

  const file = docsPageFileForId(indexRead.bytes, pageId);
  if (!file.ok) return file;
  // The file path originates from the trusted manifest, never from the query, and
  // is still realpath-contained below as defense in depth.
  const pageRead = await readBoundedDocsFile(join(docsRoot, file.file), docsRoot, MAX_DOCS_PAGE_BYTES);
  if (!pageRead.ok) {
    // Translate a missing manifest-declared file into a 404 for that page id.
    if (pageRead.code === "docs_file_not_found") {
      return { ok: false, status: 404, code: "docs_page_not_found", message: `Documentation page file is missing for id: ${pageId}.` };
    }
    return pageRead;
  }
  return { ok: true, bytes: pageRead.bytes, contentType: "text/markdown; charset=utf-8" };
}

/**
 * Resolve a page id to its declared file by parsing the navigation manifest.
 * Rejects unknown ids and any file value that is absolute or escapes the tree.
 */
function docsPageFileForId(indexBytes: Buffer, pageId: string):
  | { ok: true; file: string }
  | { ok: false; status: number; code: string; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    return { ok: false, status: 500, code: "docs_index_invalid", message: "Documentation index.json is not valid JSON." };
  }
  const sections = readSections(parsed);
  for (const section of sections) {
    for (const page of readPages(section)) {
      if (page.id === pageId) {
        if (page.audience === "agent") continue;
        if (typeof page.file !== "string" || page.file.trim() === "" || isAbsolute(page.file) || page.file.includes("\0")) {
          return { ok: false, status: 500, code: "docs_index_invalid", message: `Documentation index.json declares an unsafe file for id: ${pageId}.` };
        }
        return { ok: true, file: page.file };
      }
    }
  }
  return { ok: false, status: 404, code: "docs_page_not_found", message: `Unknown documentation page id: ${pageId}.` };
}

/** Remove agent-reference pages from the human Workbench navigation payload. */
function humanDocsIndex(indexBytes: Buffer):
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number; code: string; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(indexBytes.toString("utf8"));
  } catch {
    return { ok: false, status: 500, code: "docs_index_invalid", message: "Documentation index.json is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 500, code: "docs_index_invalid", message: "Documentation index.json must be an object." };
  }
  const manifest = parsed as Record<string, unknown>;
  const sections = readSections(parsed)
    .filter((section): section is Record<string, unknown> => typeof section === "object" && section !== null && !Array.isArray(section))
    .map((section) => ({
      ...section,
      pages: readPages(section).filter((page) => page.audience !== "agent")
    }))
    .filter((section) => section.pages.length > 0);
  return { ok: true, bytes: Buffer.from(canonicalJson({ ...manifest, sections })) };
}

function readSections(parsed: unknown): unknown[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const sections = (parsed as { sections?: unknown }).sections;
  return Array.isArray(sections) ? sections : [];
}

function readPages(section: unknown): DocsIndexPage[] {
  if (typeof section !== "object" || section === null) return [];
  const pages = (section as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];
  return pages.filter((page): page is DocsIndexPage =>
    typeof page === "object" && page !== null
    && typeof (page as DocsIndexPage).id === "string"
    && typeof (page as DocsIndexPage).file === "string");
}

/**
 * Read a bounded, symlink-free regular file that resolves inside the docs root.
 * Shared by the index and page readers so both honor the same size and
 * containment invariants.
 */
async function readBoundedDocsFile(requestedPath: string, docsRoot: string, maxBytes: number): Promise<WorkbenchDocsRead> {
  const resolvedPath = resolve(requestedPath);
  let facts: Awaited<ReturnType<typeof lstat>>;
  try {
    facts = await lstat(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404, code: "docs_file_not_found", message: "Documentation file was not found." };
    }
    return { ok: false, status: 400, code: "unsafe_docs_file", message: "Documentation file could not be opened safely." };
  }
  if (!facts.isFile() || facts.isSymbolicLink()) {
    return { ok: false, status: 400, code: "unsafe_docs_file", message: "Documentation file must be a bounded regular file, not a symlink." };
  }
  if (facts.size > maxBytes) {
    return { ok: false, status: 400, code: "docs_file_too_large", message: "Documentation file exceeds the workbench size bound." };
  }
  let canonicalPath: string;
  let canonicalRoot: string;
  try {
    [canonicalPath, canonicalRoot] = await Promise.all([realpath(resolvedPath), realpath(docsRoot)]);
  } catch {
    return { ok: false, status: 400, code: "unsafe_docs_file", message: "Documentation file could not be resolved safely." };
  }
  const rel = relative(canonicalRoot, canonicalPath);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    return { ok: false, status: 400, code: "unsafe_docs_file", message: "Documentation file resolves outside the docs root." };
  }
  const bytes = await readFile(resolvedPath);
  if (bytes.byteLength > maxBytes) {
    return { ok: false, status: 400, code: "docs_file_too_large", message: "Documentation file exceeds the workbench size bound." };
  }
  return { ok: true, bytes, contentType: "application/octet-stream" };
}
