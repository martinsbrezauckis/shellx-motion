/**
 * NOTICE must attribute exactly the bundled font files that actually ship — no more, no fewer.
 *
 * Role: NOTICE is hand-maintained and lists bundled Inter faces per package directory. Nothing
 * checked it against the tree, so it could drift in both directions and neither was visible:
 *
 *   - OVER-attribution: NOTICE names a directory that no longer ships, so the published tree's own
 *     NOTICE describes files that are not in it.
 *   - UNDER-attribution: a new package bundles a font and nobody adds it. That is a licence
 *     compliance problem, not a tidiness one, which is why this gate checks both directions rather
 *     than only the one the regression happened to catch.
 *
 * Families the export manifest withholds are ignored on BOTH sides, so this gate is correct in the
 * implementation tree (which holds them) and in the published export (which does not).
 *
 * Usage: node scripts/notice-attribution-gate.mjs
 * Exit 0 when NOTICE and the tree agree; exit 1 naming every path that differs.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Directory names the export manifest withholds, so neither side of the check counts them. */
async function withheldFamilyDirs() {
  // Absent in the published tree: the published tree does not carry the export manifest (it is implementation-side release machinery), and by definition nothing is withheld there -- the withheld families are simply absent. An empty set is the correct answer, not an error.
  const manifestPath = join(REPO, "scripts", "public-export-manifest.json");
  if (!existsSync(manifestPath)) return new Set();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const prefix = "**/templates/shellx-product-pack/";
  return new Set(
    manifest.excludeWithin
      .map((entry) => entry.glob)
      .filter((glob) => glob.startsWith(prefix) && glob.endsWith("/**"))
      .map((glob) => glob.slice(prefix.length, -"/**".length))
  );
}

/** Every `<dir>/<font-file>` pair NOTICE claims, read from its indented block form. */
async function attributedFontPaths() {
  const text = await readFile(join(REPO, "NOTICE"), "utf8");
  const claimed = new Set();
  let currentDir = null;
  for (const line of text.split("\n")) {
    const header = /^ {2}(\S+\/)$/.exec(line);
    if (header) { currentDir = header[1]; continue; }
    const file = /^ {4}(\S+\.woff2)$/.exec(line);
    if (file && currentDir) claimed.add(`${currentDir}${file[1]}`);
    else if (line.trim() === "") currentDir = currentDir;
    else if (!file) currentDir = null;
  }
  return claimed;
}

/** Every bundled `.woff2` actually present under the roots NOTICE covers. */
async function bundledFontPaths(withheld) {
  const found = new Set();
  for (const root of ["templates", "fixtures"]) {
    const absoluteRoot = join(REPO, root);
    if (!existsSync(absoluteRoot)) continue;
    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        const rel = child.slice(REPO.length + 1).split("\\").join("/");
        if (entry.isDirectory()) {
          if (withheld.has(entry.name) && rel.startsWith("templates/shellx-product-pack/")) continue;
          stack.push(child);
        } else if (entry.name.endsWith(".woff2")) {
          found.add(rel);
        }
      }
    }
  }
  return found;
}

const withheld = await withheldFamilyDirs();
const claimed = await attributedFontPaths();
const bundled = await bundledFontPaths(withheld);

// Drop claims about withheld families before comparing: they are attributed nowhere and ship nowhere.
const claimedShipping = new Set(
  [...claimed].filter((path) => ![...withheld].some((dir) => path.includes(`/${dir}/`)))
);

const attributedButAbsent = [...claimedShipping].filter((path) => !bundled.has(path)).sort();
const shippedButUnattributed = [...bundled].filter((path) => !claimedShipping.has(path)).sort();

// A hardcoded TOTAL in the prose is a third drift direction, and the only one that survived the
// per-path checks above: NOTICE is copied verbatim into the public export, which ships fewer font
// copies than the implementation tree, so one literal number cannot be true in both trees. It read
// "28 WOFF2 copies" in a published export that carried 20. The per-directory list already tells a
// reader exactly what ships, so the fix is that no such total exists to go stale -- and this check
// keeps it from being reintroduced by someone who thinks a count would be helpful.
const staleTotal = /\((\d+)\s+WOFF2 copies/.exec(await readFile(join(REPO, "NOTICE"), "utf8"));
if (staleTotal) {
  console.error(`NOTICE states a hardcoded total of ${staleTotal[1]} WOFF2 copies.`);
  console.error(`This tree ships ${bundled.size}. NOTICE is copied verbatim into the public export,`);
  console.error("which bundles a different number, so any literal total is wrong in one tree or the other.");
  console.error("State the per-directory list only, without a total.");
  process.exit(1);
}

if (attributedButAbsent.length === 0 && shippedButUnattributed.length === 0) {
  console.log(JSON.stringify({ ok: true, gate: "notice-attribution", attributedFonts: claimedShipping.size }, null, 2));
  process.exit(0);
}

if (attributedButAbsent.length > 0) {
  console.error(`NOTICE attributes ${attributedButAbsent.length} font file(s) that do not exist here:`);
  for (const path of attributedButAbsent) console.error(`  - ${path}`);
}
if (shippedButUnattributed.length > 0) {
  console.error(`${shippedButUnattributed.length} bundled font file(s) ship with no NOTICE attribution:`);
  for (const path of shippedButUnattributed) console.error(`  - ${path}`);
}
console.error("NOTICE must describe exactly what ships. Update NOTICE, or stop bundling the file.");
process.exit(1);
