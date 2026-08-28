#!/usr/bin/env node
/**
 * Verify local Markdown links in the public and agent-facing documentation corpus.
 *
 * This is deliberately a small, offline gate rather than a general Markdown renderer. It checks
 * only the links that can drift when a file moves: README.md and all Markdown under docs/public
 * and skill. Relative targets must exist inside the repository; fragments on Markdown targets
 * must match their GitHub-style heading anchor. Web, mail, protocol-relative, and other non-file
 * URI schemes belong to their owning transport and are deliberately outside this filesystem check.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_MARKDOWN_FILES = 2_048;
const MAX_MARKDOWN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINKS_PER_FILE = 8_192;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/g;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Mirrors @shellx-motion/core's UTF-16 code-unit comparator without making this Node-only gate
// depend on loading the TypeScript workspace package.
function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Return the three deliberate public/agent-facing Markdown roots in deterministic order. */
export function documentationMarkdownFiles(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const files = [];
  const readTree = (path) => {
    if (!existsSync(path)) return;
    const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) readTree(candidate);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(candidate);
    }
  };

  const readme = join(root, "README.md");
  if (existsSync(readme)) files.push(readme);
  readTree(join(root, "docs", "public"));
  readTree(join(root, "skill"));
  return files.sort((left, right) => compareCodeUnits(displayPath(root, left), displayPath(root, right)));
}

/** GitHub's current heading-id shape for the ASCII Markdown corpus this repository publishes. */
export function githubHeadingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[\\`~!@#$%^&*()+={}\[\]|:;"'<>,.?/]/g, "")
    .replace(/\s+/g, "-");
}

/** Return the concrete GitHub-style heading ids for one Markdown file, including duplicates. */
export function markdownHeadingAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  const lines = maskFencedCode(source).split(/\r?\n/);
  const add = (heading) => {
    const base = githubHeadingAnchor(heading);
    if (!base) return;
    const duplicate = occurrences.get(base) ?? 0;
    occurrences.set(base, duplicate + 1);
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const atx = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index]);
    if (atx) {
      add(atx[1]);
      continue;
    }
    if (index + 1 < lines.length && lines[index].trim() !== "" && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1])) {
      add(lines[index]);
      index += 1;
    }
  }
  return anchors;
}

/** Inspect all local links. The returned report is exported so focused fixtures can exercise it. */
export function inspectMarkdownLinkIntegrity(repositoryRoot = ROOT) {
  const root = resolve(repositoryRoot);
  const report = { files: 0, links: 0, errors: [] };
  const anchorsByPath = new Map();
  const files = documentationMarkdownFiles(root);
  if (files.length > MAX_MARKDOWN_FILES) {
    report.errors.push(`documentation corpus has ${files.length} Markdown files, exceeding the ${MAX_MARKDOWN_FILES} file bound.`);
    return report;
  }

  const anchorsFor = (path) => {
    const cached = anchorsByPath.get(path);
    if (cached) return cached;
    const source = readBoundedMarkdown(root, path, report.errors);
    if (source === null) return new Set();
    const anchors = markdownHeadingAnchors(source);
    anchorsByPath.set(path, anchors);
    return anchors;
  };

  for (const sourcePath of files) {
    const source = readBoundedMarkdown(root, sourcePath, report.errors);
    if (source === null) continue;
    report.files += 1;
    anchorsFor(sourcePath);
    const masked = maskFencedCode(source);
    let linksInFile = 0;
    for (const match of masked.matchAll(MARKDOWN_LINK)) {
      linksInFile += 1;
      if (linksInFile > MAX_LINKS_PER_FILE) {
        report.errors.push(`${displayPath(root, sourcePath)}:${lineAt(masked, match.index)} exceeds the ${MAX_LINKS_PER_FILE} local-link bound.`);
        break;
      }
      report.links += 1;
      const destination = match[1] ?? match[2] ?? "";
      inspectDestination({ root, sourcePath, destination, line: lineAt(masked, match.index), report, anchorsFor });
    }
  }
  return report;
}

/**
 * Verify that a public Markdown link is usable from the Workbench documentation reader.
 *
 * The reader resolves page ids exclusively through docs/public/index.json. A filesystem-valid
 * relative link can therefore still be inert in the Workbench when its target is absent from
 * that manifest. Audience remains a navigation concern: agent-only pages stay indexed but are
 * omitted from the human reader payload.
 */
export function inspectWorkbenchDocsReachability(repositoryRoot = ROOT) {
  const root = resolve(repositoryRoot);
  const docsRoot = join(root, "docs", "public");
  const report = { pages: 0, links: 0, errors: [] };
  const indexedPages = indexedWorkbenchPages(root, docsRoot, report.errors);
  const pagesByPath = new Map(indexedPages.map((page) => [page.path, page]));

  for (const page of indexedPages) {
    const source = readBoundedMarkdown(root, page.path, report.errors);
    if (source === null) continue;
    report.pages += 1;
    const masked = maskFencedCode(source);
    let linksInFile = 0;
    for (const match of masked.matchAll(MARKDOWN_LINK)) {
      if (match[0].startsWith("!")) continue;
      linksInFile += 1;
      if (linksInFile > MAX_LINKS_PER_FILE) {
        report.errors.push(`${displayPath(root, page.path)}:${lineAt(masked, match.index)} exceeds the ${MAX_LINKS_PER_FILE} local-link bound.`);
        break;
      }
      const destination = match[1] ?? match[2] ?? "";
      const target = indexedMarkdownTarget({ root, docsRoot, sourcePath: page.path, destination, line: lineAt(masked, match.index), report });
      if (target === null) continue;
      report.links += 1;
      const targetPage = pagesByPath.get(target);
      if (!targetPage) {
        report.errors.push(`${displayPath(root, page.path)}:${lineAt(masked, match.index)} targets a public Markdown page absent from docs/public/index.json: ${destination}`);
        continue;
      }
    }
  }
  return report;
}

function indexedWorkbenchPages(root, docsRoot, errors) {
  const indexPath = join(docsRoot, "index.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    errors.push("docs/public/index.json is not valid JSON for Workbench reachability.");
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed.sections)) {
    errors.push("docs/public/index.json must contain a sections array for Workbench reachability.");
    return [];
  }

  const pages = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const section of parsed.sections) {
    if (typeof section !== "object" || section === null || !Array.isArray(section.pages)) {
      errors.push("docs/public/index.json has a section without a pages array for Workbench reachability.");
      continue;
    }
    for (const page of section.pages) {
      if (typeof page !== "object" || page === null || typeof page.id !== "string" || typeof page.file !== "string") {
        errors.push("docs/public/index.json has a page without string id and file values for Workbench reachability.");
        continue;
      }
      const path = resolve(docsRoot, page.file);
      if (!isInside(docsRoot, path) || !isMarkdownFile(path)) {
        errors.push(`docs/public/index.json declares an unsafe Markdown page for Workbench reachability: ${page.id}.`);
        continue;
      }
      if (seenIds.has(page.id)) {
        errors.push(`docs/public/index.json declares duplicate Workbench page id: ${page.id}.`);
        continue;
      }
      if (seenPaths.has(path)) {
        errors.push(`docs/public/index.json declares duplicate Workbench page file: ${displayPath(root, path)}.`);
        continue;
      }
      seenIds.add(page.id);
      seenPaths.add(path);
      pages.push({ id: page.id, path, audience: page.audience });
    }
  }
  return pages;
}

function indexedMarkdownTarget({ root, docsRoot, sourcePath, destination, line, report }) {
  if (destination.startsWith("//")) return null;
  const scheme = URI_SCHEME.exec(destination)?.[0].slice(0, -1).toLowerCase();
  if (scheme) return null;
  const hash = destination.indexOf("#");
  const rawPath = (hash === -1 ? destination : destination.slice(0, hash)).split("?", 1)[0];
  if (rawPath === "") return null;
  const path = decodePart(rawPath, root, sourcePath, line, report, "path");
  if (path === null || isAbsolute(path)) return null;
  const target = resolve(dirname(sourcePath), path);
  if (!isInside(docsRoot, target) || !isMarkdownFile(target) || !existsSync(target)) return null;
  return target;
}

function inspectDestination({ root, sourcePath, destination, line, report, anchorsFor }) {
  if (isPublicDocumentation(root, sourcePath) && hasTypeScriptSourceLineAnchor(destination)) {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} uses an unvalidated TypeScript source-line anchor: ${destination}`);
    return;
  }
  if (destination.startsWith("//")) return;
  const scheme = URI_SCHEME.exec(destination)?.[0].slice(0, -1).toLowerCase();
  if (scheme && scheme !== "file") return;
  if (scheme === "file") {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} uses a file URI; documentation links must use a repository-relative path.`);
    return;
  }

  const hash = destination.indexOf("#");
  const rawPath = (hash === -1 ? destination : destination.slice(0, hash)).split("?", 1)[0];
  const rawFragment = hash === -1 ? "" : destination.slice(hash + 1);
  const path = decodePart(rawPath, root, sourcePath, line, report, "path");
  const fragment = decodePart(rawFragment, root, sourcePath, line, report, "fragment");
  if (path === null || fragment === null) return;

  if (isAbsolute(path)) {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} uses an absolute local path: ${destination}`);
    return;
  }
  const target = path === "" ? sourcePath : resolve(dirname(sourcePath), path);
  if (!isInside(root, target)) {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} resolves outside the repository: ${destination}`);
    return;
  }
  if (!existsSync(target)) {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} has a missing local target: ${destination} (resolved ${displayPath(root, target)})`);
    return;
  }
  if (fragment === "") return;
  let facts;
  try {
    facts = lstatSync(target);
  } catch {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} cannot inspect local target: ${destination}`);
    return;
  }
  if (!facts.isFile() || !isMarkdownFile(target)) return;
  if (!anchorsFor(target).has(fragment)) {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} has a missing heading anchor: ${destination} (target ${displayPath(root, target)})`);
  }
}

/** Public documentation must not claim a source line remains a durable API reference. */
function isPublicDocumentation(root, sourcePath) {
  const pathFromPublicDocs = relative(join(root, "docs", "public"), sourcePath);
  return pathFromPublicDocs !== "" && pathFromPublicDocs !== ".."
    && !pathFromPublicDocs.startsWith(`..${sep}`) && !isAbsolute(pathFromPublicDocs);
}

/** Source-line fragments move without a contract; use a named test or file reference instead. */
function hasTypeScriptSourceLineAnchor(destination) {
  return /\.tsx?(?:\?[^#]*)?#L\d+(?:-L\d+)?$/i.test(destination);
}

function readBoundedMarkdown(root, path, errors) {
  let facts;
  try {
    facts = lstatSync(path);
  } catch {
    errors.push(`${displayPath(root, path)} cannot be read for Markdown link integrity.`);
    return null;
  }
  if (!facts.isFile()) {
    errors.push(`${displayPath(root, path)} is not a regular Markdown file.`);
    return null;
  }
  if (facts.size > MAX_MARKDOWN_FILE_BYTES) {
    errors.push(`${displayPath(root, path)} is ${facts.size} bytes, exceeding the ${MAX_MARKDOWN_FILE_BYTES} Markdown-file bound.`);
    return null;
  }
  return readFileSync(path, "utf8");
}

/** Preserve line offsets while removing fenced examples; examples are not live documentation links. */
function maskFencedCode(source) {
  let activeFence = null;
  return source.split(/(\r?\n)/).map((part) => {
    if (part === "\n" || part === "\r\n") return part;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(part);
    if (fence && (!activeFence || fence[1][0] === activeFence)) {
      activeFence = activeFence ? null : fence[1][0];
      return part;
    }
    return activeFence ? part.replace(/[^\r\n]/g, " ") : part;
  }).join("");
}

function decodePart(value, root, sourcePath, line, report, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    report.errors.push(`${displayPath(root, sourcePath)}:${line} has an invalid percent-encoded ${label} in its local link.`);
    return null;
  }
}

function isMarkdownFile(path) {
  return path.toLowerCase().endsWith(".md") || basename(path).toLowerCase() === "readme";
}

function isInside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative));
}

function lineAt(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function displayPath(root, path) {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const integrity = inspectMarkdownLinkIntegrity(ROOT);
  const reachability = inspectWorkbenchDocsReachability(ROOT);
  const errors = [...integrity.errors, ...reachability.errors];
  if (errors.length > 0) {
    console.error(`markdown-link-integrity: FAIL — ${errors.length} problem(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`markdown-link-integrity: OK — ${integrity.files} Markdown file(s), ${integrity.links} inline link(s); workbench reachability covers ${reachability.pages} indexed page(s) and ${reachability.links} public Markdown link(s).`);
  }
}
