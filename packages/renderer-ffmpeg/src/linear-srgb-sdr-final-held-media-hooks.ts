import { AsyncLocalStorage } from "node:async_hooks";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { LinearSrgbSdrFinalWebGpuFrame } from "@shellx-motion/renderer-browser/internal/linear-srgb-sdr-final";
import type { HeldTool } from "./linear-srgb-sdr-final-held-media-files.js";
import type { HeldMediaExtensionOwner, HeldMediaExtensionTransfer } from "./linear-srgb-sdr-final-held-media-extension-types.js";

type HeldMediaHooks = Readonly<{
  capture(route: LinearSrgbSdrFinalRoute, frame: LinearSrgbSdrFinalWebGpuFrame): void;
  currentTools(): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }> | undefined>;
  discard(): void;
  transfer(owner: HeldMediaExtensionOwner, input: HeldMediaExtensionTransfer): boolean;
}>;

const activeHooks = new AsyncLocalStorage<HeldMediaHooks>();

/** Optional, async-scoped hooks leave ordinary held-media execution unchanged. */
export function withHeldMediaHooks<T>(hooks: HeldMediaHooks, operation: () => Promise<T> | T): Promise<T> | T {
  return activeHooks.run(hooks, operation);
}

export function captureHeldMediaFrameForActiveHook(route: LinearSrgbSdrFinalRoute, frame: LinearSrgbSdrFinalWebGpuFrame): void {
  activeHooks.getStore()?.capture(route, frame);
}

export async function currentHeldMediaToolsForActiveHook(): Promise<Readonly<{ ffmpeg: HeldTool; ffprobe: HeldTool }> | undefined> {
  return await activeHooks.getStore()?.currentTools();
}

export function discardHeldMediaFrameForActiveHook(): void {
  activeHooks.getStore()?.discard();
}

export function transferHeldMediaLeaseForActiveHook(owner: HeldMediaExtensionOwner, input: HeldMediaExtensionTransfer): boolean {
  return activeHooks.getStore()?.transfer(owner, input) ?? false;
}
