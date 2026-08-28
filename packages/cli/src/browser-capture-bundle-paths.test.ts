import { describe, expect, it } from "vitest";
import { captureBundleRelativePath, captureCatalogIsExternal, capturePathsOverlap, closedCaptureBundleInventory, mapCaptureBundleArtifacts } from "./browser-capture-bundle-paths.js";

describe("browser capture directory bundle paths", () => {
  const output = "/governed/capture";

  it("maps only final descendants to a normalized closed inventory", () => {
    expect(closedCaptureBundleInventory(output, [
      "/governed/capture/primary.png",
      "/governed/capture/trace.json",
      "/governed/capture/recording/000000.png",
      "/governed/capture/receipt.json"
    ])).toEqual(["primary.png", "trace.json", "recording/000000.png", "receipt.json"]);
  });

  it("refuses outside/equal leaves, collisions, and file-directory overlap", () => {
    expect(captureBundleRelativePath(output, output)).toBeUndefined();
    expect(captureBundleRelativePath(output, "/governed/outside.png")).toBeUndefined();
    expect(() => closedCaptureBundleInventory(output, ["/governed/capture/receipt.json", "/governed/capture/receipt.json"])).toThrow(/duplicate/i);
    expect(capturePathsOverlap("recording", "recording/000000.png")).toBe(true);
    expect(capturePathsOverlap("trace.json", "receipt.json")).toBe(false);
    expect(() => closedCaptureBundleInventory(output, ["/governed/capture/evidence", "/governed/capture/evidence/capture.html"])).toThrow(/overlapping/i);
  });

  it("preserves only available renderer evidence under the final bundle root", () => {
    expect(mapCaptureBundleArtifacts("/private/capture", "/governed/capture", [{ role: "browser_capture_html", path: "/private/capture/browser-capture-html/inline.html", status: "available", mediaType: "text/html", primary: true }])).toEqual([
      expect.objectContaining({ stagePath: "/private/capture/browser-capture-html/inline.html", publicPath: "/governed/capture/browser-capture-html/inline.html", relativePath: "browser-capture-html/inline.html", artifact: expect.objectContaining({ path: "/governed/capture/browser-capture-html/inline.html" }) })
    ]);
    expect(() => mapCaptureBundleArtifacts("/private/capture", "/governed/capture", [{ role: "browser_capture_html", path: "/outside/inline.html", status: "available" }])).toThrow(/private capture bundle stage/i);
  });

  it("keeps primary and per-recording-sample HTML evidence as distinct final bundle leaves", () => {
    const mapped = mapCaptureBundleArtifacts("/private/capture", "/governed/capture", [
      { role: "browser_capture_html", path: "/private/capture/browser-capture-html/primary.html", status: "available" },
      { role: "browser_capture_html", path: "/private/capture/recording/.browser-capture-samples/000000/browser-capture-html/sample.html", status: "available" }
    ]);
    expect(closedCaptureBundleInventory(output, [
      "/governed/capture/primary.png",
      ...mapped.map((entry) => entry.publicPath),
      "/governed/capture/recording/000000.png",
      "/governed/capture/receipt.json"
    ])).toEqual([
      "primary.png",
      "browser-capture-html/primary.html",
      "recording/.browser-capture-samples/000000/browser-capture-html/sample.html",
      "recording/000000.png",
      "receipt.json"
    ]);
  });

  it("requires a mutable catalog to remain outside the capture directory transaction", () => {
    expect(captureCatalogIsExternal(output, "/governed/catalog.json")).toBe(true);
    expect(captureCatalogIsExternal(output, output)).toBe(false);
    expect(captureCatalogIsExternal(output, "/governed/capture/catalog.json")).toBe(false);
  });
});
