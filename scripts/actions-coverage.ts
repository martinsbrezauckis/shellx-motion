/**
 * scripts/actions-coverage.ts — assert every visible Motion surface has action/debug-API coverage.
 *
 * ROLE
 * ----
 * The implementation behind `pnpm run debug:coverage`, a REQUIRED release gate: it compares the
 * action catalog's coverage of `fixtures/debug/coverage.expected.json` and fails on an uncovered
 * surface, a missing command, or a command the fixture does not expect.
 *
 * WHY IT LIVES IN `scripts/` AND NOT IN THE PACKAGE
 * ------------------------------------------------
 * It used to be `packages/actions/src/coverage.ts`, which meant the build emitted it into the
 * published `@shellx-motion/actions` tarball, and `scripts/shipping-reachability-gate.mjs` had to
 * treat package.json script targets as entry points to keep it green — an exemption that weakened
 * that gate for every package. A dev gate is not part of the library;
 * moving it here removes both the packed artifact and the exemption.
 *
 * DEPENDENCIES: the actions catalog, imported by relative path as every script here does, and
 * `fixtures/debug/coverage.expected.json`.
 *
 * USAGE
 *   pnpm run debug:coverage
 *   pnpm --filter @shellx-motion/actions run coverage
 *   tsx scripts/actions-coverage.ts
 *
 * Exit code: 0 when coverage matches the fixture, 1 otherwise (the diff is printed as JSON).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionCoverage } from "../packages/actions/src/catalog";

interface CoverageFixture {
  visibleSurfaces: string[];
  requiredCommands: string[];
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(moduleDir, "../fixtures/debug/coverage.expected.json");
const fixture = readCoverageFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
const coverage = actionCoverage(fixture.visibleSurfaces);
const missingCommands = fixture.requiredCommands.filter((command) => !coverage.commands.includes(command));
const unexpectedCommands = coverage.commands.filter((command) => !fixture.requiredCommands.includes(command));
const result = {
  ok: coverage.ok && missingCommands.length === 0 && unexpectedCommands.length === 0,
  uncovered: coverage.uncovered,
  missingCommands,
  unexpectedCommands
};

console.log(JSON.stringify(result));
if (!result.ok) {
  process.exitCode = 1;
}

function readCoverageFixture(value: unknown): CoverageFixture {
  const record = readRecord(value);
  const visibleSurfaces = Array.isArray(record?.visibleSurfaces) ? record.visibleSurfaces.map(String) : [];
  const requiredCommands = Array.isArray(record?.requiredCommands) ? record.requiredCommands.map(String) : [];
  return { visibleSurfaces, requiredCommands };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
