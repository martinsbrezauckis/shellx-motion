/**
 * Entry-point detection for CLI bins.
 *
 * npm exposes a package bin as a SYMLINK, so `process.argv[1]` stays
 * `.../node_modules/.bin/<name>` while `import.meta.url` is realpath-resolved to the
 * built file. Comparing the two by basename silently missed under npm/npx and the CLI
 * exited 0 having done nothing. pnpm writes a real-path shim, which is why only pnpm
 * appeared to work. Compare resolved real paths on both sides instead.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(moduleUrl) === argv1;
  }
}
