import { resolve } from "node:path";
import type { LocalMotionSdkOptions } from "./local.js";

type TestAuthoringRoots = {
  inputRoots?: readonly string[];
  outputRoots?: readonly string[];
};

/**
 * Adds only fixture roots explicitly owned by the calling test.
 *
 * Explicit SDK options always win, including an empty root list used by a
 * fail-closed test. This helper is test-only: production SDK callers must
 * configure their own authoring authority and cannot derive it from requests.
 */
export function withTestAuthoringRoots<T extends LocalMotionSdkOptions>(
  options: T,
  roots: TestAuthoringRoots,
): T & Pick<LocalMotionSdkOptions, "authoringInputRoots" | "authoringOutputRoots"> {
  const inputRoots = canonicalRoots(roots.inputRoots);
  const outputRoots = canonicalRoots(roots.outputRoots);
  return {
    ...options,
    ...(options.authoringInputRoots === undefined && inputRoots.length > 0 ? { authoringInputRoots: inputRoots } : {}),
    ...(options.authoringOutputRoots === undefined && outputRoots.length > 0 ? { authoringOutputRoots: outputRoots } : {}),
  };
}

function canonicalRoots(roots: readonly string[] | undefined): string[] {
  return [...new Set((roots ?? []).map((root) => resolve(root)))];
}
