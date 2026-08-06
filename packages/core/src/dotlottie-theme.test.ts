import { describe, expect, it } from "vitest";
import { hashBuffer } from "./receipts";
import { applyStaticDotLottieTheme } from "./dotlottie-theme";

const animation = JSON.stringify({
  v: "5.12.2",
  fr: 30,
  ip: 0,
  op: 30,
  w: 100,
  h: 100,
  slots: { accent: { p: { a: 0, k: [1, 0, 0, 1] } } },
  layers: [{
    ty: 4,
    shapes: [{ ty: "fl", c: { sid: "accent" }, o: { a: 0, k: 100 } }]
  }]
});

function theme(text: string) {
  const bytes = Buffer.from(text);
  return {
    kind: "theme" as const,
    id: "dark",
    archivePath: "t/dark.json",
    text,
    sha256: hashBuffer(bytes)
  };
}

describe("static dotLottie themes", () => {
  it("materializes a static color rule into every matching selected-animation slot", () => {
    const resource = theme(JSON.stringify({ rules: [{ id: "accent", type: "Color", value: [0.1, 0.5, 0.9] }] }));
    const applied = applyStaticDotLottieTheme({ animationText: animation, animationId: "hero", theme: resource });
    const output = JSON.parse(applied.animationText) as Record<string, any>;

    expect(applied).toMatchObject({
      themeId: "dark",
      themeSha256: resource.sha256,
      animationId: "hero",
      appliedRuleCount: 1,
      appliedTargetCount: 1,
      skippedScopedRuleCount: 0,
      slotIds: ["accent"]
    });
    expect(output.layers[0].shapes[0].c).toEqual({ sid: "accent", a: 0, k: [0.1, 0.5, 0.9, 1] });
    expect(output.slots.accent).toEqual({ p: { a: 0, k: [0.1, 0.5, 0.9, 1] } });
  });

  it("skips rules scoped to another animation", () => {
    const applied = applyStaticDotLottieTheme({
      animationText: animation,
      animationId: "hero",
      theme: theme(JSON.stringify({ rules: [{ id: "accent", type: "Color", animations: ["other"], value: [0, 1, 0] }] }))
    });
    expect(applied).toMatchObject({ appliedRuleCount: 0, appliedTargetCount: 0, skippedScopedRuleCount: 1 });
  });

  it("refuses expressions, animated values, unsupported types, and missing slots", () => {
    const apply = (rule: Record<string, unknown>) => applyStaticDotLottieTheme({
      animationText: animation,
      animationId: "hero",
      theme: theme(JSON.stringify({ rules: [rule] }))
    });
    expect(() => apply({ id: "accent", type: "Color", expression: "Math.random()" })).toThrow("not executable");
    expect(() => apply({ id: "accent", type: "Color", keyframes: [] })).toThrow("unsupported animated keyframes");
    expect(() => apply({ id: "accent", type: "Text", value: { text: "No" } })).toThrow("outside the static editable subset");
    expect(() => apply({ id: "missing", type: "Color", value: [0, 1, 0] })).toThrow("does not target");
    expect(() => apply({ id: "__proto__", type: "Color", value: [0, 1, 0] })).toThrow("unsafe slot id");
  });
});
