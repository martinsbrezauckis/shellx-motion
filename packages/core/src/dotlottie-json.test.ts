import { describe, expect, it, vi } from "vitest";
import { parseBoundedJsonObject } from "./dotlottie-json";

describe("bounded dotLottie metadata JSON parser", () => {
  it("refuses manifest, theme, and state-machine shape limits before JSON.parse", () => {
    const cases: Array<{ label: string; source: string; error: RegExp }> = [
      {
        label: "dotLottie manifest",
        source: JSON.stringify({ metadata: Array.from({ length: 20 }, () => Array.from({ length: 1_000 }, () => 0)) }),
        error: /20000-node limit/
      },
      {
        label: "dotLottie theme dark",
        source: `{"metadata":${"[".repeat(33)}0${"]".repeat(33)}}`,
        error: /depth-32 limit/
      },
      {
        label: "dotLottie state-machine button",
        source: `[${Array.from({ length: 1_001 }, () => "0").join(",")}]`,
        error: /oversized array/
      },
      {
        label: "dotLottie manifest",
        source: `{${Array.from({ length: 1_001 }, (_, index) => `"f${index}":0`).join(",")}}`,
        error: /oversized object/
      },
      {
        label: "dotLottie theme dark",
        source: `{"value":"${"x".repeat(256 * 1024 + 1)}"}`,
        error: /oversized string/
      },
      {
        label: "dotLottie state-machine button",
        source: '{"\\u005f\\u005fproto__":{}}',
        error: /forbidden key __proto__/
      }
    ];

    for (const testCase of cases) expectRefusedBeforeJsonParse(testCase.source, testCase.label, testCase.error);
  });

  it("keeps ordinary dotLottie metadata compatible", () => {
    const metadata = {
      version: "2",
      animations: [{ id: "hero", themes: ["dark"] }],
      themes: [{ id: "dark", name: "Dark" }],
      stateMachines: [{ id: "button", name: "Button" }],
      initial: { animation: "hero", stateMachine: "button" }
    };

    expect(parseBoundedJsonObject(JSON.stringify(metadata), "dotLottie manifest")).toEqual(metadata);
  });

  it("accepts an escaped Unicode string at the existing decoded-byte limit", () => {
    const source = `{"metadata":"${"\\uD83D\\uDE00".repeat(64 * 1024)}"}`;

    expect(parseBoundedJsonObject(source, "dotLottie theme dark").metadata).toBe("😀".repeat(64 * 1024));
  });
});

function expectRefusedBeforeJsonParse(sourceText: string, label: string, error: RegExp): void {
  const parseSpy = vi.spyOn(JSON, "parse");
  try {
    expect(() => parseBoundedJsonObject(sourceText, label)).toThrow(error);
    expect(parseSpy).not.toHaveBeenCalled();
  } finally {
    parseSpy.mockRestore();
  }
}
