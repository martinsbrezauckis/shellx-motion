/**
 * Provenance for every tracked binary file, generated from the tree it runs in.
 *
 * Why this exists: a source-reading security review can read every line of TypeScript in this
 * repository, and it can read nothing at all inside a WOFF2, a PNG, or a WAV. A sealed review of the
 * v0.1.0 export said exactly that -- it inspected the 38 binary assets by type, hash, and container
 * metadata, could not perform source-semantic review on them, and correctly recorded its coverage as
 * PARTIAL rather than overstating it. Its open question was whether those assets could be
 * independently provenance-verified or deterministically regenerated before publication.
 *
 * This is the answer to that question, in a form a reader can check rather than trust. For each
 * binary it records what the file is, its exact SHA-256, where it came from, and what a person can do
 * to confirm that claim themselves -- redownload an upstream package, or regenerate the artifact from
 * this repository.
 *
 * The rules are path patterns, not a checked-in file list, because this script must be correct in two
 * trees: the implementation tree (which carries template families withheld from publication) and the
 * public export (which does not). A hardcoded inventory would be wrong in one of them, which is the
 * same drift that put a stale font total into a published NOTICE.
 *
 * Fails closed. A binary matching no rule is an error, not an omission -- that is the property that
 * makes this an inventory rather than a sample, and it means a new binary asset cannot enter the tree
 * without someone stating where it came from.
 *
 * Usage:
 *   node scripts/binary-asset-provenance.mjs           # write docs/public/BINARY_ASSETS.md
 *   node scripts/binary-asset-provenance.mjs --check    # fail on drift, write nothing
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = join(REPO, "docs/public/BINARY_ASSETS.md");
const checkOnly = process.argv.includes("--check");

/** Extensions treated as binary. Kept explicit so "is this binary" is a decision, not a guess. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
  ".wav", ".mp3", ".m4a", ".flac",
  ".mp4", ".webm", ".mov"
]);

/**
 * Provenance rules, first match wins.
 *
 * `origin` states where the bytes came from. `verify` states what a reader can DO about it, which is
 * the part that turns provenance from an assertion into something falsifiable.
 */
const RULES = [
  {
    match: (path) => path.endsWith(".woff2"),
    kind: "Third-party font",
    origin: "Inter (Latin subset), by Rasmus Andersson and The Inter Project Authors, redistributed from the @fontsource/inter npm package under SIL Open Font License 1.1.",
    verify: "Install the upstream package and compare digests: the same weight file from @fontsource/inter has an identical SHA-256. Licence text and the full per-package file list are in NOTICE."
  },
  {
    match: (path) => /^templates\/[^/]+\/[^/]+\/preview\/poster\.png$/.test(path),
    kind: "Rendered by this repository",
    origin: "A frame rendered from the template family it sits in, by ShellX Motion's own render lanes.",
    verify: "Regenerate with `pnpm run template-pack:proof`, which re-renders the product pack from its template sources."
  },
  {
    match: (path) => /(^|\/)assets\/generated\//.test(path),
    kind: "Generated source asset",
    origin: "Imagery generated for the template that carries it, kept as an input asset rather than as render proof.",
    verify: "The generating operation is attested in that package's own `receipts/*.receipt.json`, which records the input hashes and the produced artifact."
  },
  {
    match: (path) => /(^|\/)assets\/audio\/.*\.wav$/.test(path),
    kind: "Synthesized audio",
    origin: "A tone synthesized locally for the template that carries it. No third-party recording, sample library, or model output is involved.",
    verify: "Read the WAV header: a short, single-purpose PCM tone, not a recorded or licensed work."
  },
  {
    match: (path) => path === "assets/brand/shellx-motion-icon.png"
      || /^docs\/public\/site\/.*\/icon\.png$/.test(path),
    kind: "First-party brand art",
    origin: "The ShellX Motion product icon, authored for this project and covered by the repository's MIT licence.",
    verify: "Both copies are byte-identical; compare their SHA-256 values in the table below."
  },
  {
    // The swarm family carries a nuance the general media rule below would hide: every pixel
    // was rendered by Motion from a pure-data package, but the point CLOUD's colours were
    // sampled at author time from AI-generated illustrations. Saying only "rendered by this
    // repository" would be true of the bytes and misleading about the palette's ancestry.
    match: (path) => /^docs\/public\/media\/(swarm-animals(-poster)?\.(mp4|png)|og-card\.png)$/.test(path),
    kind: "Rendered by this repository",
    origin: "Rendered by ShellX Motion's native frame lane and FFmpeg encode from a data-only package of 4,201 keyframed shape layers. The per-point colours were sampled at author time from AI-generated (Grok Imagine) illustration sources; no AI-generated pixels appear directly — every frame is Motion's own raster. The og-card composites one such frame with typeset captions.",
    verify: "The motion.json is pure declarative data (no web/html/canvas layers); the SHA-256 table below pins the exact bytes shipped."
  },
  {
    match: (path) => /^docs\/public\/media\//.test(path),
    kind: "Rendered by this repository",
    origin: "Capability demos rendered by ShellX Motion's own render lanes from data-only demo packages during the 0.1.0 release cycle.",
    verify: "The SHA-256 table below pins the exact bytes shipped; each video's visual style is reproducible with the engine's public layer vocabulary."
  }
];

/** Every tracked file git knows about, so untracked scratch never enters the inventory. */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/**
 * Template families the export manifest withholds, so this document describes what SHIPS.
 *
 * Without this the generator was correct in neither tree at once: it inventoried 49 binaries in the
 * implementation tree, the published tree carries 38, and the 49-entry file is the one that would
 * have shipped — a provenance document listing eleven files the reader does not have. That is the
 * same defect the NOTICE font totals had, in the file whose entire job is to be checkable.
 *
 * Reading the withheld set from the manifest (rather than restating it) keeps one home for the
 * decision. The published tree has no manifest and nothing withheld, so an empty set is correct
 * there and the two trees generate byte-identical output.
 */
function withheldFamilyDirs() {
  const manifestPath = join(REPO, "scripts", "public-export-manifest.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const prefix = "**/templates/shellx-product-pack/";
  return new Set(
    (manifest.excludeWithin ?? [])
      .map((entry) => entry.glob)
      .filter((glob) => glob.startsWith(prefix) && glob.endsWith("/**"))
      .map((glob) => glob.slice(prefix.length, -"/**".length))
  );
}

const withheld = withheldFamilyDirs();
const binaries = [];
for (const path of trackedFiles().sort()) {
  if (!BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
  if ([...withheld].some((dir) => path.startsWith(`templates/shellx-product-pack/${dir}/`))) continue;
  const bytes = await readFile(join(REPO, path));
  const rule = RULES.find((candidate) => candidate.match(path));
  if (!rule) {
    console.error(`No provenance rule matches a tracked binary: ${path}`);
    console.error("Every binary in this repository must state where it came from. Add a rule in");
    console.error("scripts/binary-asset-provenance.mjs, or stop tracking the file.");
    process.exit(1);
  }
  binaries.push({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rule
  });
}

const groups = new Map();
for (const asset of binaries) {
  if (!groups.has(asset.rule.kind)) groups.set(asset.rule.kind, { rule: asset.rule, assets: [] });
  groups.get(asset.rule.kind).assets.push(asset);
}

const lines = [
  "# Binary asset provenance",
  "",
  "<!-- Generated by scripts/binary-asset-provenance.mjs. Do not edit this file by hand. -->",
  "",
  `This repository tracks ${binaries.length} binary files. Everything else in it is source text that`,
  "you, or a reviewing tool, can read directly.",
  "",
  "Binaries are the part of a repository that source review cannot inspect: a security reviewer can",
  "read every line of TypeScript here and learn nothing from the inside of a WOFF2. So this file",
  "states, for each one, what it is, its exact digest, where it came from, and how you can check that",
  "claim without taking our word for it.",
  "",
  "Every tracked binary appears below. That is enforced rather than asserted -- the generator fails",
  "when a binary matches no provenance rule, so a new asset cannot be added without stating its",
  "origin.",
  ""
];

for (const [kind, group] of [...groups.entries()].sort((a, b) => b[1].assets.length - a[1].assets.length)) {
  lines.push(`## ${kind} (${group.assets.length})`);
  lines.push("");
  lines.push(`**Origin.** ${group.rule.origin}`);
  lines.push("");
  lines.push(`**How to verify.** ${group.rule.verify}`);
  lines.push("");
  lines.push("| file | bytes | SHA-256 |");
  lines.push("|---|---:|---|");
  for (const asset of group.assets) {
    lines.push(`| \`${asset.path}\` | ${asset.bytes.toLocaleString("en-US")} | \`${asset.sha256}\` |`);
  }
  lines.push("");
}

lines.push("## Scope");
lines.push("");
lines.push("This file covers provenance: where each binary came from and how to confirm it. It is not a");
lines.push("claim that binary content has been semantically reviewed the way source is reviewed. Fonts and");
lines.push("media are parsed by third-party decoders, and this document does not audit those decoders.");
lines.push("");
lines.push("Licence terms for redistributed third-party material are in [`NOTICE`](../../NOTICE);");
lines.push("everything first-party is under the repository's [MIT licence](../../LICENSE).");
lines.push("");

const rendered = `${lines.join("\n")}`;

if (checkOnly) {
  const existing = await readFile(OUTPUT, "utf8").catch(() => null);
  if (existing !== rendered) {
    console.error("docs/public/BINARY_ASSETS.md is out of date.");
    console.error("Regenerate it with: node scripts/binary-asset-provenance.mjs");
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, gate: "binary-asset-provenance", binaries: binaries.length }, null, 2));
  process.exit(0);
}

await writeFile(OUTPUT, rendered, "utf8");
console.log(JSON.stringify({ ok: true, wrote: "docs/public/BINARY_ASSETS.md", binaries: binaries.length }, null, 2));
