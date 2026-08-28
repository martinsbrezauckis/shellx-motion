/**
 * scripts/actions-coverage.ts — report and assert fixture-defined Motion surface command parity.
 *
 * ROLE
 * ----
 * The implementation behind `pnpm run debug:coverage`, a REQUIRED release gate. Its deliberately
 * narrow scope is the named Workbench surfaces in `fixtures/debug/coverage.expected.json`: it
 * checks that each has a command map and that the map exactly matches the fixture's command list.
 * The report distinguishes that mapped subset from the whole Debug registry; it does not execute
 * handlers, prove action discovery, validate receipts, or measure unit/line coverage.
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

export interface CoverageFixture {
  visibleSurfaces: string[];
  requiredCommands: string[];
}

export interface ActionCoverageReport {
  ok: boolean;
  scope: {
    id: "fixture-defined-visible-surface-command-parity";
    visibleSurfaceCount: number;
    visibleSurfaces: string[];
    doesNotMeasure: string[];
  };
  commandScope: {
    mappedRegisteredCommands: number;
    totalRegisteredCommands: number;
    registeredCommandsOutsideScope: number;
  };
  fixtureParity: {
    matchedRequiredCommands: number;
    requiredCommands: number;
    mappedCommands: number;
  };
  uncovered: string[];
  missingCommands: string[];
  unexpectedCommands: string[];
  unregisteredCommands: string[];
  invalidFixture: {
    emptyVisibleSurfaces: boolean;
    emptyRequiredCommands: boolean;
    duplicateVisibleSurfaces: string[];
    duplicateRequiredCommands: string[];
  };
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(moduleDir, "../fixtures/debug/coverage.expected.json");
const debugSchemaPath = resolve(moduleDir, "../schemas/debug.json");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = readCoverageFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
  const registeredCommands = readDebugCommands(JSON.parse(readFileSync(debugSchemaPath, "utf8")));
  const result = actionCoverageReport(fixture, registeredCommands);
  console.log(JSON.stringify(result));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

export function actionCoverageReport(fixture: CoverageFixture, registeredCommands: string[]): ActionCoverageReport {
  const coverage = actionCoverage(fixture.visibleSurfaces);
  const visibleSurfaces = unique(fixture.visibleSurfaces);
  const requiredCommands = unique(fixture.requiredCommands);
  const mappedCommands = unique(coverage.commands);
  const registered = new Set(registeredCommands);
  const missingCommands = requiredCommands.filter((command) => !mappedCommands.includes(command));
  const unexpectedCommands = mappedCommands.filter((command) => !requiredCommands.includes(command));
  const unregisteredCommands = unique([...requiredCommands, ...mappedCommands]).filter((command) => !registered.has(command));
  const duplicateVisibleSurfaces = duplicates(fixture.visibleSurfaces);
  const duplicateRequiredCommands = duplicates(fixture.requiredCommands);
  const emptyVisibleSurfaces = visibleSurfaces.length === 0;
  const emptyRequiredCommands = requiredCommands.length === 0;
  const mappedRegisteredCommands = mappedCommands.filter((command) => registered.has(command)).length;

  return {
    ok: coverage.ok
      && missingCommands.length === 0
      && unexpectedCommands.length === 0
      && unregisteredCommands.length === 0
      && !emptyVisibleSurfaces
      && !emptyRequiredCommands
      && duplicateVisibleSurfaces.length === 0
      && duplicateRequiredCommands.length === 0,
    scope: {
      id: "fixture-defined-visible-surface-command-parity",
      visibleSurfaceCount: visibleSurfaces.length,
      visibleSurfaces,
      doesNotMeasure: [
        "commands outside the named surface map",
        "handler execution",
        "action-discovery completeness",
        "receipt behavior",
        "unit or line coverage"
      ]
    },
    commandScope: {
      mappedRegisteredCommands,
      totalRegisteredCommands: registered.size,
      registeredCommandsOutsideScope: registered.size - mappedRegisteredCommands
    },
    fixtureParity: {
      matchedRequiredCommands: requiredCommands.length - missingCommands.length,
      requiredCommands: requiredCommands.length,
      mappedCommands: mappedCommands.length
    },
    uncovered: coverage.uncovered,
    missingCommands,
    unexpectedCommands,
    unregisteredCommands,
    invalidFixture: { emptyVisibleSurfaces, emptyRequiredCommands, duplicateVisibleSurfaces, duplicateRequiredCommands }
  };
}

function readCoverageFixture(value: unknown): CoverageFixture {
  const record = readRecord(value);
  if (!Array.isArray(record?.visibleSurfaces) || !record.visibleSurfaces.every((surface) => typeof surface === "string")) {
    throw new Error("fixtures/debug/coverage.expected.json visibleSurfaces must be a string array.");
  }
  if (!Array.isArray(record.requiredCommands) || !record.requiredCommands.every((command) => typeof command === "string")) {
    throw new Error("fixtures/debug/coverage.expected.json requiredCommands must be a string array.");
  }
  const visibleSurfaces = record.visibleSurfaces;
  const requiredCommands = record.requiredCommands;
  return { visibleSurfaces, requiredCommands };
}

function readDebugCommands(value: unknown): string[] {
  const record = readRecord(value);
  if (!Array.isArray(record?.commands) || !record.commands.every((command) => typeof command === "string")) {
    throw new Error("schemas/debug.json commands must be a string array.");
  }
  return record.commands;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
