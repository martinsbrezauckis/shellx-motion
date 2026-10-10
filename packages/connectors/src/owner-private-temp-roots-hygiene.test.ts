import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_TREE_CWD_TEMP = /mkdtemp\s*\(\s*join\s*\(\s*process\.cwd\s*\(\s*\)\s*,\s*["']\.tmp-shellx-motion/;

describe("connector test temporary-root hygiene", () => {
  it("forbids source-tree .tmp-shellx-motion fixture roots", async () => {
    const sources = await testSources(SOURCE_ROOT);
    for (const source of sources) {
      expect(await readFile(source, "utf8"), source).not.toMatch(SOURCE_TREE_CWD_TEMP);
    }
  });
});

async function testSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return await testSources(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  }));
  return files.flat().sort();
}
