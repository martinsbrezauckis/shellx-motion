/**
 * Fail the build when a new, independent job-state vocabulary appears.
 *
 * Role: Motion accumulated seven different vocabularies for "what is happening with this job",
 * with three different words for success. An agent handed one of them cannot reliably tell
 * "your render finished" from "your render never started". The contract in
 * schemas/job-status.json fixes that; this lint is what stops number eight.
 *
 * Checks:
 *   1. No locally authored job-state union. A string-literal union assigned to an identifier
 *      matching /(Job|Task)(State|Status)$/ must be a re-export of the generated contract.
 *   2. Reserved-word disjointness. A word the contract forbids in a job state must not appear
 *      as a member of one, and vice versa for receipt statuses.
 *   3. Contract coverage. Every generated state must be documented in docs/public/JOB_STATUS.md with
 *      all of its facets, so a state cannot be added without its prose.
 *
 * Run from `pnpm test` via `pnpm source-hygiene:check`. Known pre-contract vocabularies are
 * listed in ALLOWED_LEGACY below with the migration step that retires each one; that list may
 * shrink but must never grow.
 */
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(repoRoot, "packages");
const scriptsRoot = resolve(repoRoot, "scripts");
const contract = JSON.parse(await readFile(resolve(repoRoot, "schemas/job-status.json"), "utf8"));
const docsPath = resolve(repoRoot, "docs/public/JOB_STATUS.md");

/**
 * Vocabularies that predate the contract, each with the migration step that removes it.
 *
 * This list is a ratchet: entries may be deleted as they migrate, never added. A genuinely new
 * vocabulary must fail rather than be appended here.
 */
const ALLOWED_LEGACY = new Map([
  ["packages/core/src/job-governor.ts", "migration step 3 — governor states split into outcome + error code"]
]);

const UNION_DECLARATION = /(?:export\s+)?type\s+(\w*(?:Job|Task)(?:State|Status))\s*=\s*([^;]+);/g;
// A vocabulary can also be authored inline as a property of a job-shaped type, which is how the
// governor carries its states. Matching only type aliases would let that whole class through.
// The enclosing declaration's NAME decides whether a `state`/`status` property is in scope —
// proximity is not enough, since unrelated types (a review status, say) sit near job types.
const JOB_SHAPED_DECLARATION = /(?:export\s+)?(?:interface|type)\s+(\w*(?:Job|Task)\w*)\s*(?:=\s*)?\{/g;
const PROPERTY_UNION = /^\s+(state|status)\??\s*:\s*((?:"[^"]+"\s*\|\s*)+"[^"]+")\s*;/gm;
const GENERATED_IMPORT = /from\s+["'][^"']*generated\/job-status["']/;

/**
 * Job-lifecycle words that are not, and have never been, contract members.
 *
 * Check 1 finds a newly AUTHORED vocabulary. It cannot find code that merely COMPARES against a
 * word from a retired one, because no type is declared there. That gap shipped: a required smoke
 * asserted a retried job reaches `queued` while the engine correctly reports `pending`, and it read
 * as an engine failure. None of these words is a valid job
 * state OR a valid receipt status, so a comparison against one is always wrong, whatever the
 * surrounding context.
 */
const RETIRED_STATE_WORDS = new Set(["queued", "enqueued", "in_progress", "inprogress", "waiting", "processing", "started"]);

/**
 * `retryState === "queued"`, `job.status !== 'waiting'`, `state: "processing"` — a comparison or
 * assignment against any state-shaped identifier.
 *
 * The identifier is matched by SUFFIX, not by exact name. The defect this exists to catch was
 * written `retryState === "queued"`, which an exact `state|status` match walks straight past — the
 * first version of this rule did exactly that and reported a clean build.
 */
const STATE_LITERAL = /\b\w*(?:[Ss]tate|[Ss]tatus)\s*(?:===|!==|==|!=|:)\s*["']([a-zA-Z_]+)["']/g;

const failures = [];

await lintSourceUnions();
await lintRetiredStateLiterals();
await lintDocumentationCoverage();

if (failures.length > 0) {
  process.stderr.write(`FAIL job-status-lint: ${failures.length} problem(s).\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write("PASS job-status-lint: one job status vocabulary, fully documented.\n");

async function lintSourceUnions() {
  const reservedInJobState = new Set(contract.reservedWords?.neverInJobStatus ?? []);
  const canonical = new Set([
    ...contract.lifecycle.map((entry) => entry.name),
    ...contract.outcomes.map((entry) => entry.name)
  ]);

  for await (const file of walk(packagesRoot)) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const relativePath = repoRelative(file);
    if (relativePath.includes("/dist/") || relativePath.includes("/node_modules/")) continue;
    if (relativePath.endsWith("generated/job-status.ts")) continue;
    const source = await readFile(file, "utf8");
    // Deliberately broad: a file can author a vocabulary as a property of a job-shaped type
    // without ever containing the identifier "JobState", which is how the governor did it.
    if (!/(Job|Task)/.test(source)) continue;

    for (const match of source.matchAll(UNION_DECLARATION)) {
      const [, name, body] = match;
      // A union of string literals is an authored vocabulary; anything else is a reference.
      const members = [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
      if (members.length === 0) continue;
      if (GENERATED_IMPORT.test(source) && members.every((member) => canonical.has(member))) continue;
      const legacy = ALLOWED_LEGACY.get(relativePath);
      if (legacy) continue;
      failures.push(
        `${relativePath}: type ${name} authors its own job vocabulary (${members.join(" | ")}). ` +
        "Import the union from @shellx-motion/core generated/job-status instead."
      );
    }

    for (const declaration of source.matchAll(JOB_SHAPED_DECLARATION)) {
      const [, typeName] = declaration;
      const body = braceBody(source, declaration.index + declaration[0].length - 1);
      for (const match of body.matchAll(PROPERTY_UNION)) {
        const [, property, union] = match;
        const members = [...union.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
        if (members.every((member) => canonical.has(member))) continue;
        if (ALLOWED_LEGACY.has(relativePath)) continue;
        failures.push(
          `${relativePath}: ${typeName}.${property} authors its own job vocabulary ` +
          `(${members.join(" | ")}). Import the union from @shellx-motion/core generated/job-status instead.`
        );
      }
    }

    // A reserved word used as a job-state member is how the vocabularies drifted apart before.
    for (const match of source.matchAll(UNION_DECLARATION)) {
      const [, name, body] = match;
      if (ALLOWED_LEGACY.has(relativePath)) continue;
      const members = [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
      for (const member of members) {
        if (reservedInJobState.has(member)) {
          failures.push(
            `${relativePath}: type ${name} uses reserved word "${member}" as a job state. ` +
            `The contract forbids it because it collides with receipt status vocabulary.`
          );
        }
      }
    }
  }
}

/**
 * Every state must be documented with all of its facets.
 *
 * This is what turns "document the semantics, not just the names" into a shipping requirement:
 * a state added to the schema without its prose fails here.
 */
async function lintDocumentationCoverage() {
  const docs = await readFile(docsPath, "utf8");
  for (const entry of [...contract.lifecycle, ...contract.outcomes]) {
    const heading = contract.lifecycle.includes(entry)
      ? `### lifecycle: \`${entry.name}\``
      : `### ended + outcome: \`${entry.name}\``;
    const start = docs.indexOf(heading);
    if (start < 0) {
      failures.push(`docs/public/JOB_STATUS.md is missing a section for ${entry.name}. Run pnpm docs:job-status.`);
      continue;
    }
    const next = docs.indexOf("\n### ", start + 1);
    const section = docs.slice(start, next < 0 ? undefined : next);
    for (const facet of ["**Terminal:**", "**You should:**", "**Always carries:**", "**Never carries:**"]) {
      if (!section.includes(facet)) {
        failures.push(`docs/public/JOB_STATUS.md section for ${entry.name} is missing ${facet}.`);
      }
    }
  }
  for (const entry of contract.errorCodes) {
    if (!docs.includes(`\`${entry.code}\``)) {
      failures.push(`docs/public/JOB_STATUS.md does not document error code ${entry.code}.`);
    }
  }
  for (const entry of contract.queryErrors) {
    if (!docs.includes(`\`${entry.code}\``)) {
      failures.push(`docs/public/JOB_STATUS.md does not document query error ${entry.code}.`);
    }
  }
}

/**
 * Fail when code compares a state against a word the contract retired.
 *
 * Deliberately scans `scripts/` as well as `packages/`. Check 1 walks `packages/` only, which is
 * precisely why `queued` survived in a smoke script: the gate could not see the directory the
 * defect lived in. A gate that does not cover the code it claims to govern reports health it never
 * measured.
 *
 * Narrow on purpose, in two ways. Only a comparison or assignment against a state-shaped key, and
 * only against words that are invalid in BOTH the job and receipt vocabularies — `receipt.status ===
 * "passed"` is legitimate and must keep passing, which is why `passed` is not in this set. And only
 * in files that actually mention Job or Task, the same scoping check 1 uses.
 *
 * That second limit is load-bearing rather than a convenience. Motion has a legitimate, separate
 * `TrackingLifecycleState` ("queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled"
 * | "stale") for tracking analysis, which is a different domain with its own honest vocabulary.
 * Flagging it would be this lint inventing a violation, and a gate that cries wolf gets switched off.
 */
async function lintRetiredStateLiterals() {
  for (const root of [packagesRoot, scriptsRoot]) {
    for await (const file of walk(root)) {
      if (!/\.(ts|mjs|js)$/.test(file) || file.endsWith(".d.ts")) continue;
      const relativePath = repoRelative(file);
      if (relativePath.includes("/dist/") || relativePath.includes("/node_modules/")) continue;
      // This lint names the retired words in its own source; scanning itself would always fail.
      if (relativePath === "scripts/job-status-lint.mjs") continue;
      const source = await readFile(file, "utf8");
      if (!/(Job|Task)/.test(source)) continue;
      for (const [, word] of source.matchAll(STATE_LITERAL)) {
        if (!RETIRED_STATE_WORDS.has(word)) continue;
        failures.push(
          `${relativePath} compares a state against "${word}", which is not a job state or a receipt status. `
          + `Job lifecycle is ${contract.lifecycle.map((entry) => entry.name).join(", ")}; `
          + `outcomes are ${contract.outcomes.map((entry) => entry.name).join(", ")}.`
        );
      }
    }
  }
}

/**
 * Repo-relative path with forward slashes, on every platform.
 *
 * `relative()` returns backslashes on Windows, and BOTH scanners here compare the result against
 * forward-slash literals -- the ALLOWED_LEGACY keys, the `generated/job-status.ts` exemption, the
 * dist/node_modules skips, and this lint's own self-exclusion. Every one of those silently missed on
 * Windows, so the gate flagged the generated contract, the allow-listed governor, and its own source,
 * and `pnpm test` could not pass there at all. Found on a Windows rig ; it had never been
 * run on one before.
 */
function repoRelative(file) {
  return relative(repoRoot, file).replaceAll("\\", "/");
}

/** Text between the brace at `open` and its match, so nested types do not leak into a scan. */
function braceBody(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

async function* walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}
