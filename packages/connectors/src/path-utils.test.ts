import { describe, expect, it } from "vitest";
import { normalizeWindowsExtendedPath, resolveConnectorPath } from "./path-utils";

describe("connector path utilities", () => {
  it("normalizes Windows extended-length paths before path.resolve", () => {
    expect(normalizeWindowsExtendedPath(String.raw`\\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\\\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\UNC\server\share\motion\scripted-video.json`))
      .toBe(String.raw`\\server\share\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath(String.raw`\\?\\UNC\\server\share\motion\scripted-video.json`))
      .toBe(String.raw`\\server\share\motion\scripted-video.json`);
    expect(normalizeWindowsExtendedPath("/tmp/motion/scripted-video.json"))
      .toBe("/tmp/motion/scripted-video.json");
    expect(resolveConnectorPath(String.raw`\\?\C:\Users\Example\motion\scripted-video.json`))
      .toBe(String.raw`C:\Users\Example\motion\scripted-video.json`);
  });
});
