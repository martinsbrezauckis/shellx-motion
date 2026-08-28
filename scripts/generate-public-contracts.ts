import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compareCodeUnits } from "../packages/core/src/canonical-json";
import { ACTIONS, type MotionPermissionTier } from "../packages/actions/src/catalog";
import { AGENT_SNAPSHOT_SCHEMA_DOCUMENT, DEBUG_COMMANDS, DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/index";
import { MOTION_DEBUG_ARG_ENUMS } from "../packages/debug-api/src/command-metadata-enums";
import {
  integrationCapabilitiesForHost,
  MOTION_EXPORT_PRESETS,
  buildMotionPublicSchema,
  validateAgainstPublishedSchema,
  type JsonSchemaDocument
} from "../packages/core/src/index";
import {
  CANVAS_BRIDGE_PACKAGE_SCHEMA,
  convertCanvasFrameToMotionPackage
} from "../packages/adapters-canvas/src/index";

const PERMISSIONS: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];
const GENERATED_BY = "scripts/generate-public-contracts.ts";

/** Build the generated actions registry document from the live ACTIONS catalog. */
function buildActionsRegistry(): unknown {
  return {
    schema: "shellx-motion/actions@1",
    actionSchema: "shellx-motion/action@1",
    generatedBy: GENERATED_BY,
    actionCount: ACTIONS.length,
    permissions: PERMISSIONS,
    surfaces: sortedUnique(ACTIONS.flatMap((action) => action.surfaces)),
    actions: ACTIONS
  };
}

/**
 * Build the generated debug-contracts registry document from the live debug contracts.
 *
 * `argEnums` is the shared value dictionary that argument properties point at with `enumRef`.
 * It is published alongside the contracts so a caller can resolve every allowed value from
 * this one file, without inlining 113 keyframe targets into a dozen command schemas.
 */
function buildDebugRegistry(): unknown {
  return {
    schema: "shellx-motion/debug-contracts@1",
    debugSchema: "shellx-motion/debug@1",
    generatedBy: GENERATED_BY,
    commandCount: DEBUG_COMMAND_CONTRACTS.length,
    argumentContractCount: DEBUG_COMMAND_CONTRACTS.filter((contract) => contract.argsSchema).length,
    permissions: PERMISSIONS,
    commands: [...DEBUG_COMMANDS],
    argEnums: MOTION_DEBUG_ARG_ENUMS,
    contracts: DEBUG_COMMAND_CONTRACTS
  };
}

/** Regenerate the machine-generated public contract registries on disk. */
async function generate(): Promise<void> {
  const schemasRoot = resolve("schemas");
  await mkdir(schemasRoot, { recursive: true });
  await writeJson(resolve(schemasRoot, "actions.json"), buildActionsRegistry());
  await writeJson(resolve(schemasRoot, "debug.json"), buildDebugRegistry());
  await writeJson(resolve(schemasRoot, "agent-snapshot.schema.json"), AGENT_SNAPSHOT_SCHEMA_DOCUMENT);
  await writeJson(resolve(schemasRoot, "motion.schema.json"), buildMotionPublicSchema());
}

/**
 * Verify mode (CI): confirm the generated registries are up to date AND that the hand-authored
 * published schemas are consistent with their code-side authorities (the generated Motion document
 * contract, the Canvas parser,
 * the export-preset source, the integration protocol, and Canvas bridge package producer).
 * Returns the list of drift problems found.
 *
 * This is the standing drift gate for engine-review A4 and connector-review D3/D6: schema-vs-validator
 * divergence surfaces here (and in the sibling vitest drift tests) instead of shipping silently.
 */
async function check(): Promise<string[]> {
  const problems: string[] = [];
  const schemasRoot = resolve("schemas");

  // 1. Generated registries must match what the current code would emit.
  await expectGeneratedFileMatches(resolve(schemasRoot, "actions.json"), buildActionsRegistry(), problems);
  await expectGeneratedFileMatches(resolve(schemasRoot, "debug.json"), buildDebugRegistry(), problems);
  await expectGeneratedFileMatches(resolve(schemasRoot, "agent-snapshot.schema.json"), AGENT_SNAPSHOT_SCHEMA_DOCUMENT, problems);
  await expectGeneratedFileMatches(resolve(schemasRoot, "motion.schema.json"), buildMotionPublicSchema(), problems);

  // 1b. Every enumRef in a published argument schema must resolve in the published argEnums
  // dictionary, otherwise an agent reading the contract hits a dead reference.
  for (const contract of DEBUG_COMMAND_CONTRACTS) {
    for (const [name, property] of Object.entries(contract.argsSchema?.properties ?? {})) {
      if (property.enumRef && !Object.hasOwn(MOTION_DEBUG_ARG_ENUMS, property.enumRef)) {
        problems.push(`${contract.command} argument ${name} references unknown argEnum "${property.enumRef}".`);
      }
    }
  }

  // 2. canvas-frame-selection.schema.json must accept every shipped Canvas fixture (D3).
  const canvasSchema = await readSchema(resolve(schemasRoot, "canvas-frame-selection.schema.json"));
  const canvasFixturesDir = resolve("fixtures/canvas");
  const fixtureNames = (await readdir(canvasFixturesDir)).filter((name) => name.endsWith(".json"));
  if (fixtureNames.length === 0) problems.push("No fixtures/canvas/*.json fixtures found to validate the canvas frame-selection schema against.");
  for (const name of fixtureNames) {
    const fixture = JSON.parse(await readFile(resolve(canvasFixturesDir, name), "utf8"));
    const errors = validateAgainstPublishedSchema(canvasSchema, fixture);
    if (errors.length > 0) {
      problems.push(`canvas-frame-selection.schema.json rejects fixture ${name}: ${JSON.stringify(errors.slice(0, 3))}`);
    }
  }

  // 3. canvas-bridge-package@1 must be a real public wire contract, not an unbacked capability
  // advertisement. Validate converter output from every shipped Canvas fixture through the composed
  // schema (which intentionally reuses the manifest, motion, and receipt schemas).
  const canvasBridgePackageSchema = await readSchema(resolve(schemasRoot, "canvas-bridge-package.schema.json"));
  if (canvasBridgePackageSchema.$id !== CANVAS_BRIDGE_PACKAGE_SCHEMA) {
    problems.push(`canvas-bridge-package.schema.json must declare $id ${CANVAS_BRIDGE_PACKAGE_SCHEMA}.`);
  }
  const bridgeSchemaDependencies = new Map<string, JsonSchemaDocument>(await Promise.all(
    ["package-manifest.schema.json", "motion.schema.json", "receipt.schema.json"].map(async (name) =>
      [name, await readSchema(resolve(schemasRoot, name))] as const
    )
  ));
  for (const name of fixtureNames) {
    const fixture = JSON.parse(await readFile(resolve(canvasFixturesDir, name), "utf8"));
    const canvasPackage = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-08-08T00:00:00.000Z",
      inputPath: `fixtures/canvas/${name}`
    });
    const errors = validateAgainstPublishedSchema(canvasBridgePackageSchema, canvasPackage, (ref) => bridgeSchemaDependencies.get(ref));
    if (errors.length > 0) {
      problems.push(`canvas-bridge-package.schema.json rejects converted fixture ${name}: ${JSON.stringify(errors.slice(0, 3))}`);
    }
  }
  for (const host of ["shellx-motion", "shellx-canvas"] as const) {
    if (!integrationCapabilitiesForHost(host).schemas.canvas?.includes(CANVAS_BRIDGE_PACKAGE_SCHEMA)) {
      problems.push(`${host} integration capabilities do not advertise ${CANVAS_BRIDGE_PACKAGE_SCHEMA}.`);
    }
  }

  // 4. The segment store itself stays internal, but its durable on-disk schema is published so a
  // future adapter cannot invent a second shape. Pin both the id and checked-in fixture here.
  const segmentStoreSchema = await readSchema(resolve(schemasRoot, "render-segment-store.schema.json"));
  if (segmentStoreSchema.$id !== "shellx-motion/render-segment-store@1") {
    problems.push("render-segment-store.schema.json must declare $id shellx-motion/render-segment-store@1.");
  }
  const segmentStoreFixture = JSON.parse(await readFile(resolve("fixtures/renderer-segment-store/empty-store.json"), "utf8"));
  const segmentStoreErrors = validateAgainstPublishedSchema(segmentStoreSchema, segmentStoreFixture);
  if (segmentStoreErrors.length > 0) {
    problems.push(`render-segment-store.schema.json rejects its fixture: ${JSON.stringify(segmentStoreErrors.slice(0, 3))}`);
  }

  // 5. Integration-protocol preset advertisement must equal the single-source preset list (D6).
  const advertised = integrationCapabilitiesForHost("shellx-motion").presets;
  if (!arraysEqual(advertised, [...MOTION_EXPORT_PRESETS])) {
    problems.push(`shellx-motion integration presets drifted from MOTION_EXPORT_PRESETS (got ${JSON.stringify(advertised)}).`);
  }

  return problems;
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    const problems = await check();
    if (problems.length > 0) {
      console.error("Public contract drift detected:");
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error("\nRun `pnpm run contracts:generate` and re-sync the published schemas with their validators.");
      process.exit(1);
    }
    console.log("Public contracts are in sync with their code-side authorities.");
    return;
  }
  await generate();
}

async function expectGeneratedFileMatches(path: string, expected: unknown, problems: string[]): Promise<void> {
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  let actual: string;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    problems.push(`Generated contract file missing: ${path}. Run pnpm run contracts:generate.`);
    return;
  }
  if (actual !== expectedText) {
    problems.push(`Generated contract file out of date: ${path}. Run pnpm run contracts:generate.`);
  }
}

async function readSchema(path: string): Promise<JsonSchemaDocument> {
  return JSON.parse(await readFile(path, "utf8")) as JsonSchemaDocument;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Code-unit order, not localeCompare: these lists are written into committed generated
 * contract files that `contracts:check` diffs, so the generator must emit identical bytes on
 * every machine regardless of the ambient locale. */
function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

await main();
