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
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("exceeds"),
      "invalid shader uniform name: u_time",
      "invalid shader uniform name: bad-name"
    ]));
  });
});
