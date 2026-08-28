/** Generate the public Motion validation guide from its code-owned contract. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderMotionValidationGuide } from "../packages/core/src/motion-validation-contract";

const outputPath = resolve("docs/public/MOTION_VALIDATION.md");
const expected = renderMotionValidationGuide();

if (process.argv.includes("--check")) {
  let actual: string;
  try {
    actual = await readFile(outputPath, "utf8");
  } catch {
    throw new Error("docs/public/MOTION_VALIDATION.md is missing. Run pnpm docs:validation.");
  }
  if (actual !== expected) {
    throw new Error("docs/public/MOTION_VALIDATION.md is stale. Run pnpm docs:validation and commit the result.");
  }
  console.log("Motion validation guide is in sync with its code-owned contract.");
} else {
  await writeFile(outputPath, expected, "utf8");
}
