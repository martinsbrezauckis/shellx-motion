/** Emits the repository-only M260 source-acceptance artifact as canonical JSON. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../packages/core/src/index.js";
import { generateM260AcceptanceFixtureArtifact } from "./m260-acceptance-artifact/orchestration.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${canonicalJson(generateM260AcceptanceFixtureArtifact())}\n`);
}
