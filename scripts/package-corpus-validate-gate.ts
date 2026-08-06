/**
 * Gate: every package this repository SHIPS must satisfy the schema its own validator enforces.
 *
 * Why this exists. A package reported as valid must not be refused later by the same schema. Every `validate`
 * door ran `validateDocument` at all — the CLI, the Debug API/MCP and the SDK each loaded the package
 * and reported metadata. The corpus gate independently runs the real validator against every promoted
 * package so unsupported declarations cannot pass through a metadata-only path.
 *
 * Fixing the two templates fixes those two templates. This gate fixes the class: a package that our own
 * validator rejects can never be shipped again, whatever wiring exists in the validate commands. It is
 * deliberately independent of the CLI path so a future regression in that wiring cannot disable it.
 *
 * Scope: fixture and template packages committed to this repository — the ones a user receives. Scratch
 * output and agent artifacts are not shipped and are not scanned.
 *
 * Dependencies: `@shellx-motion/core` (`loadSchema`, `validateDocument`).
 * Primary caller: `pnpm run corpus:check`, run as part of `pnpm test`.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, validateDocument } from "../packages/core/src/index";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Committed roots whose packages ship to a user. */
const SHIPPED_ROOTS = ["fixtures/packages", "templates"];

/** Depth is bounded so a stray deep tree cannot turn the gate into a filesystem walk. */
const MAX_DEPTH = 4;

/**
 * Every directory at or below `dir` that holds a `motion.json`.
 *
 * @param dir absolute directory to search.
 * @returns absolute package roots, in directory order.
 */
function findPackages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(current, entry.name);
      if (existsSync(join(full, "motion.json"))) found.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

async function main(): Promise<void> {
  const roots = SHIPPED_ROOTS.flatMap((root) => findPackages(join(REPO, root)));
  if (roots.length === 0) {
    console.error("package-corpus-validate-gate: found no shipped packages — the search roots are wrong.");
    process.exit(1);
  }

  const schema = await loadSchema("motion");
  const failures: Array<{ root: string; errors: Array<{ path: string; message: string }> }> = [];

  for (const root of roots) {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(join(root, "motion.json"), "utf8"));
    } catch (error) {
      failures.push({ root, errors: [{ path: "", message: `motion.json is not readable JSON: ${(error as Error).message}` }] });
      continue;
    }
    const result = await validateDocument(schema, document);
    if (!result.ok) failures.push({ root, errors: result.errors });
  }

  if (failures.length === 0) {
    console.log(`package-corpus-validate-gate: OK — ${roots.length} shipped package(s) satisfy shellx-motion/motion@1.`);
    return;
  }

  console.error(`package-corpus-validate-gate: ${failures.length} of ${roots.length} shipped package(s) FAIL their own schema.\n`);
  for (const failure of failures) {
    console.error(relative(REPO, failure.root));
    for (const error of failure.errors) console.error(`    ${error.path || "/"}  ->  ${error.message}`);
    console.error("");
  }
  console.error("A shipped package our validator rejects is a package that will refuse or silently drop work at render time.");
  process.exit(1);
}

void main();
