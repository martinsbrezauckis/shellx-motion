import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { browserKeyingRuntimeScript } from "./browser-runtime";

describe("browser keying runtime script", () => {
  it("is self-contained when Function#toString includes esbuild name helpers", () => {
    const wrapped = browserKeyingRuntimeScript();
    expect(wrapped).toMatch(/^<script>.*<\/script>$/s);
    const source = wrapped.slice("<script>".length, -"</script>".length);
    const context: Record<string, unknown> = {};

    expect(() => runInNewContext(source, context)).not.toThrow();
    expect(context.__SHELLX_MOTION_APPLY_KEYING__).toBeTypeOf("function");
  });
});
