/**
 * Private C6C terminal-boundary Browser session.
 *
 * Ordinary Browser rendering is end-exclusive because it admits and draws layers. This module is
 * deliberately narrower: an opaque host capability selects one exact-duration D frame whose
 * document contains only the Motion document's fixed dimensions and static background. It never
 * resolves package resources, source documents, fonts, scripts, media, or WebGL.
 */
import {
  agentScriptExecutionEvidenceForDataOnly,
  assertLocalMotionFrameBudget,
  type MotionPackage,
} from "@shellx-motion/core";
import { createHash } from "node:crypto";
import { launchOwnedBrowserSession } from "./browser-owned-session-launch";
import { resolveChromiumLaunchArgs } from "./browser-launch-args";
import { createTerminalBoundaryBrowserRenderSession } from "./checkpoint-storyboard-terminal-boundary-render";
import {
  CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA,
  type CheckpointStoryboardTerminalBoundaryEvidence,
  type TerminalBoundaryDescriptor,
} from "./checkpoint-storyboard-terminal-boundary-contract";
import type {
  BrowserRenderSessionOptions,
  MotionBrowserRenderSession,
} from "./index";

const STRUCTURAL_OPTION_FIELD = "checkpointStoryboardTerminalBoundary";
interface TerminalBoundaryCapability {
  readonly schema: typeof CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA;
}

export type { CheckpointStoryboardTerminalBoundaryEvidence } from "./checkpoint-storyboard-terminal-boundary-contract";

const terminalCapabilities = new WeakMap<object, TerminalBoundaryCapability>();
const consumedTerminalCapabilityOptions = new WeakSet<object>();

/**
 * Mints the only capability that selects terminal-boundary mode. The returned object has no
 * structural marker; cloning it, serializing it, or rebuilding its fields loses the capability.
 */
export function withCheckpointStoryboardTerminalBoundaryMode<T extends object>(options: T): T {
  assertNoStructuralTerminalBoundaryOption(options);
  if (terminalCapabilities.has(options) || consumedTerminalCapabilityOptions.has(options)) {
    throw new Error("Checkpoint storyboard terminal-boundary capability options cannot be reused.");
  }
  const capableOptions = Object.assign({}, options);
  terminalCapabilities.set(capableOptions, Object.freeze({ schema: CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA }));
  return capableOptions;
}

/** @internal Called at the `createMotionBrowserRenderSession` choke point before generic admission. */
export async function createCheckpointStoryboardTerminalBoundarySession(
  sourcePackage: MotionPackage,
  options: BrowserRenderSessionOptions,
): Promise<MotionBrowserRenderSession | undefined> {
  assertNoStructuralTerminalBoundaryOption(options);
  if (consumedTerminalCapabilityOptions.has(options)) {
    throw new Error("Checkpoint storyboard terminal-boundary capability options cannot be reused.");
  }
  const capability = terminalCapabilities.get(options);
  if (!capability) return undefined;
  terminalCapabilities.delete(options);
  consumedTerminalCapabilityOptions.add(options);
  if (capability.schema !== CHECKPOINT_STORYBOARD_TERMINAL_SCHEMA) {
    throw new Error("Checkpoint storyboard terminal-boundary capability is invalid.");
  }
  assertTerminalSessionOptions(options);
  const descriptor = terminalBoundaryDescriptor(sourcePackage);
  await assertLocalMotionFrameBudget({ width: descriptor.document.width, height: descriptor.document.height, deviceScaleFactor: 1 });
  const launched = await launchOwnedBrowserSession({
    motion: sourcePackage.motion,
    packageRoot: sourcePackage.root,
    chromiumArgs: resolveChromiumLaunchArgs(),
    networkAccessRequested: false,
    enforcedUntrustedExecution: false,
    ...(options.launchBrowser ? { launchBrowser: options.launchBrowser } : {}),
  });
  return createTerminalBoundaryBrowserRenderSession(descriptor, options, launched.browser, launched.sandboxEvidence);
}

function assertNoStructuralTerminalBoundaryOption(value: unknown): void {
  if (value && typeof value === "object" && STRUCTURAL_OPTION_FIELD in value) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires a renderer-minted capability; structural checkpointStoryboardTerminalBoundary is refused.");
  }
}

function assertTerminalSessionOptions(options: BrowserRenderSessionOptions): void {
  for (const field of ["networkAccess", "untrustedExecution", "agentScriptAuthority", "borrowedGpuBrowser", "hybridDataOnlySource", "hostCapacity"] as const) {
    if (field in options && options[field] !== undefined) {
      throw new Error(`Checkpoint storyboard terminal-boundary mode refuses ${field}.`);
    }
  }
}

function terminalBoundaryDescriptor(sourcePackage: MotionPackage): TerminalBoundaryDescriptor {
  const motion = sourcePackage?.motion;
  if (!motion || typeof motion !== "object") throw new Error("Checkpoint storyboard terminal-boundary mode requires a Motion document.");
  const packageId = sourcePackage?.manifest?.id;
  if (typeof packageId !== "string" || packageId.length === 0) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires a package identity.");
  }
  const width = motion.width;
  const height = motion.height;
  const durationMs = motion.durationMs;
  if (!positiveSafeInteger(width) || !positiveSafeInteger(height)) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires finite positive integer document dimensions.");
  }
  if (!nonNegativeSafeInteger(durationMs)) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires an exact non-negative integer duration.");
  }
  const background = motion.background ?? "#00000000";
  if (typeof background !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(background)) {
    throw new Error("Checkpoint storyboard terminal-boundary mode requires a static #RRGGBB or #RRGGBBAA document background.");
  }
  const document = Object.freeze({ width, height, background: background.toLowerCase() });
  const scriptExecution = agentScriptExecutionEvidenceForDataOnly(motion);
  Object.freeze(scriptExecution.sources);
  Object.freeze(scriptExecution);
  const staticFingerprint = createHash("sha256").update(JSON.stringify({
    packageId, durationMs, width: document.width, height: document.height, background: document.background,
  })).digest("hex");
  return Object.freeze({ packageId, durationMs, document, scriptExecution, staticFingerprint });
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
