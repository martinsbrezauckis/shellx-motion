import { describe, expect, it } from "vitest";
import { knownProducerFailure, safeProducerMessage } from "./streaming-final-adapter-evidence.js";
import { publicStreamingFinalFailureMessage } from "./streaming-final-adapter-execution.js";

describe("streaming diagnostic projection", () => {
  it("caps raw producer diagnostics before redacting partial credentials, controls, and paths", () => {
    const partial = `sk-proj-${"a".repeat(5_000)}`;
    const message = safeProducerMessage(new Error(`${partial}\u001b]8;;https://example.invalid\u0007hidden\u001b\\ C:\\Users\\TestUser\\private.txt /opt/fixture/private\u202E`));

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(partial.slice(0, 24));
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("C:\\Users\\TestUser");
    expect(message).not.toContain("/opt/fixture/private");
    expect(message).not.toContain("\u202E");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(400);
  });

  it("retains the typed producer failure shape while sanitizing the message", () => {
    const failure = knownProducerFailure({
      code: "native_failed",
      message: "API_TOKEN=value\r /opt/fixture/private"
    });

    expect(failure).toEqual({ code: "native_failed", message: "API_TOKEN=[redacted] <path>" });
  });

  it("projects the selected GPU failure message through the shared final boundary", () => {
    const message = publicStreamingFinalFailureMessage(`sk-proj-${"a".repeat(10)}\u001b[0m${"b".repeat(10)} C:\\Users\\TestUser\\private.txt`);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain("sk-proj-");
    expect(message).not.toContain("C:\\Users\\TestUser");
    expect(message).not.toContain("\u001b");
  });
});
