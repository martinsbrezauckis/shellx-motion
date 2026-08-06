/**
 * Coverage for the job status contract's STANDING RULINGS vocabulary.
 *
 * Why this exists separately from packages/core/src/job-status.test.ts, which covers the states:
 * a ruling's `status` is a published contract value that no code branches on at runtime, so
 * nothing in the engine notices when it is wrong. Exactly one consumer reads it —
 * `scripts/generate-job-status.mjs`, which renders `*(provisional)*` in docs/public/JOB_STATUS.md by
 * string equality — and a mismatch there does not fail, it publishes a decision nobody confirmed
 * as though it were settled.
 *
 * The vocabulary once embedded a specific maintainer's name in a published contract. These tests
 * pin the replacement to role-based values and pin the docs to what the schema marks provisional,
 * so a rename cannot half-land and a personal name cannot return by accident.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface JobStatusContract {
  rulingStatuses: Array<{ status: string; meaning: string }>;
  rulings: Array<{ question: string; ruling: string; because: string; status: string }>;
}

const contract = JSON.parse(
  readFileSync(resolve(repoRoot, "schemas/job-status.json"), "utf8")
) as JobStatusContract;
const jobStatusDoc = readFileSync(resolve(repoRoot, "docs/public/JOB_STATUS.md"), "utf8");

/**
 * The whole vocabulary, written out rather than derived from the schema.
 *
 * Deriving it would make this test agree with whatever the schema says, which is the one thing it
 * must not do: adding a status has to be a deliberate edit in two places, and that second edit is
 * where an author is asked whether the value they just wrote names a role or a person.
 */
const EXPECTED_RULING_STATUSES = ["provisional-pending-maintainer", "settled"];

describe("standing ruling statuses", () => {
  it("declares exactly the role-based vocabulary", () => {
    expect(contract.rulingStatuses.map((entry) => entry.status)).toEqual(EXPECTED_RULING_STATUSES);
  });

  it("names no person in any published ruling value", () => {
    // The check is structural, not a name blocklist: a status is a lowercase, hyphenated term
    // built from contract words, and every published one must be a member of the closed set. A
    // value like `provisional-pending-<firstname>` fails on membership, whoever the name belongs to.
    const declared = new Set(contract.rulingStatuses.map((entry) => entry.status));
    for (const status of declared) expect(status).toMatch(/^[a-z][a-z-]*[a-z]$/);
    const undeclared = contract.rulings.filter((ruling) => !declared.has(ruling.status));
    expect(undeclared.map((ruling) => `${ruling.question} -> ${ruling.status}`)).toEqual([]);
  });

  it("gives every status a meaning a reader can act on", () => {
    // Same bar the states are held to: a vocabulary entry with no meaning is a word, not a contract.
    for (const entry of contract.rulingStatuses) expect(entry.meaning.length).toBeGreaterThan(20);
  });

  it("marks in the generated docs exactly the rulings the schema calls provisional", () => {
    // The drift this catches: the generator compares the schema value against a constant of its
    // own. If those two ever disagree, generation still succeeds and every ruling silently loses
    // its *(provisional)* marker — the docs then read as four settled decisions. Asserting both
    // directions means a marker cannot go missing OR appear on a settled ruling.
    for (const ruling of contract.rulings) {
      const line = jobStatusDoc
        .split("\n")
        .find((candidate) => candidate.startsWith(`- **${ruling.question}**`));
      expect(line, `docs/public/JOB_STATUS.md has no line for ruling: ${ruling.question}`).toBeDefined();
      expect(line?.includes("*(provisional)*")).toBe(ruling.status === "provisional-pending-maintainer");
    }
  });
});
