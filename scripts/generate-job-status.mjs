/**
 * Generate the job status contract's TypeScript and documentation from schemas/job-status.json.
 *
 * Role: there is exactly one authored definition of how Motion reports job state, and everything
 * else is derived from it. Before this existed there were seven independently authored job
 * vocabularies and three different words for success, which is how an agent ends up unable to
 * tell "your render finished" from "your render never started".
 *
 * Emits:
 *   packages/core/src/generated/job-status.ts   whole file  — unions, frozen contract, helpers
 *   docs/public/JOB_STATUS.md                   whole file  — the agent-facing state reference
 *
 * Run `pnpm docs:job-status` to write, `pnpm docs:check` to fail on drift. Modelled on
 * scripts/generate-debug-api-reference.mjs, which uses the same read/build/--check shape.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(repoRoot, "schemas/job-status.json");
const typesPath = resolve(repoRoot, "packages/core/src/generated/job-status.ts");
const docsPath = resolve(repoRoot, "docs/public/JOB_STATUS.md");
const checkOnly = process.argv.includes("--check");

/**
 * The one ruling status that makes a ruling render as *(provisional)* in the docs.
 *
 * Named rather than inlined because it is a cross-file string equality: the value is authored in
 * schemas/job-status.json and compared here, so a rename on one side and not the other does not
 * fail — it silently stops marking rulings as provisional and publishes settled-looking prose for
 * decisions nobody confirmed. `validate()` therefore asserts this constant is a member of the
 * schema's own `rulingStatuses` vocabulary, which turns that silent drift into a build failure.
 *
 * The value names a review role rather than a person. The schema's closed vocabulary keeps an
 * author-specific status from returning and makes a partial rename fail generation.
 */
const PROVISIONAL_RULING_STATUS = "provisional-pending-maintainer";

const contract = JSON.parse(await readFile(schemaPath, "utf8"));

validate(contract);

const lifecycleNames = contract.lifecycle.map((entry) => entry.name);
const outcomeNames = contract.outcomes.map((entry) => entry.name);
// The observable projection: the two non-terminal lifecycles, then every way a job can end.
const stateNames = [...lifecycleNames.filter((name) => name !== "ended"), ...outcomeNames];

await write(typesPath, buildTypes());
await write(docsPath, buildDocs());

/**
 * Reject a contract that could not be safely generated from.
 *
 * These checks are the reason a state cannot be added without its documentation: a new entry
 * missing any agent-facing facet fails the build rather than shipping an undocumented state.
 */
function validate(input) {
  if (input.schema !== "shellx-motion/job-status-contract@1") {
    throw new Error(`schemas/job-status.json declares unexpected schema ${input.schema}.`);
  }
  for (const key of ["lifecycle", "outcomes", "queryErrors", "errorCodes", "remedyKinds", "skipCodes", "rulingStatuses"]) {
    if (!Array.isArray(input[key]) || input[key].length === 0) {
      throw new Error(`schemas/job-status.json ${key} must be a non-empty array.`);
    }
  }
  // Ruling status is a closed vocabulary, checked the same way remedy kinds are below. Two failure
  // modes, both silent without this: an undeclared status renders as settled prose for a decision
  // that is not settled, and a renamed PROVISIONAL_RULING_STATUS stops matching anything at all.
  const rulingStatuses = new Set(input.rulingStatuses.map((entry) => entry.status));
  if (!rulingStatuses.has(PROVISIONAL_RULING_STATUS)) {
    throw new Error(
      `The generator's provisional marker "${PROVISIONAL_RULING_STATUS}" is not in schemas/job-status.json rulingStatuses ` +
      `(${[...rulingStatuses].join(", ")}). Renaming the status in the schema alone would silently stop marking rulings provisional.`
    );
  }
  for (const ruling of input.rulings ?? []) {
    if (!rulingStatuses.has(ruling.status)) {
      throw new Error(`Ruling "${ruling.question}" declares unknown status ${ruling.status}.`);
    }
  }
  if (!input.lifecycle.some((entry) => entry.terminal)) {
    throw new Error("schemas/job-status.json must declare at least one terminal lifecycle.");
  }
  const documented = [...input.lifecycle, ...input.outcomes];
  for (const entry of documented) {
    // Every facet an agent needs in order to act. Absence here is a build failure, by design.
    for (const facet of ["meaning", "agentAction", "agentGuidance"]) {
      if (typeof entry[facet] !== "string" || entry[facet].trim().length === 0) {
        throw new Error(`Job status entry ${entry.name} is missing ${facet}.`);
      }
    }
    for (const facet of ["guaranteed", "absent", "notToBeConfusedWith"]) {
      if (!Array.isArray(entry[facet])) {
        throw new Error(`Job status entry ${entry.name} is missing ${facet}.`);
      }
    }
    for (const neighbour of entry.notToBeConfusedWith) {
      if (typeof neighbour.state !== "string" || typeof neighbour.because !== "string") {
        throw new Error(`Job status entry ${entry.name} has a malformed notToBeConfusedWith entry.`);
      }
    }
  }
  const remedyKinds = new Set(input.remedyKinds.map((entry) => entry.kind));
  for (const entry of input.errorCodes) {
    if (typeof entry.retryable !== "boolean") {
      throw new Error(`Job error code ${entry.code} must declare retryable.`);
    }
    if (!remedyKinds.has(entry.remedy)) {
      throw new Error(`Job error code ${entry.code} references unknown remedy kind ${entry.remedy}.`);
    }
  }
  // Lifecycle and outcome share the `state` projection, so a name in both would make the
  // projection ambiguous.
  const overlap = input.lifecycle
    .map((entry) => entry.name)
    .filter((name) => input.outcomes.some((outcome) => outcome.name === name));
  if (overlap.length > 0) {
    throw new Error(`Lifecycle and outcome names overlap: ${overlap.join(", ")}.`);
  }
  const reserved = new Set(input.reservedWords?.neverInJobStatus ?? []);
  for (const name of [...input.lifecycle, ...input.outcomes].map((entry) => entry.name)) {
    if (reserved.has(name)) {
      throw new Error(`Job state ${name} is a reserved word that must never appear in a job status.`);
    }
  }
}

function union(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function buildTypes() {
  const terminalLifecycles = contract.lifecycle.filter((entry) => entry.terminal).map((entry) => entry.name);
  const retryable = contract.errorCodes.filter((entry) => entry.retryable).map((entry) => entry.code);
  const stageNames = [...new Set(Object.values(contract.stages ?? {}).flat())];
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Source: schemas/job-status.json
 * Regenerate: pnpm docs:job-status   ·   Verify: pnpm docs:check
 *
 * ${contract.summary}
 */

/** ${contract.axes.lifecycle} */
export type JobLifecycle = ${union(lifecycleNames)};

/** ${contract.axes.outcome} */
export type JobOutcome = ${union(outcomeNames)};

/** ${contract.axes.state} */
export type JobState = ${union(stateNames)};

/** Typed failures of a status *query*, which are never job states. */
export type JobQueryErrorCode = ${union(contract.queryErrors.map((entry) => entry.code))};

/** Why a job failed. Retryability is a property of the code, declared once, not per throw site. */
export type JobErrorCode = ${union(contract.errorCodes.map((entry) => entry.code))};

/** What a caller should do about a non-retryable failure. */
export type JobRemedyKind = ${union(contract.remedyKinds.map((entry) => entry.kind))};

/** Why a unit of work was deliberately not attempted. */
export type JobSkipCode = ${union(contract.skipCodes.map((entry) => entry.code))};

/** Coarse phase within a running job, for progress reporting only. Never a state. */
export type JobStage = ${union(stageNames)};

export const JOB_LIFECYCLES: readonly JobLifecycle[] = Object.freeze([${lifecycleNames.map((n) => JSON.stringify(n)).join(", ")}]);
export const JOB_OUTCOMES: readonly JobOutcome[] = Object.freeze([${outcomeNames.map((n) => JSON.stringify(n)).join(", ")}]);
export const JOB_STATES: readonly JobState[] = Object.freeze([${stateNames.map((n) => JSON.stringify(n)).join(", ")}]);

/** The states a job still in flight can occupy. Anything else has already ended. */
export const NON_TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze([${lifecycleNames.filter((n) => !contract.lifecycle.find((e) => e.name === n).terminal).map((n) => JSON.stringify(n)).join(", ")}]);

const TERMINAL_LIFECYCLES: ReadonlySet<string> = new Set([${terminalLifecycles.map((n) => JSON.stringify(n)).join(", ")}]);
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([${retryable.map((n) => JSON.stringify(n)).join(", ")}]);
const REMEDY_BY_ERROR_CODE: Readonly<Record<JobErrorCode, JobRemedyKind>> = Object.freeze({
${contract.errorCodes.map((entry) => `  ${JSON.stringify(entry.code)}: ${JSON.stringify(entry.remedy)}`).join(",\n")}
});
const OUTCOME_BY_RECEIPT_STATUS: Readonly<Record<string, JobOutcome>> = Object.freeze({
${(contract.receiptMapping ?? []).map((entry) => `  ${JSON.stringify(entry.receiptStatus)}: ${JSON.stringify(entry.contributesTo)}`).join(",\n")}
});

/** True while the job can still change on its own; false once it has ended. */
export function isJobInFlight(state: string): state is JobState {
  return (NON_TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

/** True when the job will not change again on its own. */
export function isTerminalLifecycle(lifecycle: JobLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}

/**
 * Project the two authored axes onto the single token most callers read.
 *
 * Throws when an ended job carries no outcome, because that combination has no truthful
 * projection and silently reporting "ended" would hide which of four things happened.
 */
export function projectJobState(lifecycle: JobLifecycle, outcome: JobOutcome | null): JobState {
  if (!isTerminalLifecycle(lifecycle)) return lifecycle as JobState;
  if (outcome === null) throw new Error("An ended job must carry an outcome.");
  return outcome;
}

/** Whether retrying an identical request could succeed. Decided by the code, not the call site. */
export function isRetryableJobError(code: JobErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/** What a caller should do about this failure. */
export function remedyForJobError(code: JobErrorCode): JobRemedyKind {
  return REMEDY_BY_ERROR_CODE[code];
}

/**
 * Map a receipt's status onto the job outcome it contributes to.
 *
 * Receipt status and job outcome are deliberately different axes: a receipt describes one
 * operation's evidence, a job describes the caller's request. Returns undefined for a status
 * this contract does not map, rather than guessing.
 */
export function jobOutcomeForReceiptStatus(receiptStatus: string): JobOutcome | undefined {
  return OUTCOME_BY_RECEIPT_STATUS[receiptStatus];
}

/** Words that must never appear as a job state, guarding against a re-divergence. */
export const RESERVED_NON_JOB_STATE_WORDS: readonly string[] = Object.freeze([${(contract.reservedWords?.neverInJobStatus ?? []).map((n) => JSON.stringify(n)).join(", ")}]);

/** Words that must never appear as a receipt status. */
export const RESERVED_NON_RECEIPT_STATUS_WORDS: readonly string[] = Object.freeze([${(contract.reservedWords?.neverInReceiptStatus ?? []).map((n) => JSON.stringify(n)).join(", ")}]);

/** The whole authored contract, frozen, for runtime checks and documentation surfaces. */
export const JOB_STATUS_CONTRACT = Object.freeze(${JSON.stringify(contract, null, 2).split("\n").join("\n")} as const);
`;
}

function facetList(values) {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(", ") : "—";
}

function buildDocs() {
  const lines = [];
  lines.push("<!-- GENERATED FILE — do not edit. Source: schemas/job-status.json. Regenerate: pnpm docs:job-status -->");
  lines.push("");
  lines.push("# Job status — what Motion tells you about work you asked for");
  lines.push("");
  lines.push(contract.summary);
  lines.push("");
  lines.push(`**Design principle.** ${contract.designPrinciple}`);
  lines.push("");
  lines.push("## The two axes and the one projection");
  lines.push("");
  lines.push(`- **\`lifecycle\`** — ${contract.axes.lifecycle}`);
  lines.push(`- **\`outcome\`** — ${contract.axes.outcome}`);
  lines.push(`- **\`state\`** — ${contract.axes.state}`);
  lines.push("");
  lines.push("An agent that only ever reads `state` is correct. An agent that wants a stable");
  lines.push("terminality test without enumerating outcomes reads `lifecycle`. They cannot disagree,");
  lines.push("because one is computed from the other.");
  lines.push("");
  lines.push("| `state` | terminal | what you should do |");
  lines.push("|---|---|---|");
  for (const entry of contract.lifecycle) {
    if (entry.terminal) continue;
    lines.push(`| \`${entry.name}\` | no | ${entry.agentAction.replace(/_/g, " ")} |`);
  }
  for (const entry of contract.outcomes) {
    lines.push(`| \`${entry.name}\` | yes | ${entry.agentAction.replace(/_/g, " ")} |`);
  }
  lines.push("");
  lines.push("## States in full");
  lines.push("");
  for (const entry of contract.lifecycle) {
    lines.push(...stateSection(`lifecycle: \`${entry.name}\``, entry, entry.terminal ? "yes" : "no"));
  }
  for (const entry of contract.outcomes) {
    lines.push(...stateSection(`ended + outcome: \`${entry.name}\``, entry, "yes"));
  }
  lines.push("## Query errors — asking about a job Motion cannot show you");
  lines.push("");
  lines.push("These are typed errors from the *query*, never job states. A job that does not exist");
  lines.push("has no state; saying it \"failed\" would be a lie about work that never ran.");
  lines.push("");
  lines.push("| code | means | what you should do |");
  lines.push("|---|---|---|");
  for (const entry of contract.queryErrors) {
    lines.push(`| \`${entry.code}\` | ${entry.meaning} | ${entry.agentGuidance} |`);
  }
  lines.push("");
  lines.push("## Failure codes");
  lines.push("");
  lines.push("`retryable` is what separates \"try again\" from \"change approach\". It is a property of");
  lines.push("the code, declared once here, never decided per throw site. Never parse `message` — it");
  lines.push("is for humans.");
  lines.push("");
  lines.push("| code | retryable | remedy | means |");
  lines.push("|---|---|---|---|");
  for (const entry of contract.errorCodes) {
    lines.push(`| \`${entry.code}\` | ${entry.retryable ? "yes" : "no"} | \`${entry.remedy}\` | ${entry.meaning} |`);
  }
  lines.push("");
  lines.push("### Remedies");
  lines.push("");
  lines.push("| kind | means |");
  lines.push("|---|---|");
  for (const entry of contract.remedyKinds) {
    lines.push(`| \`${entry.kind}\` | ${entry.meaning} |`);
  }
  lines.push("");
  lines.push("## Skip codes");
  lines.push("");
  lines.push("| code | means |");
  lines.push("|---|---|");
  for (const entry of contract.skipCodes) {
    lines.push(`| \`${entry.code}\` | ${entry.meaning} |`);
  }
  lines.push("");
  lines.push("## Progress stages");
  lines.push("");
  lines.push("A stage is progress detail, never a state: it answers \"how long\", not \"what should I do\".");
  lines.push("");
  lines.push("| lane | stages |");
  lines.push("|---|---|");
  for (const [lane, stages] of Object.entries(contract.stages ?? {})) {
    lines.push(`| \`${lane}\` | ${stages.map((stage) => `\`${stage}\``).join(" → ")} |`);
  }
  lines.push("");
  lines.push("## Job status is not receipt status");
  lines.push("");
  lines.push("A receipt attests one operation's evidence. A job describes the caller's request.");
  lines.push("They are kept as separate axes on purpose, and this is the only sanctioned mapping:");
  lines.push("");
  lines.push("| receipt `status` | contributes to outcome | why |");
  lines.push("|---|---|---|");
  for (const entry of contract.receiptMapping ?? []) {
    lines.push(`| \`${entry.receiptStatus}\` | \`${entry.contributesTo}\` | ${entry.because} |`);
  }
  lines.push("");
  lines.push("Words that must never appear as a job state: " + facetList(contract.reservedWords?.neverInJobStatus ?? []) + ".");
  lines.push("");
  lines.push("Words that must never appear as a receipt status: " + facetList(contract.reservedWords?.neverInReceiptStatus ?? []) + ".");
  lines.push("");
  if ((contract.rulings ?? []).length > 0) {
    lines.push("## Standing rulings");
    lines.push("");
    lines.push("Decisions this contract depends on. Any marked provisional were taken to keep the");
    lines.push("contract shippable and use the reversible option; they are awaiting confirmation.");
    lines.push("");
    for (const ruling of contract.rulings) {
      lines.push(`- **${ruling.question}** ${ruling.ruling}${ruling.status === PROVISIONAL_RULING_STATUS ? " *(provisional)*" : ""}`);
      lines.push(`  ${ruling.because}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function stateSection(heading, entry, terminal) {
  const lines = [];
  lines.push(`### ${heading}`);
  lines.push("");
  lines.push(entry.meaning);
  lines.push("");
  lines.push(`- **Terminal:** ${terminal}`);
  lines.push(`- **You should:** ${entry.agentGuidance}`);
  lines.push(`- **Always carries:** ${facetList(entry.guaranteed)}`);
  lines.push(`- **Never carries:** ${facetList(entry.absent)}`);
  for (const neighbour of entry.notToBeConfusedWith) {
    lines.push(`- **Not to be confused with ${neighbour.state}:** ${neighbour.because}`);
  }
  lines.push("");
  return lines;
}

/** Write, or in --check mode fail loudly on any drift from what is on disk. */
async function write(path, content) {
  const relative = path.slice(repoRoot.length + 1);
  if (checkOnly) {
    let current;
    try {
      current = await readFile(path, "utf8");
    } catch {
      throw new Error(`${relative} is missing. Run pnpm docs:job-status.`);
    }
    if (current !== content) {
      throw new Error(`${relative} is out of date with schemas/job-status.json. Run pnpm docs:job-status.`);
    }
    process.stdout.write(`PASS ${relative} matches schemas/job-status.json.\n`);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  process.stdout.write(`Wrote ${relative}.\n`);
}
