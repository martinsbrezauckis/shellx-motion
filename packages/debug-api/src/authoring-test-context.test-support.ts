import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

type AuthoringRootContext = {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
};

type TestAuthoringRoots = {
  inputRoots?: readonly string[];
  outputRoots?: readonly string[];
};

/**
 * Adds only roots a test has already named as its own fixture input or output.
 *
 * Explicit context roots always win, including an empty array used by a dedicated
 * fail-closed test. This helper is test-only: production hosts still have to
 * configure their own authority and cannot infer it from command arguments.
 */
export function withTestAuthoringRoots<T extends object>(
  context: T & AuthoringRootContext,
  roots: TestAuthoringRoots,
): T & AuthoringRootContext {
  const inputRoots = canonicalRoots(roots.inputRoots);
  const outputRoots = canonicalRoots(roots.outputRoots);
  return {
    ...context,
    ...(context.authoringInputRoots === undefined && inputRoots.length > 0 ? { authoringInputRoots: inputRoots } : {}),
    ...(context.authoringOutputRoots === undefined && outputRoots.length > 0 ? { authoringOutputRoots: outputRoots } : {}),
  };
}

/**
 * The large Debug API integration test passes its owned fixture paths directly
 * as command arguments. Keep that one shared test harness aligned with the
 * production host contract without granting a broad temporary, repository, or
 * home root.
 */
export function withCommandTestAuthoringRoots<T extends object>(
  context: T & AuthoringRootContext,
  command: string,
  args: unknown,
): T & AuthoringRootContext {
  const record = objectRecord(args);
  if (!record) return context;

  if (command === "motion.package.extract") {
    return withTestAuthoringRoots(context, {
      inputRoots: stringPaths(record, ["archivePath"]),
      outputRoots: stringPaths(record, ["packageRoot"]),
    });
  }

  const inputRoots = stringPaths(record, [
    "packageRoot",
    "archivePath",
    "sourcePath",
    "scriptPath",
    "htmlPath",
    "otioPath",
    "templateRoot",
  ]);
  const outputRoots = [
    ...outputDirectoryRoots(record, ["outDir", "packageDir", "recordingFramesDir"]),
    ...fileParentPaths(record, ["outPath", "outputPath", "catalogPath", "recordingManifestPath"]),
  ];
  return withTestAuthoringRoots(context, {
    inputRoots: [...inputRoots, ...fileParentPaths(record, ["canvasSelectionPath", "workflowPath", "qualityManifestPath"])],
    outputRoots,
  });
}

function canonicalRoots(roots: readonly string[] | undefined): string[] {
  return [...new Set((roots ?? []).map((root) => resolve(root)))];
}

function stringPaths(record: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.flatMap((key) => typeof record[key] === "string" ? [record[key]] : []);
}

function fileParentPaths(record: Record<string, unknown>, keys: readonly string[]): string[] {
  return stringPaths(record, keys).map((path) => dirname(path));
}

/**
 * Production roots must already be real directories, while a command's output
 * directory is often deliberately absent (or deliberately a file in a
 * negative test). Grant only the nearest owned parent in those cases so the
 * production command can run its own leaf-type or empty-or-absent preflight.
 */
function outputDirectoryRoots(record: Record<string, unknown>, keys: readonly string[]): string[] {
  return stringPaths(record, keys).map((path) => {
    const candidate = resolve(path);
    try {
      return lstatSync(candidate).isDirectory() ? candidate : dirname(candidate);
    } catch (error) {
      if (isMissingPathError(error)) return dirname(candidate);
      throw error;
    }
  });
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
