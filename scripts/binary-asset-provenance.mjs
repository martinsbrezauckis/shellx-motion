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
 * trees: the implementation tree (which carries deliberately excluded private records and template
 * families withheld from publication) and the public export (which does not). A hardcoded inventory
 * would be wrong in one of them, which is the same drift that put a stale font total into a published
 * NOTICE.
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
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
    match: (path) => path === "fixtures/packages/gpu-v25b1-scrub-signal/assets/video/atmosphere-fog-rays.mp4",
    kind: "V25-B1 fixture video copy",
    origin: "A byte-identical copy of the silent generated atmosphere-background source in the public keyed-subject-promo template. It is a V25-B1 exact-time GPU-preview input, not a rendered preview or final-media proof.",
    verify: "Compare its SHA-256 with `templates/shellx-product-pack/keyed-subject-promo/assets/generated/atmosphere-fog-rays.mp4` and with `contentSha256` in that template's `receipts/generated-background.receipt.json`; the scrub-signal source recipe also verifies the digest before copying."
  },
  {
    match: (path) => /^fixtures\/packages\/gpu-v25b1-scrub-signal\/assets\/fonts\/inter-latin-(600|900)-normal\.woff2$/.test(path),
    kind: "V25-B1 fixture font copies",
    origin: "Byte-identical Inter Latin subset faces copied from the public keyed-subject-promo template, redistributed under SIL Open Font License 1.1 for manifest-bound typography in the V25-B1 preview fixture.",
    verify: "Compare each SHA-256 with the same path under `templates/shellx-product-pack/keyed-subject-promo/assets/fonts/`; the fixture recipe verifies each source digest before copying and `NOTICE` carries the licence inventory."
  },
  {
    // SVG is reviewable source text, so it is intentionally outside BINARY_EXTENSIONS and will not
    // appear in BINARY_ASSETS.md. Keep its exact-copy provenance adjacent to the binary rules so
    // the complete V25-B1 asset closure cannot silently drift.
    match: (path) => path === "fixtures/packages/gpu-v25b1-scrub-signal/assets/images/neon-studio.svg",
    kind: "V25-B1 fixture SVG copy",
    origin: "A byte-identical copy of the redistribution-safe Neon Studio SVG sample in the public keyed-subject-promo template.",
    verify: "Compare its SHA-256 with `templates/shellx-product-pack/keyed-subject-promo/assets/samples/neon-studio.svg`; the scrub-signal recipe verifies that digest before copying."
  },
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
    match: (path) => path === "fixtures/packages/gpu-g9-mixed-media-atlas/assets/video/atmosphere-fog-rays.mp4",
    kind: "Generated source fixture copy",
    origin: "A byte-identical copy of the silent generated atmosphere-background asset in the public keyed-subject-promo template. Its original generated-asset receipt records the bundled-sample route, media facts, generator terms, and source digest.",
    verify: "Compare this file's SHA-256 with `templates/shellx-product-pack/keyed-subject-promo/assets/generated/atmosphere-fog-rays.mp4` and with `contentSha256` in that template's `receipts/generated-background.receipt.json`."
  },
  {
    match: (path) => path === "fixtures/packages/gpu-material-admitted/assets/poster.png",
    kind: "Rendered template fixture copy",
    origin: "A byte-identical copy of the public feature-announcement template's browser-lane rendered poster, used as the fixed image input for the GPU material fixture.",
    verify: "Compare this file's SHA-256 with `templates/shellx-product-pack/feature-announcement/preview/poster.png`, then regenerate that source poster with `pnpm run template-pack:proof`."
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

/**
 * Every file Git knows about in the implementation tree. A public source export
 * deliberately has no Git metadata, so it falls back to the source filesystem
 * while excluding dependency, build, and scratch outputs that a prior command
 * may have created. The export itself was constructed from the implementation
 * tracked set, so these two modes describe the same public payload.
 */
function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    const ignoredDirectories = new Set([".git", ".scratch", "build", "coverage", "dist", "node_modules"]);
    const files = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) files.push(relative(REPO, absolute).replaceAll("\\", "/"));
      }
    };
    visit(REPO);
    return files;
  }
}

/**
 * The implementation-only roots and template families the export manifest withholds, so this
 * document describes what SHIPS.
 *
 * Without this the generator was correct in neither tree at once: its implementation inventory would
 * include private captures and withheld template assets that the published tree does not carry. That
 * would ship a provenance document listing files the reader does not have — the same defect the
 * NOTICE font totals had, in the file whose entire job is to be checkable.
 *
 * Reading the withheld set from the manifest (rather than restating it) keeps one home for the
 * decision. The published tree has no manifest and nothing withheld, so an empty set is correct
 * there and the two trees generate byte-identical output.
 */
function exportManifest() {
  const manifestPath = join(REPO, "scripts", "public-export-manifest.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function withheldFamilyDirs(manifest) {
  if (!manifest) return new Set();
  const prefix = "**/templates/shellx-product-pack/";
  return new Set(
    (manifest.excludeWithin ?? [])
      .map((entry) => entry.glob)
      .filter((glob) => glob.startsWith(prefix) && glob.endsWith("/**"))
      .map((glob) => glob.slice(prefix.length, -"/**".length))
  );
}

function deliberatelyExcludedRoots(manifest) {
  if (!manifest) return new Set();
  const roots = new Set((manifest.deliberatelyExcluded ?? []).map((entry) => {
    const path = entry?.path;
    if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`Invalid deliberatelyExcluded path in scripts/public-export-manifest.json: ${JSON.stringify(path)}`);
    }
    return path.replace(/\/$/, "");
  }));
  // A directory excluded from an included root is just as absent from the public export as a
  // deliberatelyExcluded top-level root. Recognize exact `**/path/**` entries so private author-time
  // generator assets do not leak into the public binary inventory. Filename globs and wildcarded
  // path segments remain intentionally unsupported here rather than being approximated.
  for (const entry of manifest.excludeWithin ?? []) {
    const match = typeof entry?.glob === "string" ? /^\*\*\/([^*?[\]{}]+)\/\*\*$/.exec(entry.glob) : null;
    if (match) roots.add(match[1].replace(/\/$/, ""));
  }
  return roots;
}

function isDeliberatelyExcluded(path, roots) {
  return [...roots].some((root) => path === root || path.startsWith(`${root}/`));
}

const manifest = exportManifest();
const withheld = withheldFamilyDirs(manifest);
const deliberatelyExcluded = deliberatelyExcludedRoots(manifest);
const binaries = [];
for (const path of trackedFiles().sort()) {
  if (!BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
  if (isDeliberatelyExcluded(path, deliberatelyExcluded)) continue;
  if ([...withheld].some((dir) => path.startsWith(`templates/shellx-product-pack/${dir}/`))) continue;
  const bytes = await readFile(join(REPO, path));
  const rule = RULES.find((candidate) => candidate.match(path));
  if (!rule) {
    console.error(`No provenance rule matches a published binary: ${path}`);
    console.error("Every binary that ships in the public source release must state where it came from. Add a rule in");
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
  `The public source release ships ${binaries.length} binary files. Everything else shipped in it is`,
  "source text that you, or a reviewing tool, can read directly.",
  "",
  "Binaries are the part of a repository that source review cannot inspect: a security reviewer can",
  "read every line of TypeScript here and learn nothing from the inside of a WOFF2. So this file",
  "states, for each one, what it is, its exact digest, where it came from, and how you can check that",
  "claim without taking our word for it.",
  "",
  "Every binary in the public source release appears below. The implementation tree reads the export",
  "manifest and excludes its deliberately excluded roots before inventorying. The generator then fails",
  "when a shipped binary matches no provenance rule, so a new public asset cannot be added without",
  "stating its origin.",
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
