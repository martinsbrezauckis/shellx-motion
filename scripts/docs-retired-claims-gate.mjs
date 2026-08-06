#!/usr/bin/env node
/**
 * scripts/docs-retired-claims-gate.mjs — the published docs may not deny a capability that ships.
 *
 * ROLE
 * ----
 * `docs/public/**` is exported verbatim to anyone integrating Motion, and agents read it as fact.
 * When live job queries landed, `docs/public/rendering.md` kept saying "There is no server-side job
 * registry, no job id you can hold while a render runs" and "there is no live job-query command
 * yet" after live query support shipped. Nothing failed, because the whole of
 * `docs/public/` was covered by no gate: `job-status-lint.mjs` reads only `docs/public/JOB_STATUS.md`, and
 * `generate-job-status.mjs` only regenerates its two outputs. A host implementer who believed the
 * page would have skipped a polling integration that exists.
 *
 * A stale sentence is not a spelling problem, it is a false statement about the product, and the
 * only durable fix is a check that fails when the two disagree.
 *
 * HOW IT DECIDES
 * --------------
 * Each rule pairs a CAPABILITY — proved present by reading the source of record, not by a snapshot
 * — with the phrases that deny it. The rule is enforced only while the capability actually ships,
 * so removing a feature does not strand the documentation that correctly describes its absence.
 *
 * Blockquoted lines (`>`) are exempt: this corpus documents its own corrections, and
 * `host-integration.md` quotes the retired claim in the note explaining that it is no longer true.
 * Quoting a past statement is not making it.
 *
 * DEPENDENCIES: none beyond node:fs. No build, no network.
 * CALLERS: `pnpm run docs:check`, therefore `pnpm test`.
 *
 * USAGE: node scripts/docs-retired-claims-gate.mjs
 * Exit code: 0 when the docs and the code agree, 1 with the offending file:line otherwise.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Every documentation surface a user or an agent reads as current product truth.
 *
 * WAS `docs/public` ALONE, which is the narrower half of the problem. `skill/shellx-motion/**` is what
 * an AGENT reads before it does anything, and README.md is the entry point a human lands on — a
 * retired claim in either does exactly the damage this gate exists to prevent, and neither was
 * checked. Three other gates were found this same night inspecting less than they claimed to govern
 * (job-status-lint, no-nul-bytes, and a root vitest config that silently emptied eight packages'
 * suites), so this was widened before it could become the fourth.
 *
 * Implementation-only documentation is deliberately not here because it is not published product guidance.
 */
const DOC_ROOTS = [join(ROOT, "docs", "public"), join(ROOT, "skill")];
const DOC_FILES = [join(ROOT, "README.md")];

/**
 * @typedef {object} RetiredClaimRule
 * @property {string} capability human-readable name of what ships
 * @property {string} evidence file that proves the capability exists
 * @property {string[]} present every string that must appear in `evidence` for the rule to apply
 * @property {RegExp[]} forbidden phrases that deny the capability
 * @property {string} instead what the documentation should say now
 */

/** @type {RetiredClaimRule[]} */
const RULES = [
  {
    capability: "live job queries (motion.job.get / motion.job.list)",
    evidence: "packages/debug-api/src/command-registry.ts",
    present: ['"motion.job.get"', '"motion.job.list"'],
    forbidden: [
      /no server-side job registry/i,
      /no live job[- ]query command/i,
      /no job id you can hold/i,
      /no way to (?:query|watch|poll) a (?:running|live) (?:render|job)/i
    ],
    instead: "Render calls block, but a named job is queryable across processes with motion.job.get / motion.job.list."
  },
  {
    capability: "persistent CLI render receipts",
    evidence: "packages/cli/src/render-receipt-file.ts",
    present: ["every `render` invocation leaves a verifiable receipt file beside the artifact", "writeRenderReceiptFile"],
    forbidden: [
      /render[^.]{0,100}writes no receipt file/i,
      /render[^.]{0,100}rather than writing a file/i,
      /render[^.]{0,100}only (?:its media file|transient stdout)/i,
      /render[^.]{0,120}write it to disk when a receipts root is known/i
    ],
    instead: "CLI render returns the receipt inline and persists it beside the delivered file, or inside an image-sequence output directory."
  }
];

/** Every `.md` under `dir`, recursively. */
function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/**
 * Split markdown into paragraphs with their starting line number, whitespace collapsed.
 *
 * Matching line by line would be useless here: this corpus is hard-wrapped at ~80 columns, so the
 * retired sentence "there is no live job-query command yet" was split across two source lines and a
 * per-line regex slid straight past it. A claim is a sentence, and a sentence is a paragraph-level
 * unit in wrapped prose.
 *
 * @param {string} source markdown file contents
 * @returns {{line: number, text: string}[]} non-blockquote paragraphs
 */
function paragraphs(source) {
  const blocks = [];
  let current = null;
  source.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      current = null;
      return;
    }
    // A quoted line documents what was once said; the file may explain its own corrections.
    if (/^\s*>/.test(line)) {
      current = null;
      return;
    }
    if (current) current.text += ` ${line.trim()}`;
    else {
      current = { line: index + 1, text: line.trim() };
      blocks.push(current);
    }
  });
  return blocks;
}

/** The matched sentence with a little context, so the failure names the actual prose. */
function excerpt(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return text.slice(0, 160);
  const start = Math.max(0, match.index - 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, match.index + match[0].length + 60)}…`;
}

const failures = [];
let checkedRules = 0;
let checkedFiles = 0;

for (const rule of RULES) {
  const evidencePath = join(ROOT, rule.evidence);
  if (!existsSync(evidencePath) || !statSync(evidencePath).isFile()) continue;
  const evidence = readFileSync(evidencePath, "utf8");
  // The capability has to be proved, not assumed: a rule for a feature that no longer ships would
  // otherwise forbid the sentence that correctly reports its absence.
  if (!rule.present.every((needle) => evidence.includes(needle))) continue;
  checkedRules += 1;

  const inspected = [...DOC_ROOTS.flatMap(markdownFiles), ...DOC_FILES.filter((file) => existsSync(file))];
  checkedFiles = inspected.length;
  for (const file of inspected) {
    for (const block of paragraphs(readFileSync(file, "utf8"))) {
      for (const pattern of rule.forbidden) {
        if (!pattern.test(block.text)) continue;
        failures.push(
          `${relative(ROOT, file)}:${block.line} denies a shipped capability (${rule.capability})\n`
          + `    claim: ${excerpt(block.text, pattern)}\n`
          + `    truth: ${rule.instead}`
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Published documentation contradicts shipped behaviour (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("");
  console.error("These files are exported to integrators and read by agents as fact. Update the");
  console.error("prose to match the code, or — if the capability really was removed — remove the rule");
  console.error("from scripts/docs-retired-claims-gate.mjs in the same change.");
  process.exit(1);
}

console.log(`docs-retired-claims: OK — ${checkedRules} shipped capability rule(s) checked across ${checkedFiles} file(s) in docs/public, skill/ and README.md.`);
