import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PBR_IMPORT_DOCS = [
  "skill/shellx-motion/SKILL.md",
  "skill/shellx-motion/references/cli.md",
  "docs/public/FEATURES.md",
  "docs/public/rendering.md",
] as const;

describe("contained glTF PBR source documentation", () => {
  it("does not retain the stale all-textures-denied statement", async () => {
    for (const path of PBR_IMPORT_DOCS) {
      const text = await readFile(resolve(REPOSITORY_ROOT, path), "utf8");
      expect(text, path).toContain("contained PNG");
      expect(text, path).toMatch(/1280x720/);
      expect(text, path).toMatch(/(?:preview|Native).*refus/i);
      expect(text, path).not.toMatch(/(?:denies|deny|refuses|fail closed).*textures/i);
    }
  });
});
