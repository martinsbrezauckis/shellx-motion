import { describe, expect, it } from "vitest";
import { helpCommand } from "./help-command";
import { unsupportedFrameLaneMessage } from "./lane-errors";

describe("CLI GPU final lane contract", () => {
  it("documents GPU as a strict direct-or-segmented frame lane", () => {
    const commands = helpCommand().commands as Array<{ name: string; usage: string; purpose: string }>;
    const render = commands.find((command) => command.name === "render");

    expect(render).toMatchObject({
      usage: expect.stringContaining("--frame-lane browser|native|gpu"),
      purpose: expect.stringContaining("GPU is strict raw-RGBA FFmpeg final-video delivery"),
    });
    expect(unsupportedFrameLaneMessage("invented")).toContain("native, browser, or gpu");
    expect(unsupportedFrameLaneMessage("invented")).toContain("refuse without fallback");
  });

});
