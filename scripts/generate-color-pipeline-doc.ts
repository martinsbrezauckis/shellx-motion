/** Generate the public color-pipeline guide from its Core-owned closed contract. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderColorPipelineGuide } from "../packages/core/src/color-pipeline";

const outputPath = resolve("docs/public/COLOR_PIPELINE.md");
const expected = renderColorPipelineGuide();

if (process.argv.includes("--check")) {
  let actual: string;
  try {
    actual = await readFile(outputPath, "utf8");
  } catch {
    throw new Error("docs/public/COLOR_PIPELINE.md is missing. Run pnpm docs:color-pipeline.");
  }
  if (actual !== expected) throw new Error("docs/public/COLOR_PIPELINE.md is stale. Run pnpm docs:color-pipeline and commit the result.");
  console.log("Color-pipeline guide is in sync with its Core-owned contract.");
} else {
  await writeFile(outputPath, expected, "utf8");
}
