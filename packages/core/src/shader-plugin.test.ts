import { describe, expect, it } from "vitest";
import {
  compileRestrictedFragmentShader,
  MAX_RESTRICTED_SHADER_BYTES,
  validateRestrictedFragmentShader
} from "./shader-plugin";

describe("restricted shader plugins", () => {
  it("compiles a deterministic expression shader with declared scalar uniforms", () => {
    const source = "vec4 motionMain(vec2 uv) { return vec4(uv.x, 0.5 + 0.5 * sin(u_time + u_phase), fract(u_seed), 1.0); }";
    const validation = validateRestrictedFragmentShader(source, ["u_phase"]);
    const compiled = compileRestrictedFragmentShader(source, ["u_phase"]);

    expect(validation).toEqual({
      ok: true,
      expression: "vec4(uv.x, 0.5 + 0.5 * sin(u_time + u_phase), fract(u_seed), 1.0)",
      errors: []
    });
    expect(compiled).toContain("uniform float u_phase;");
    expect(compiled).toContain("gl_FragColor = clamp(motionMain(uv), 0.0, 1.0);");
  });

  it.each([
    ["loop", "vec4 motionMain(vec2 uv) { for (;;) {} return vec4(uv, 0.0, 1.0); }", "control flow"],
    ["sampler", "vec4 motionMain(vec2 uv) { return texture2D(u_texture, uv); }", "texture2D"],
    ["helper", "float evil() { return evil(); } vec4 motionMain(vec2 uv) { return vec4(evil()); }", "exactly"],
    ["statement", "vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); gl_FragColor = vec4(1.0); }", "forbidden statement"],
    ["conditional", "vec4 motionMain(vec2 uv) { return uv.x > 0.5 ? vec4(1.0) : vec4(0.0); }", "conditional"],
    ["mutation", "vec4 motionMain(vec2 uv) { return vec4(uv.x += 1.0, uv.y, 0.0, 1.0); }", "mutation"],
    ["unknown identifier", "vec4 motionMain(vec2 uv) { return vec4(secretValue, uv, 1.0); }", "secretValue"],
    ["preprocessor", "#define X 1.0\nvec4 motionMain(vec2 uv) { return vec4(X); }", "preprocessor"]
  ])("rejects hostile or unbounded %s source", (_label, source, expected) => {
    expect(validateRestrictedFragmentShader(source).errors.join(" ")).toContain(expected);
  });

  it("rejects oversized source and unsafe uniform names", () => {
    const source = `vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); }${" ".repeat(MAX_RESTRICTED_SHADER_BYTES)}`;
    const result = validateRestrictedFragmentShader(source, ["u_time", "bad-name"]);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining("exceeds")]);
  });

  it("accepts the exact byte boundary and refuses one byte over before other validation", () => {
    const base = "vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); }";
    const atLimit = `${base}${" ".repeat(MAX_RESTRICTED_SHADER_BYTES - base.length)}`;
    expect(validateRestrictedFragmentShader(atLimit)).toMatchObject({ ok: true });
    expect(validateRestrictedFragmentShader(`${atLimit} `, ["bad-name"]).errors).toEqual([
      `shader source exceeds ${MAX_RESTRICTED_SHADER_BYTES} bytes`,
    ]);
    const multibyteOverLimit = `${base}${"\u2000".repeat(Math.ceil((MAX_RESTRICTED_SHADER_BYTES - base.length) / 3) + 1)}`;
    expect(multibyteOverLimit.length).toBeLessThan(MAX_RESTRICTED_SHADER_BYTES);
    expect(validateRestrictedFragmentShader(multibyteOverLimit).errors).toEqual([
      `shader source exceeds ${MAX_RESTRICTED_SHADER_BYTES} bytes`,
    ]);
  });

  it("preserves wrapper whitespace while refusing extra declarations and terminal data", () => {
    expect(validateRestrictedFragmentShader("\n vec4\tmotionMain ( vec2\nuv ) { return\nvec4(uv, 0.0, 1.0) ; } \n")).toMatchObject({ ok: true });
    expect(validateRestrictedFragmentShader("vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); } helper").ok).toBe(false);
    expect(validateRestrictedFragmentShader("vec4 motionMain(vec2 uv) { return vec4(uv, 0.0, 1.0); }; ").ok).toBe(false);
  });
});
