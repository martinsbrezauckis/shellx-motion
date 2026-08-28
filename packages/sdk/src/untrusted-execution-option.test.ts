import { describe, expect, it } from "vitest";
import { createMotionSdk, type MotionSdkRenderRequest } from "./index";

describe("SDK enforced-untrusted boundary", () => {
  it("keeps enforced-untrusted selection out of SDK render inputs", async () => {
    const typeOnly = {
      packageRoot: "/motion/pkg",
      outputPath: "/motion/out/final.webm",
      preset: "webm-vp9",
      // @ts-expect-error This renderer-host configuration must never become an SDK request field.
      untrustedExecution: "enforced",
    } satisfies MotionSdkRenderRequest;
    void typeOnly;

    const sdk = createMotionSdk({
      execute: async () => { throw new Error("SDK transport must not receive an unsupported renderer-host option."); }
    });
    const result = await sdk.render({
      packageRoot: "/motion/pkg",
      outputPath: "/motion/out/final.webm",
      preset: "webm-vp9",
      untrustedExecution: "enforced",
    } as unknown as MotionSdkRenderRequest);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "SDK render input contains unsupported field untrustedExecution." }
    });
  });
});
