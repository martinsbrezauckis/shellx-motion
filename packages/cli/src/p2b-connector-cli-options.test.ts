import { describe, expect, it } from "vitest";
import { p2bConnectorArgumentRefusal, redactP2bConnectorInputError } from "./p2b-connector-cli-options.js";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("P2B connector CLI admission", () => {
  it("admits only the documented Script and Source placement options", () => {
    expect(p2bConnectorArgumentRefusal([
      "script-to-cut", "/inputs/story.json", "--out", "/delivery/script", "--cut-import-mode", "rendered_media",
      "--start-ms", "0", "--duration-ms", "1200", "--track", "primary"
    ])).toBeUndefined();
    expect(p2bConnectorArgumentRefusal([
      "source-to-cut", "/inputs/source.md", "--out", "/delivery/source",
      "--max-frames", "3", "--frame-duration-ms", "1200", "--width", "640", "--height", "360", "--fps", "24"
    ])).toBeUndefined();
  });

  it.each([
    ["forbidden dry run", ["canvas-to-cut", "/inputs/canvas.json", "--out", "/delivery/canvas", "--dry-run-render"]],
    ["duplicate out", ["canvas-to-cut", "/inputs/canvas.json", "--out", "/delivery/one", "--out", "/delivery/two"]],
    ["duplicate source frame aliases", ["source-to-cut", "/inputs/source.md", "--out", "/delivery/source", "--max-frames", "2", "--maxFrames", "2"]],
    ["duplicate source duration aliases", ["source-to-cut", "/inputs/source.md", "--out", "/delivery/source", "--frame-duration-ms", "1200", "--frameDurationMs", "1200"]],
    ["dangling positional", ["canvas-to-cut", "/inputs/canvas.json", "--out", "/delivery/canvas", "extra"]],
    ["missing option value", ["canvas-to-cut", "/inputs/canvas.json", "--out"]],
    ["input beneath delivery", ["script-to-cut", "/delivery/script/input.json", "--out", "/delivery/script"]]
  ])("refuses %s before connector dispatch", (_label, argv) => {
    expect(p2bConnectorArgumentRefusal(argv)).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("masks both a relative P2B input and the resolved connector path in a thrown error", () => {
    const inputPath = "fixtures/private-source.md";
    const resolvedPath = new URL(inputPath, `file://${process.cwd()}/`).pathname;
    const message = redactP2bConnectorInputError(new Error(`read failed: ${resolvedPath} (${inputPath})`), inputPath);

    expect(message).toBe("read failed: [P2B input] ([P2B input])");
  });
});
