import { describe, expect, it } from "vitest";
import { purposeForCall } from "./catalog";

describe("catalog purpose extraction", () => {
  it("keeps known purpose strings byte-identical across the main and spread maps", () => {
    expect(purposeForCall("motion.state")).toBe("Read current package and UI state before mutation; retained host-receipt summaries currently require the Linux stable receipt reader.");
    expect(purposeForCall("motion.timeline.particles.structural.inspect")).toBe("Inspect one particle layer's bounded analytic field sources, emitter origins, trail, shading, and current limits without mutating it.");
    expect(purposeForCall("motion.timeline.shape.geometry.inspect")).toBe("Inspect one shape layer's v1 or legacy geometry, stroke dash, and resolved contour without mutating it.");
    expect(purposeForCall("motion.timeline.checkpoint-storyboard.create")).toBe("Seal one bounded checkpoint-storyboard descriptor as an immutable host-owned record; it does not create or render a package.");
  });

  it("states the audited purpose boundaries exactly", () => {
    const expected = {
      "motion.platform.requirements": "Report per-operation readiness: satisfied for this invocation versus possible by any route, with FFmpeg, FFprobe, and browser status plus installOptions; it only reports source-only GPU policy and never proves GPU.",
      "motion.preview.frame": "Render one deterministic PNG preview with a receipt; the strict no-fallback GPU lane is visual-only and proves neither audio nor final media.",
      "motion.quality.check": "Check rendered-media dimensions, audio, and sampled-frame quality against optional baseline thresholds with a receipt; it does not accept delivery or release.",
      "motion.prompt.queue": "On Linux, read stable receipt-derived prompt annotations and follow-ups; it never observes a live provider.",
      "motion.prompt.cancel": "On Linux, write a stable receipt-derived prompt-cancellation annotation; it never stops a live provider.",
      "motion.prompt.retry": "On Linux, write a stable receipt-derived prompt-retry annotation; it never starts a live provider.",
      "motion.agent.snapshot": "Read a compact path-free snapshot from host-approved package and receipt roots, with only the authenticated caller's jobs.",
      "motion.analysis.tracking.request": "Run contained point or planar analysis for a manifest-declared package video, then persist its retryable lifecycle in a copied package through separate host-approved input and empty output roots.",
      "motion.canvas.bridge_export": "Export a trusted Canvas frame selection and bridge receipt to a no-clobber destination.",
      "motion.canvas.package": "Convert a Canvas frame selection into a Motion package and resource catalog under host-approved roots, requiring an empty output and a host-approved sourceRoot for inline assets.",
      "motion.connector.catalog": "Return the canonical v2 connector catalog with immutable descriptor fingerprints and closed submit-preparation fields without reading a package, provider/authentication state, network, output, or host authority.",
      "motion.connector.canvas_to_mp4": "On Linux, run the Canvas-to-MP4 compatibility harness, writing Motion package and resource evidence to a trusted no-clobber output and either dry-running or rendering the selected preset, with no Cut plan or Cut mutation; macOS and Windows refuse before creating connector output state.",
      "motion.connector.canvas_to_cut": "On Linux, turn host-approved Canvas selection input evidence into one no-clobber P2B delivery in an absent or empty output: Browser preview and Browser-to-FFmpeg H.264 rendered_media with artifact handle, receipts, and Cut plan; never mutate Cut.",
      "motion.connector.script_to_cut": "On Linux, turn scripted-video input evidence into one no-clobber P2B delivery in an absent or empty output: Browser preview and Browser-to-FFmpeg H.264 rendered_media with artifact handle, receipts, and Cut plan; never mutate Cut.",
      "motion.connector.source_to_cut": "On Linux, turn host-approved imported Markdown input evidence into one no-clobber P2B delivery in an absent or empty output: Browser preview and Browser-to-FFmpeg H.264 rendered_media with artifact handle, receipts, and Cut plan; never mutate Cut.",
      "motion.connector.template_to_cut": "On Linux, apply values to immutable admitted template input evidence and publish one no-clobber P2A Browser-to-FFmpeg H.264 rendered_media delivery with browser preview, artifact handle, receipts, and Cut plan; it allows no dry run and never mutates Cut.",
      "motion.connector.cut_generate_to_cut": "On Linux, run the legacy Cut Generate compatibility flow from one script to package, Browser preview, Browser-to-FFmpeg H.264 rendered_media, and Cut plan; macOS and Windows refuse before creating output state, and it never inserts anything directly into Cut.",
      "motion.connector.panel": "Show the current P2A Template-to-Cut and P2B Canvas/Script/Source-to-Cut connector lifecycle; legacy named routes are compatibility-only.",
      "motion.html.snippet.import": "Import a bounded inert ShellX/HyperFrames-style HTML composition from a host-approved path into a trusted empty package output, staging verified local media and a receipt.",
      "motion.html.snippet.export": "Export a Motion package from host-approved roots as standalone HTML/CSS to a trusted empty output, with timing metadata and adapter lossiness diagnostics.",
      "motion.otio.import": "Import an OpenTimelineIO timeline from a host-approved path into a trusted Motion package output with a receipt.",
      "motion.otio.export": "Export a Motion package from host-approved roots to a trusted OpenTimelineIO output path with a receipt.",
      "motion.script.compile": "Compile structured scripted-video input from a host-approved root or inline into an empty host-approved Motion package output, committing the receipt after the complete package.",
      "motion.source.import": "Import a public source or supplied Markdown into a host-approved empty output, preserving source identity and receipt evidence.",
      "motion.source.to_scripted_video": "Lower imported Markdown from a host-approved input root into deterministic scripted-video JSON and receipt evidence in a host-approved empty output.",
      "motion.package.script.author": "Author one host-approved local inline web/html/canvas entry from a data-only source package into a separate empty copy-on-write output; the source remains unchanged.",
      "motion.review.html.bundle": "Collect render, preview, quality, and receipt evidence into a portable HTML review bundle only in trusted absent-or-empty scratch, from host receipt roots.",
      "motion.support.bundle": "Collect redacted local diagnostics for support handoff only in trusted absent scratch, summarizing optional host receipt-root evidence."
    } as const;

    for (const [call, purpose] of Object.entries(expected)) {
      expect(purposeForCall(call)).toBe(purpose);
    }
  });

  it("keeps the default fallback byte-identical", () => {
    expect(purposeForCall("motion.future.unknown")).toBe("Run motion.future.unknown.");
  });
});
