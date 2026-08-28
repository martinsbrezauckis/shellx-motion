import { describe, expect, it, vi } from "vitest";
import { probeMotionBrowserVersionWithLauncher } from "./browser-version-probe.js";

describe("browser version probe", () => {
  it("launches the exact browser headlessly and closes it", async () => {
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ version: () => "151.0.0.0", close }));

    const result = await probeMotionBrowserVersionWithLauncher("C:\\Browser\\chrome.exe", 15_000, launch);

    expect(result).toEqual({ ok: true, version: "151.0.0.0" });
    expect(launch).toHaveBeenCalledWith({
      executablePath: "C:\\Browser\\chrome.exe",
      headless: true,
      timeout: 15_000,
      args: ["--disable-background-networking", "--disable-gpu", "--no-first-run"]
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("classifies a bounded launcher timeout without exposing its message", async () => {
    const timeout = new Error("private executable path");
    timeout.name = "TimeoutError";
    const result = await probeMotionBrowserVersionWithLauncher("C:\\private\\chrome.exe", 50, async () => {
      throw timeout;
    });

    expect(result).toEqual({ ok: false, reason: "timed_out" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("refuses a version when the headless browser cannot close", async () => {
    const result = await probeMotionBrowserVersionWithLauncher("browser", 50, async () => ({
      version: () => "151.0.0.0",
      close: async () => { throw new Error("still running"); }
    }));

    expect(result).toEqual({ ok: false, reason: "cleanup_failed" });
  });
});
