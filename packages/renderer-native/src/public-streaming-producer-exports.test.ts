import { describe, expect, it } from "vitest";
import {
  getNativeFrameProducerFailureEvidence,
  NativeFrameProducerCleanupFailure,
  NativeFrameProducerFailure,
  produceNativeFrameStream
} from "./index";

describe("native streaming producer public exports", () => {
  it("exposes the bounded producer and typed refusals from the package root", () => {
    expect(produceNativeFrameStream).toBeTypeOf("function");
    expect(getNativeFrameProducerFailureEvidence).toBeTypeOf("function");
    expect(NativeFrameProducerCleanupFailure).toBeTypeOf("function");
    expect(NativeFrameProducerFailure).toBeTypeOf("function");
  });
});
