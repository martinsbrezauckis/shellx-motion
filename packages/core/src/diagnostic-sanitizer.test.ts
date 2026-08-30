import { describe, expect, it } from "vitest";
import {
  MAX_UNTRUSTED_DIAGNOSTIC_PUBLIC_BYTES,
  MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES,
  sanitizeUntrustedDiagnostic,
  stripDiagnosticControls
} from "./diagnostic-sanitizer";

const project = (value: string) => sanitizeUntrustedDiagnostic(value, {
  rawMaxBytes: MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES,
  publicMaxBytes: MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES
});

describe("untrusted diagnostic sanitizer", () => {
  it("removes splice controls before recognizing secret tokens and assignments", () => {
    const splitBare = `sk-proj-${"a".repeat(10)}\u001b[0m${"b".repeat(10)}`;
    const splitAssignment = `API_\u061cTOKEN=visible`;
    const value = project(`${splitBare} ${splitAssignment} "password":"hidden"`);

    expect(value).toBe("[redacted] API_TOKEN=[redacted] \"password\":\"[redacted]\"");
    expect(value).not.toContain("\u001b");
    expect(value).not.toContain("\u061c");
    expect(stripDiagnosticControls("left\u061cright")).toBe("leftright");
  });

  it("preserves quoted and unquoted assignment shapes", () => {
    expect(project("API_TOKEN=visible 'api_key':'hidden' password: \"secret\""))
      .toBe("API_TOKEN=[redacted] 'api_key':'[redacted]' password: \"[redacted]\"");
  });

  it("keeps hostile non-sensitive identifier scanning bounded-linear", () => {
    const measure = (value: string) => {
      const started = performance.now();
      const output = project(value);
      return { elapsedMs: performance.now() - started, output };
    };
    const short = "a".repeat(16 * 1024);
    const long = "a".repeat(MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES);
    const small = measure(short);
    const large = measure(long);

    expect(small.output).toBe(short);
    expect(large.output).toHaveLength(MAX_UNTRUSTED_DIAGNOSTIC_PUBLIC_BYTES - 2);
    expect(large.output.endsWith("…")).toBe(true);
    // The lengths differ by 64x. A per-offset scan of the remaining identifier
    // grows quadratically; this generous budget still rejects that shape.
    expect(large.elapsedMs).toBeLessThan(Math.max(1_000, small.elapsedMs * 256));
  });
});
