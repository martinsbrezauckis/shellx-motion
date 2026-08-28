import { relative, resolve } from "node:path";

const PROOF_ROOT = resolve(".scratch", "rendering-samples-proof");
const ROOT_OVERRIDE = "SHELLX_MOTION_RENDERING_SAMPLES_ROOT";

/**
 * Allows the proof driver to give a workflow a fresh, isolated scratch root.
 * Direct smoke invocations retain their historical bounded scratch destination.
 */
export function renderingSamplesProofRoot(defaultRoot: string): string {
  const override = process.env[ROOT_OVERRIDE];
  if (!override) return resolve(defaultRoot);
  const candidate = resolve(override);
  const pathFromProofRoot = relative(PROOF_ROOT, candidate);
  if (!pathFromProofRoot || pathFromProofRoot === ".." || pathFromProofRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${ROOT_OVERRIDE} must name a child of ${PROOF_ROOT}.`);
  }
  return candidate;
}

export const renderingSamplesProofRootEnvironment = ROOT_OVERRIDE;
