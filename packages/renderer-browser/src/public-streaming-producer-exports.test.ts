import { describe, expect, it } from "vitest";
import {
  BrowserStreamingProducerBusyError,
  BrowserStreamingProducerCapabilityError,
  BrowserStreamingProducerCleanupError,
  createBrowserStreamingFrameProducer,
  createGpuStreamingFrameProducer,
  GpuStreamingProducerCapabilityError,
  GpuStreamingProducerCleanupError,
  GpuStreamingProducerContainmentError
} from "./index";

describe("browser streaming producer public exports", () => {
  it("exposes the bounded producer and typed refusals from the package root", () => {
    expect(createBrowserStreamingFrameProducer).toBeTypeOf("function");
    expect(BrowserStreamingProducerBusyError).toBeTypeOf("function");
    expect(BrowserStreamingProducerCapabilityError).toBeTypeOf("function");
    expect(BrowserStreamingProducerCleanupError).toBeTypeOf("function");
  });

  it("exposes the raw RGBA GPU producer and its typed refusals", () => {
    expect(createGpuStreamingFrameProducer).toBeTypeOf("function");
    expect(GpuStreamingProducerCapabilityError).toBeTypeOf("function");
    expect(GpuStreamingProducerCleanupError).toBeTypeOf("function");
    expect(GpuStreamingProducerContainmentError).toBeTypeOf("function");
  });
});
