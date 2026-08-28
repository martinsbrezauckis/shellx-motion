import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { GPU_PAGE_SERIALIZATION_RUNTIME } from "./gpu-page-serialization-runtime";

describe("GPU page serialization runtime", () => {
  it("installs exactly one immutable transform helper in an isolated page and accepts its own repeat installation", () => {
    const context = Object.create(null) as Record<string, unknown>;
    expect(runInNewContext(GPU_PAGE_SERIALIZATION_RUNTIME, context)).toBe(true);
    expect(runInNewContext(`__name(function () { return 42; }, "sample")()`, context)).toBe(42);
    expect(runInNewContext(GPU_PAGE_SERIALIZATION_RUNTIME, context)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(context, "__name")).toMatchObject({
      configurable: false,
      enumerable: false,
      writable: false
    });
    expect(Object.getOwnPropertyDescriptor(context, "__SHELLX_MOTION_PAGE_SERIALIZATION_RUNTIME__")).toMatchObject({
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });
  });

  it("does not trust or replace a preexisting foreign transform helper", () => {
    const context = { __name: (target: unknown) => target };
    expect(runInNewContext(GPU_PAGE_SERIALIZATION_RUNTIME, context)).toBe(false);
    expect(context.__name).toBeTypeOf("function");
  });
});
