import { describe, expect, it, vi } from "vitest";
import {
  captureHeldMediaFrameForActiveHook,
  currentHeldMediaToolsForActiveHook,
  discardHeldMediaFrameForActiveHook,
  transferHeldMediaLeaseForActiveHook,
  withHeldMediaHooks,
} from "./linear-srgb-sdr-final-held-media-hooks.js";

const route = {} as Parameters<typeof captureHeldMediaFrameForActiveHook>[0];
const frame = {} as Parameters<typeof captureHeldMediaFrameForActiveHook>[1];
const owner = {} as Parameters<typeof transferHeldMediaLeaseForActiveHook>[0];
const transfer = {} as Parameters<typeof transferHeldMediaLeaseForActiveHook>[1];

function hooks() {
  return {
    capture: vi.fn(),
    currentTools: vi.fn(async () => undefined),
    discard: vi.fn(),
    transfer: vi.fn(() => true),
  };
}

describe("held-media optional hooks", () => {
  it("preserves ordinary execution when no hook is active", async () => {
    captureHeldMediaFrameForActiveHook(route, frame);
    expect(await currentHeldMediaToolsForActiveHook()).toBeUndefined();
    expect(transferHeldMediaLeaseForActiveHook(owner, transfer)).toBe(false);
    discardHeldMediaFrameForActiveHook();
  });

  it("keeps active hooks within their async scope and restores an outer scope", async () => {
    const outer = hooks();
    const inner = hooks();
    await withHeldMediaHooks(outer, async () => {
      await Promise.resolve();
      captureHeldMediaFrameForActiveHook(route, frame);
      expect(outer.capture).toHaveBeenCalledWith(route, frame);
      expect(await currentHeldMediaToolsForActiveHook()).toBeUndefined();
      await withHeldMediaHooks(inner, async () => {
        await Promise.resolve();
        expect(transferHeldMediaLeaseForActiveHook(owner, transfer)).toBe(true);
        discardHeldMediaFrameForActiveHook();
      });
      expect(inner.transfer).toHaveBeenCalledWith(owner, transfer);
      expect(inner.discard).toHaveBeenCalledOnce();
      expect(outer.transfer).not.toHaveBeenCalled();
      discardHeldMediaFrameForActiveHook();
      expect(outer.discard).toHaveBeenCalledOnce();
    });
    expect(transferHeldMediaLeaseForActiveHook(owner, transfer)).toBe(false);
  });
});
