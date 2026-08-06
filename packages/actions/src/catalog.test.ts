import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actionCoverage, findAction, planAction } from "./catalog";

describe("motion action catalog", () => {
  it("matches exact action ids and refuses unknown action-id fallbacks", () => {
    expect(findAction("motion.timeline.layer.rich.set")?.id).toBe("motion.timeline.layer.rich.set");
    expect(findAction("motion.timeline.layer.not-real")).toBeNull();
    expect(planAction("motion.timeline.layer.not-real").action).toBeNull();
    expect(planAction("motion.timeline.layer.not-real").cautions).toContain("No exact action matched; inspect related actions before mutation.");
  });

  it("does not claim an unrelated action from one shared word", () => {
    expect(findAction("quietly inspect frosted weather telemetry")).toBeNull();
  });

  it("routes environment creation and rich-control edits to their owning actions", () => {
    expect(findAction("add a cinematic snow environment")?.id).toBe("motion.timeline.layer.create");
    expect(findAction("create rain environment")?.id).toBe("motion.timeline.layer.create");
    expect(findAction("change snow intensity")?.id).toBe("motion.timeline.layer.rich.set");
    expect(findAction("set environment intensity to 0.8")?.id).toBe("motion.timeline.layer.rich.set");
    expect(findAction("set shader uniform u_speed")?.id).toBe("motion.timeline.layer.rich.set");
  });

  it("ships a cold-start skill with the exact rich-control route", () => {
    const skill = readFileSync(new URL("../../../skill/shellx-motion/SKILL.md", import.meta.url), "utf8");
    const reference = readFileSync(new URL("../../../skill/shellx-motion/references/cli.md", import.meta.url), "utf8");

    expect(skill).toContain("actions guide motion.timeline.layer.rich.set");
    expect(skill).toContain("debug layer-rich-set");
    expect(skill).toContain("Cut as the editorial/link-lifecycle host");
    expect(reference).toContain("unknown `motion.*` ID returns no action");
    expect(reference).toContain("fixtures/packages/environment-*-cinematic");
  });

  it("finds render actions from natural user wording", () => {
    const action = findAction("render this lower third as mp4");

    expect(action?.id).toBe("motion.render.final");
    expect(action?.permission).toBe("render_motion");
    expect(action?.verify).toContain("Optional quality manifests gate final renders and record quality-check status in render receipts.");
  });

  it("finds quality-manifest gated final renders from natural user wording", () => {
    const action = findAction("render final mp4 with a quality manifest");

    expect(action?.id).toBe("motion.render.final");
    expect(action?.calls).toEqual(["motion.render.final", "motion.render.status", "motion.receipts.read"]);
  });

  it("finds PNG sequence exports from natural user wording", () => {
    const action = findAction("export this lower third as PNG sequence frames");

    expect(action?.id).toBe("motion.render.final");
    expect(action?.permission).toBe("render_motion");
    expect(action?.verify).toContain("Image-sequence render receipts include output frame directory, frame pattern, frame count, and PNG codec facts.");
  });

  it("finds still-frame image exports from natural user wording", () => {
    const action = findAction("export current frame as PNG still");

    expect(action?.id).toBe("motion.render.final");
    expect(action?.permission).toBe("render_motion");
    expect(action?.verify).toContain("Still-frame render receipts include output image path, timestamp, codec, and image artifact evidence.");
  });

  it("finds timeline preview strip exports from natural user wording", () => {
    const action = findAction("show timeline thumbnail strip");

    expect(action?.id).toBe("motion.preview.strip");
    expect(action?.permission).toBe("render_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.preview.strip", "motion.receipts.read"]);
    expect(action?.verify).toContain("Preview strip receipt includes per-frame output hashes, timestamps, and artifact paths.");
  });

  it("finds playhead preview exports from natural user wording", () => {
    const action = findAction("preview current playhead");

    expect(action?.id).toBe("motion.preview.playhead");
    expect(action?.permission).toBe("render_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.preview.playhead", "motion.receipts.read"]);
    expect(action?.verify).toContain("Playhead preview receipt includes timeline state, output frame hash, timestamp, and artifact path.");
  });

  it("finds preview player panel workflows from natural wording", () => {
    const action = findAction("show preview player panel");

    expect(action?.id).toBe("motion.preview.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.preview.panel"]);
    expect(action?.verify).toContain("Preview player panel returns package facts, playhead state, active timeline refs, preview modes, and render follow-ups without rendering.");
  });

  it("finds the scripted-video compile lane from Cut Generate wording", () => {
    const action = findAction("generate scripted video from description frames in Cut");

    expect(action?.id).toBe("motion.script.compile");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.state",
      "motion.script.compile",
      "motion.preview.frame",
      "motion.render.final",
      "motion.receipts.read"
    ]);
  });

  it("finds persisted tracking and reversible stabilization workflows", () => {
    expect(findAction("run planar tracking")?.id).toBe("motion.analysis.tracking.request");
    expect(findAction("show lost tracking spans")?.id).toBe("motion.analysis.tracking.inspect");
    expect(findAction("apply tracking stabilization")?.id).toBe("motion.analysis.tracking.apply");
    expect(findAction("restore transform before tracking")?.id).toBe("motion.analysis.tracking.detach");
    expect(findAction("verify track before cut handoff")?.id).toBe("motion.analysis.tracking.verify");
    expect(findAction("apply tracking stabilization")?.calls).toEqual([
      "motion.analysis.tracking.inspect",
      "motion.analysis.tracking.apply",
      "motion.analysis.tracking.verify",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
  });

  it("finds scripted storyboard review panel workflows", () => {
    const action = findAction("review scripted storyboard before cut handoff");

    expect(action?.id).toBe("motion.storyboard.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.storyboard.panel"]);
    expect(action?.verify).toContain("Storyboard panel returns review status, readiness diagnostics, source refs, frame timings, template/engine hints, and compile/Cut follow-up actions without mutating packages.");
  });

  it("finds scripted storyboard source graph workflows", () => {
    const action = findAction("show storyboard source graph");

    expect(action?.id).toBe("motion.storyboard.graph");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.storyboard.graph"]);
    expect(action?.verify).toContain("Storyboard graph returns source, asset, template, engine, review, sequence nodes/edges, and readiness diagnostics before compile or Cut handoff.");
  });

  it("finds Canvas independent MP4 export from natural wording", () => {
    const action = findAction("export this Canvas frame to mp4 without Cut");

    expect(action?.id).toBe("motion.connector.canvas_to_mp4");
    expect(action?.permission).toBe("render_motion");
    expect(action?.mutates).toBe(true);
    expect(action?.calls).toEqual([
      "motion.connector.canvas_to_mp4",
      "motion.receipts.read"
    ]);
  });

  it("finds connector readiness panels from natural wording", () => {
    const action = findAction("show connector readiness panel for Cut and Canvas");

    expect(action?.id).toBe("motion.connector.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.connector.panel"]);
    expect(action?.verify).toContain("Connector panel lists Canvas, Cut Generate, scripted-video, source, and template connector workflows with required inputs, render behavior, receipts, quality gates, and Cut handoff support.");
  });

  it("finds connector send-to-Cut flows from natural wording", () => {
    const action = findAction("send this Canvas frame to Cut timeline");

    expect(action?.id).toBe("motion.connector.canvas_to_cut");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.connector.canvas_to_cut",
      "motion.receipts.read"
    ]);
  });

  it("finds Cut Generate apply flows as a connector action", () => {
    const action = findAction("apply Cut Generate scripted video to Cut timeline");

    expect(action?.id).toBe("motion.connector.cut_generate_to_cut");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.connector.cut_generate_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
  });

  it("finds Script-to-Cut connector flows without Canvas", () => {
    const action = findAction("send scripted video JSON to Cut without Canvas");

    expect(action?.id).toBe("motion.connector.script_to_cut");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.connector.script_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
  });

  it("finds Source-to-Cut connector flows from imported source Markdown", () => {
    const action = findAction("source markdown to cut timeline without canvas");

    expect(action?.id).toBe("motion.connector.source_to_cut");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.connector.source_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
  });

  it("finds template control discovery and apply flows", () => {
    const panel = findAction("show template inspector panel");
    const discover = findAction("show editable template controls");
    const catalog = findAction("list motion templates in generate");
    const plan = findAction("prompt to template plan for cut generate");
    const apply = findAction("apply template control title");

    expect(catalog?.id).toBe("motion.template.catalog");
    expect(catalog?.permission).toBe("read_motion");
    expect(catalog?.calls).toEqual(["motion.template.catalog"]);
    expect(plan?.id).toBe("motion.template.plan");
    expect(plan?.permission).toBe("read_motion");
    expect(plan?.mutates).toBe(false);
    expect(plan?.calls).toEqual(["motion.template.catalog", "motion.template.plan"]);
    expect(plan?.verify).toContain("Template plan returns selected template, request-fit suitability score, target fit, provided/default/missing input readiness, semantic story and media slots, representative review frames, quality gates, the apply-review-render-quality-revise-handoff loop, and follow-up actions before mutation.");
    expect(panel?.id).toBe("motion.template.panel");
    expect(panel?.permission).toBe("read_motion");
    expect(panel?.mutates).toBe(false);
    expect(panel?.calls).toEqual(["motion.template.panel"]);
    expect(catalog?.verify).toContain("Template catalog returns package ids, template ids, compatible hosts/lanes, control counts, suitability metadata, and suggested follow-up actions.");
    expect(panel?.verify).toContain("Template panel returns grouped controls, bindings, current values, suitability metadata, control type counts, and follow-up actions.");
    expect(discover?.id).toBe("motion.template.controls");
    expect(discover?.permission).toBe("read_motion");
    expect(discover?.calls).toEqual(["motion.state", "motion.template.controls"]);
    expect(apply?.id).toBe("motion.template.apply");
    expect(apply?.permission).toBe("edit_motion");
    expect(apply?.calls).toEqual(["motion.state", "motion.template.controls", "motion.template.apply", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds package browser workflows from natural wording", () => {
    const action = findAction("browse motion packages");

    expect(action?.id).toBe("motion.packages.browse");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.packages.browse"]);
    expect(action?.verify).toContain("Package browser returns package cards, template availability, asset counts, brand provenance, and skipped-package warnings.");
  });

  it("finds prompt action panel workflows from natural wording", () => {
    const action = findAction("show prompt action panel");

    expect(action?.id).toBe("motion.actions.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.actions.panel"]);
    expect(action?.verify).toContain("Action panel returns grouped actions, permission counts, prompt commands, and suggested prompt-run follow-ups.");
  });

  it("finds local CLI agent health workflows from natural wording", () => {
    const action = findAction("check local cli agent health");

    expect(action?.id).toBe("motion.agent.health");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.agent.health"]);
    expect(action?.verify).toContain("Agent health returns local CLI subscription adapter readiness, transport, billing mode, and unavailable reasons without mutating packages.");
  });

  it("finds local CLI agent readiness panel workflows from natural wording", () => {
    const action = findAction("show local cli agent readiness panel");

    expect(action?.id).toBe("motion.agent.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.agent.panel"]);
    expect(action?.verify).toContain("Agent panel returns default local CLI selection policy, adapter command shapes, safety guarantees, receipt coverage, and prompt follow-ups without probing or mutating packages.");
  });

  it("finds template media-slot replacement flows", () => {
    const action = findAction("replace template media slot");

    expect(action?.id).toBe("motion.template.media.replace");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.template.controls", "motion.template.media.replace", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Template media replace receipt includes param id, copied asset ref, changed bindings, manifest asset refs, and validation result.");
  });

  it("finds Template-to-Cut connector flows from natural wording", () => {
    const action = findAction("apply editable template to Cut timeline");

    expect(action?.id).toBe("motion.connector.template_to_cut");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual([
      "motion.template.controls",
      "motion.connector.template_to_cut",
      "motion.receipts.read"
    ]);
  });

  it("finds review HTML bundle export flows from natural wording", () => {
    const action = findAction("export review html bundle");

    expect(action?.id).toBe("motion.review.html.bundle");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual(["motion.review.html.bundle", "motion.receipts.list"]);
    expect(action?.verify).toContain("Review HTML bundle includes public-safe artifact links and quality-gate summaries; its receipt records HTML path, copied artifacts, receipt count, and quality-gate counts.");
  });

  it("finds safe source import flows for prompt/link/repo workflows", () => {
    const action = findAction("import article link for storyboard");

    expect(action?.id).toBe("motion.source.import");
    expect(action?.permission).toBe("write_local");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.source.import", "motion.receipts.read"]);
    expect(action?.verify).toContain("Source import receipt includes public URL, kind, Markdown path, source hash, truncation evidence, and safe-fetch policy.");
  });

  it("finds source-to-scripted-video planning flows for imported prompt sources", () => {
    const action = findAction("turn imported source into scripted video");

    expect(action?.id).toBe("motion.source.to_scripted_video");
    expect(action?.permission).toBe("write_local");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.source.import", "motion.source.to_scripted_video", "motion.script.compile", "motion.receipts.read"]);
    expect(action?.verify).toContain("Source-to-scripted-video emits deterministic scripted-video JSON, source refs, review-required storyboard metadata, and receipt artifacts before Script-to-Cut.");
  });

  it("finds renderer capability matching for lane selection prompts", () => {
    const action = findAction("choose renderer lane for mp4 with audio");

    expect(action?.id).toBe("motion.capabilities.match");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.capabilities.match"]);
    expect(action?.verify).toContain("Capability match returns lane cards, output/audio/alpha fit, unsupported features, recommended lane, and frame-to-final pipeline when final encoding needs a frame lane.");
  });

  it("finds renderer capability panel workflows", () => {
    const action = findAction("show renderer capability panel");

    expect(action?.id).toBe("motion.capabilities.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.capabilities.panel"]);
    expect(action?.verify).toContain("Capability panel returns grouped lane cards, support badges, package fit, recommended lane, and follow-up match/export actions.");
  });

  it("finds standalone HTML snippet export flows from HyperFrames-style wording", () => {
    const action = findAction("export hyperframes html snippet");

    expect(action?.id).toBe("motion.html.snippet.export");
    expect(action?.permission).toBe("write_local");
    expect(action?.mutates).toBe(true);
    expect(action?.calls).toEqual(["motion.html.snippet.export", "motion.receipts.read"]);
    expect(action?.verify).toContain("HTML snippet export receipt includes HTML path, sha256, layer timing metadata, and lossiness diagnostics.");
  });

  it("finds standalone HTML snippet import flows from HyperFrames-style wording", () => {
    const action = findAction("import hyperframes html snippet");

    expect(action?.id).toBe("motion.html.snippet.import");
    expect(action?.permission).toBe("write_local");
    expect(action?.mutates).toBe(true);
    expect(action?.calls).toEqual(["motion.html.snippet.import", "motion.receipts.read"]);
    expect(action?.verify).toContain("HTML snippet import receipt includes package path, validated layer timing, staged local asset digests, and discarded HTML/CSS feature diagnostics.");
  });

  it("finds OTIO editorial interchange flows from natural wording", () => {
    const exportAction = findAction("export this timeline as otio for premiere");
    const importAction = findAction("import opentimelineio edit into motion");

    expect(exportAction?.id).toBe("motion.otio.export");
    expect(exportAction?.permission).toBe("write_local");
    expect(exportAction?.mutates).toBe(true);
    expect(exportAction?.calls).toEqual(["motion.otio.export", "motion.receipts.read"]);
    expect(exportAction?.verify).toContain("OTIO export receipt includes timeline path, sha256, track/clip/gap counts, and lossiness diagnostics.");
    expect(importAction?.id).toBe("motion.otio.import");
    expect(importAction?.permission).toBe("write_local");
    expect(importAction?.mutates).toBe(true);
    expect(importAction?.calls).toEqual(["motion.otio.import", "motion.receipts.read"]);
    expect(importAction?.verify).toContain("OTIO import receipt includes package path, layer/track counts, imported assets, and unsupported item warnings.");
  });

  it("finds package archive export flows from natural wording", () => {
    const action = findAction("export portable package archive");

    expect(action?.id).toBe("motion.package.archive");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual(["motion.package.archive", "motion.receipts.read"]);
    expect(action?.verify).toContain("Package archive receipt includes archive path, file count, deterministic hash, and archived package file hashes.");
  });

  it("finds package archive extract flows from natural wording", () => {
    const action = findAction("extract shellxmotion package archive");

    expect(action?.id).toBe("motion.package.extract");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual(["motion.package.extract", "motion.receipts.read"]);
    expect(action?.verify).toContain("Package extract receipt includes package root, extracted file count, archive hash, and validation result.");
  });

  it("finds support bundle export flows from natural wording", () => {
    const action = findAction("collect diagnostics support bundle");

    expect(action?.id).toBe("motion.support.bundle");
    expect(action?.permission).toBe("write_local");
    expect(action?.calls).toEqual(["motion.support.bundle", "motion.receipts.list"]);
    expect(action?.verify).toContain("Support bundle lists diagnostics, receipts, and platform verification summaries without secret material.");
  });

  it("finds platform verification panel flows from natural wording", () => {
    const action = findAction("show linux windows macos host verification");

    expect(action?.id).toBe("motion.platform.verification.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.platform.verification.panel", "motion.receipts.list"]);
    expect(action?.verify).toContain("Platform verification panel returns required hosts, satisfied hosts, missing hosts, failed hosts, and aggregate receipt status.");
  });

  it("finds deterministic browser workflow capture from natural wording", () => {
    const action = findAction("capture browser workflow with replay trace");

    expect(action?.id).toBe("motion.browser.workflow.capture");
    expect(action?.permission).toBe("render_motion");
    expect(action?.mutates).toBe(true);
    expect(action?.calls).toEqual(["motion.browser.workflow.capture", "motion.receipts.read"]);
    expect(action?.verify).toContain("Browser capture receipt includes a redacted per-step workflow trace artifact.");
    expect(action?.verify).toContain("Optional workflow catalog records baseline/latest output hashes and drift status for replay diagnostics.");
  });

  it("finds standalone Canvas package and quality check debug actions from natural wording", () => {
    const canvasPackage = findAction("package this Canvas frame for Motion");
    const qualityPanel = findAction("show quality manifest panel");
    const qualityCheck = findAction("run quality check on rendered video");

    expect(canvasPackage?.id).toBe("motion.canvas.package");
    expect(canvasPackage?.permission).toBe("render_motion");
    expect(canvasPackage?.calls).toEqual(["motion.canvas.package", "motion.receipts.read"]);
    expect(canvasPackage?.verify).toContain("Canvas package receipt includes source frame hash and resource catalog path.");
    expect(qualityPanel?.id).toBe("motion.quality.panel");
    expect(qualityPanel?.permission).toBe("read_motion");
    expect(qualityPanel?.calls).toEqual(["motion.quality.panel"]);
    expect(qualityPanel?.verify).toContain("Quality panel summarizes manifest samples, baselines, regions, audio policy, and quality-check follow-up commands.");
    expect(qualityCheck?.id).toBe("motion.quality.check");
    expect(qualityCheck?.permission).toBe("render_motion");
    expect(qualityCheck?.calls).toEqual(["motion.quality.check", "motion.receipts.read"]);
    expect(qualityCheck?.verify).toContain("Quality check receipt includes representative-frame visual and alpha facts.");
  });

  it("finds batch export preset workflows from natural wording", () => {
    const action = findAction("render CSV rows with WebM export preset");

    expect(action?.id).toBe("motion.render.batch");
    expect(action?.permission).toBe("render_motion");
    expect(action?.mutates).toBe(true);
    expect(action?.calls).toEqual(["motion.render.batch", "motion.render.status", "motion.receipts.read"]);
    expect(action?.verify).toContain("Batch render receipt includes per-row output paths, preset, and statuses.");
    expect(action?.verify).toContain("Render status returns queue-style job state and progress derived from host receipts.");
    expect(action?.verify).toContain("Render status and queue rows expose compact quality-manifest gate status when present.");
  });

  it("finds render queue cancel and retry workflows from natural wording", () => {
    const cancel = findAction("cancel render job");
    const retry = findAction("retry failed render");

    expect(cancel?.id).toBe("motion.render.cancel");
    expect(cancel?.permission).toBe("render_motion");
    expect(cancel?.calls).toEqual(["motion.render.cancel", "motion.render.status", "motion.receipts.read"]);
    expect(cancel?.verify).toContain("Render cancel receipt references the target job and render status marks it cancelled.");
    expect(retry?.id).toBe("motion.render.retry");
    expect(retry?.permission).toBe("render_motion");
    expect(retry?.calls).toEqual(["motion.render.retry", "motion.render.status", "motion.receipts.read"]);
    expect(retry?.verify).toContain("Render retry receipt references the source job and render status exposes the retry as queued.");
  });

  it("finds render queue panel workflows from natural wording", () => {
    const action = findAction("show render queue");

    expect(action?.id).toBe("motion.render.queue");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.render.queue", "motion.receipts.read"]);
    expect(action?.verify).toContain("Render queue panel returns job state, progress, control receipts, and available cancel/retry actions.");
    expect(action?.verify).toContain("Render status and queue rows expose compact quality-manifest gate status when present.");
  });

  it("finds prompt queue cancel and retry workflows from natural wording", () => {
    const queue = findAction("show prompt queue");
    const cancel = findAction("cancel prompt job");
    const retry = findAction("retry failed prompt");

    expect(queue?.id).toBe("motion.prompt.queue");
    expect(queue?.permission).toBe("read_motion");
    expect(queue?.calls).toEqual(["motion.prompt.queue", "motion.agent.transcript", "motion.receipts.read"]);
    expect(queue?.verify).toContain("Prompt queue panel returns local-agent job state, transcript links, and available cancel/retry actions.");
    expect(cancel?.id).toBe("motion.prompt.cancel");
    expect(cancel?.permission).toBe("draft_motion");
    expect(cancel?.calls).toEqual(["motion.prompt.cancel", "motion.prompt.queue", "motion.receipts.read"]);
    expect(cancel?.verify).toContain("Prompt cancel receipt references the target prompt job and prompt queue marks it cancelled.");
    expect(retry?.id).toBe("motion.prompt.retry");
    expect(retry?.permission).toBe("draft_motion");
    expect(retry?.calls).toEqual(["motion.prompt.retry", "motion.prompt.queue", "motion.receipts.read"]);
    expect(retry?.verify).toContain("Prompt retry receipt references the source prompt job and exposes queued prompt-job handoff metadata.");
  });

  it("finds agent transcript panel workflows from natural wording", () => {
    const action = findAction("show agent transcript");

    expect(action?.id).toBe("motion.agent.transcript");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.agent.transcript", "motion.receipts.read"]);
    expect(action?.verify).toContain("Agent transcript digest returns prompt and agent receipt links with redacted transcript messages.");
  });

  it("finds receipt panel workflows from natural wording", () => {
    const action = findAction("show receipt panel");

    expect(action?.id).toBe("motion.receipts.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.receipts.panel", "motion.receipts.read"]);
    expect(action?.verify).toContain("Receipt panel summary returns counts, recent receipts, warnings, failures, and artifact links.");
    expect(action?.verify).toContain("Receipt panel summaries expose compact quality-manifest gate status on relevant receipts.");
  });

  it("finds asset and brand panel workflows from natural wording", () => {
    const assets = findAction("show asset panel");
    const brand = findAction("show brand pack panel");
    const media = findAction("show media readiness panel");

    expect(assets?.id).toBe("motion.assets.panel");
    expect(assets?.permission).toBe("read_motion");
    expect(assets?.calls).toEqual(["motion.assets.panel"]);
    expect(assets?.verify).toContain("Asset panel returns declared assets, layer references, missing assets, hashes, and usage counts.");
    expect(brand?.id).toBe("motion.brand.panel");
    expect(brand?.permission).toBe("read_motion");
    expect(brand?.calls).toEqual(["motion.brand.panel"]);
    expect(brand?.verify).toContain("Brand panel returns design-token groups, color tokens, typography tokens, and source provenance.");
    expect(media?.id).toBe("motion.media.panel");
    expect(media?.permission).toBe("read_motion");
    expect(media?.mutates).toBe(false);
    expect(media?.calls).toEqual(["motion.media.panel"]);
    expect(media?.verify).toContain("Media panel returns image, video, audio, and web layer source readiness, trim/loop/playback controls, and export-preset compatibility warnings.");
  });

  it("finds timeline inspection from natural wording", () => {
    const action = findAction("inspect scenes tracks and timeline markers");

    expect(action?.id).toBe("motion.timeline.inspect");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.timeline.inspect"]);
    expect(action?.verify).toContain("Timeline inspect result includes scenes, tracks, markers, and layer track refs.");
  });

  it("finds timeline panel workflows from natural wording", () => {
    const action = findAction("show timeline panel");

    expect(action?.id).toBe("motion.timeline.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.timeline.panel"]);
    expect(action?.verify).toContain("Timeline panel returns playhead controls, scene and layer rows, markers, tracks, and suggested actions.");
  });

  it("finds keyframe panel workflows from natural wording", () => {
    const action = findAction("show keyframe panel");

    expect(action?.id).toBe("motion.timeline.keyframes.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.timeline.keyframes.panel"]);
    expect(action?.verify).toContain("Keyframe panel returns animated layers, target ranges, easing usage, preset counts, and suggested keyframe actions.");
  });

  it("finds transition panel workflows from natural wording", () => {
    const action = findAction("show timeline transition panel");

    expect(action?.id).toBe("motion.timeline.transitions.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.timeline.transitions.panel"]);
    expect(action?.verify).toContain("Transition panel returns layers with enter/exit transitions, timing windows, easing usage, type counts, and suggested transition actions.");
  });

  it("finds easing panel workflows from natural wording", () => {
    const action = findAction("show timeline easing curves");

    expect(action?.id).toBe("motion.timeline.easing.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.timeline.easing.panel"]);
    expect(action?.verify).toContain("Easing panel returns sampled curves, keyframe and transition usage, custom easing detection, and suggested animation actions.");
  });

  it("finds timeline playhead range and viewport controls from natural wording", () => {
    const playhead = findAction("set timeline playhead to 2 seconds");
    const range = findAction("select timeline range");
    const viewport = findAction("zoom timeline viewport");

    expect(playhead?.id).toBe("motion.timeline.playhead.set");
    expect(playhead?.permission).toBe("draft_motion");
    expect(playhead?.calls).toEqual(["motion.state", "motion.timeline.playhead.set", "motion.receipts.read"]);
    expect(playhead?.verify).toContain("Timeline playhead receipt includes old/new playhead, state path, duration guard, and host receipt evidence.");
    expect(range?.id).toBe("motion.timeline.range.select");
    expect(range?.permission).toBe("draft_motion");
    expect(range?.calls).toEqual(["motion.state", "motion.timeline.range.select", "motion.receipts.read"]);
    expect(range?.verify).toContain("Timeline range receipt includes selected start/end, previous range, state path, and duration guard.");
    expect(viewport?.id).toBe("motion.timeline.viewport.set");
    expect(viewport?.permission).toBe("draft_motion");
    expect(viewport?.calls).toEqual(["motion.state", "motion.timeline.viewport.set", "motion.receipts.read"]);
    expect(viewport?.verify).toContain("Timeline viewport receipt includes start/end, zoom, pixels-per-second, previous viewport, and state path.");
  });

  it("finds typed timeline scene resize edits from natural wording", () => {
    const action = findAction("resize intro scene duration with ripple");

    expect(action?.id).toBe("motion.timeline.scene.resize");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.scene.resize", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline scene resize receipt includes scene id, old/new duration, ripple flag, shifted scenes/layers/markers, changed paths, and validation result.");
  });

  it("finds typed timeline scene creation edits from natural wording", () => {
    const action = findAction("add storyboard scene");

    expect(action?.id).toBe("motion.timeline.scene.create");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.scene.create", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline scene create receipt includes scene id, timing, optional layer/track/marker refs, changed paths, scene counts, duration evidence, and validation result.");
  });

  it("finds typed timeline scene delete edits from natural wording", () => {
    const action = findAction("remove storyboard scene");

    expect(action?.id).toBe("motion.timeline.scene.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.scene.delete", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline scene delete receipt includes scene id, removed scene, changed paths, scene counts, non-destructive duration evidence, and validation result.");
  });

  it("finds typed timeline scene reorder edits from natural wording", () => {
    const action = findAction("reorder storyboard scene");

    expect(action?.id).toBe("motion.timeline.scene.reorder");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.scene.reorder", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline scene reorder receipt includes scene id, old/new index, old/new scene order, changed paths, non-destructive duration evidence, and validation result.");
  });

  it("finds typed timeline scene display-name edits from natural wording", () => {
    const action = findAction("rename selected scene");

    expect(action?.id).toBe("motion.timeline.scene.name.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.scene.name.set", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline scene name receipt includes scene id, old/new display name, changed paths, action, and validation result.");
  });

  it("finds timeline duration policy workflows from natural wording", () => {
    const read = findAction("show protected intro outro regions");
    const write = findAction("set protected intro outro duration policy");

    expect(read?.id).toBe("motion.timeline.duration.policy");
    expect(read?.permission).toBe("read_motion");
    expect(read?.calls).toEqual(["motion.timeline.duration.policy"]);
    expect(read?.verify).toContain("Duration policy read returns min/max duration, resize mode, protected regions, and package duration.");
    expect(write?.id).toBe("motion.timeline.duration.policy.set");
    expect(write?.permission).toBe("edit_motion");
    expect(write?.calls).toEqual(["motion.state", "motion.timeline.duration.policy.set", "motion.timeline.duration.policy", "motion.receipts.read"]);
    expect(write?.verify).toContain("Duration policy receipt includes protected regions, min/max duration, resize mode, changed path, and validation result.");
  });

  it("finds typed timeline keyframe edits from natural wording", () => {
    const action = findAction("add opacity keyframe with ease out");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe receipt includes layer id, target, timestamp, easing, changed path, target-specific value validation, and validation result.");
  });

  it("finds typed visual effect keyframe edits from natural wording", () => {
    const action = findAction("animate blur effect");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds typed effect and playback-rate keyframe edits from adjacent wording", () => {
    const effect = findAction("keyframe visual effect");
    const playback = findAction("keyframe playback rate");

    expect(effect?.id).toBe("motion.timeline.keyframe.upsert");
    expect(playback?.id).toBe("motion.timeline.keyframe.upsert");
  });

  it("finds typed color keyframe edits from natural wording", () => {
    const action = findAction("animate title color keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds typed mask crop keyframe edits from natural wording", () => {
    const action = findAction("animate mask crop keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.aliases).toContain("animate mask crop keyframes");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds typed image crop keyframe edits from natural wording", () => {
    const action = findAction("animate image crop keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.aliases).toContain("animate image crop keyframes");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds typed video crop keyframe edits from natural wording", () => {
    const action = findAction("animate video crop keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.upsert");
    expect(action?.aliases).toContain("animate video crop keyframes");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"]);
  });

  it("finds typed timeline marker edits from natural wording", () => {
    const action = findAction("add timeline marker at playhead");

    expect(action?.id).toBe("motion.timeline.marker.upsert");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.marker.upsert", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline marker receipt includes marker id, timestamp, changed paths, scene ref updates, and validation result.");
  });

  it("keeps read-only marker wording on timeline inspection", () => {
    const action = findAction("show timeline marker");

    expect(action?.id).toBe("motion.timeline.inspect");
    expect(action?.mutates).toBe(false);
  });

  it("keeps marker edit wording on marker upsert even when preview is requested", () => {
    const action = findAction("add marker and preview it");

    expect(action?.id).toBe("motion.timeline.marker.upsert");
    expect(action?.mutates).toBe(true);
  });

  it("keeps marker change wording on marker upsert even when preview is requested", () => {
    const action = findAction("change marker and preview it");

    expect(action?.id).toBe("motion.timeline.marker.upsert");
    expect(action?.mutates).toBe(true);
  });

  it.each([
    "update marker and preview it",
    "update marker label and preview it",
    "edit marker and preview it",
    "move marker and preview it",
    "modify marker and preview it"
  ])("keeps marker edit wording on marker upsert for %s", (request) => {
    const action = findAction(request);

    expect(action?.id).toBe("motion.timeline.marker.upsert");
    expect(action?.mutates).toBe(true);
  });

  it("finds typed timeline marker deletes from natural wording", () => {
    const action = findAction("delete timeline marker at playhead");

    expect(action?.id).toBe("motion.timeline.marker.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.marker.delete", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline marker delete receipt includes marker id, removed marker, changed paths, removed scene refs, and validation result.");
  });

  it("finds typed timeline keyframe deletes from natural wording", () => {
    const action = findAction("delete opacity keyframe at playhead");

    expect(action?.id).toBe("motion.timeline.keyframe.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.delete", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe delete receipt includes layer id, target, timestamp, removed value, changed path, and validation result.");
  });

  it("finds typed timeline keyframe moves from natural wording", () => {
    const action = findAction("move opacity keyframe");

    expect(action?.id).toBe("motion.timeline.keyframe.move");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.move", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe move receipt includes layer id, target, old/new timestamps, moved keyframe value/easing, changed paths, and validation result.");
  });

  it("finds typed keyframe easing apply from natural wording", () => {
    const action = findAction("apply ease in out to selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.easing.apply");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.easing.apply", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe easing apply receipt includes layer id, target, easing preset, affected timestamp range, changed paths, updated count, and validation result.");
  });

  it("finds typed keyframe range shifts from natural wording", () => {
    const action = findAction("nudge selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.shift");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.shift", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe shift receipt includes layer id, target, delta, affected timestamp range, shifted keyframes, changed paths, and validation result.");
  });

  it("finds typed keyframe range scales from natural wording", () => {
    const action = findAction("stretch selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.scale");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.scale", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe scale receipt includes layer id, target, scale factor, origin, affected timestamp range, scaled keyframes, changed paths, and validation result.");
  });

  it("finds typed keyframe range duplicates from natural wording", () => {
    const action = findAction("duplicate selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.duplicate");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.duplicate", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe duplicate receipt includes layer id, target, delta, affected timestamp range, duplicated keyframes, changed paths, and validation result.");
  });

  it("finds typed keyframe distributions from natural wording", () => {
    const action = findAction("distribute keyframes evenly");

    expect(action?.id).toBe("motion.timeline.keyframe.distribute");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.distribute", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe distribute receipt includes layer id, target, affected timestamp range, spacing, distributed keyframes, changed paths, and validation result.");
  });

  it("finds typed keyframe range deletes from natural wording", () => {
    const action = findAction("delete selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.range.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.range.delete", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe range delete receipt includes layer id, target, affected timestamp range, removed keyframes, changed paths, remaining count, and validation result.");
  });

  it("finds typed keyframe range reverses from natural wording", () => {
    const action = findAction("reverse selected keyframes");

    expect(action?.id).toBe("motion.timeline.keyframe.reverse");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.reverse", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe reverse receipt includes layer id, target, affected timestamp range, reversed keyframes, changed paths, and validation result.");
  });

  it("finds typed keyframe frame snaps from natural wording", () => {
    const action = findAction("snap selected keyframes to frames");

    expect(action?.id).toBe("motion.timeline.keyframe.snap");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.keyframe.snap", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline keyframe snap receipt includes layer id, target, fps, snap mode, affected timestamp range, snapped keyframes, changed paths, and validation result.");
  });

  it("finds easing preset discovery from natural wording", () => {
    const action = findAction("show easing presets");

    expect(action?.id).toBe("motion.timeline.easing.presets");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.timeline.easing.presets"]);
    expect(action?.verify).toContain("Easing preset response includes named and cubic-bezier presets usable by keyframes and transitions.");
  });

  it("finds animation preset discovery and apply edits from natural wording", () => {
    const discovery = findAction("show animation presets");
    const apply = findAction("apply lower third entrance animation");
    const staggeredApply = findAction("stagger title and subtitle entrance animation");

    expect(discovery?.id).toBe("motion.timeline.animation.presets");
    expect(discovery?.permission).toBe("read_motion");
    expect(discovery?.calls).toEqual(["motion.timeline.animation.presets"]);
    expect(discovery?.verify).toContain("Animation preset response includes entrance and exit presets with target keyframe coverage.");
    expect(apply?.id).toBe("motion.timeline.animation.preset.apply");
    expect(apply?.permission).toBe("edit_motion");
    expect(apply?.calls).toEqual(["motion.state", "motion.timeline.animation.preset.apply", "motion.preview.frame", "motion.receipts.read"]);
    expect(apply?.verify).toContain("Animation preset apply receipt includes layer id or layer ids, preset id, timing or staggered per-layer timings, affected targets, changed paths, validation result, and preview evidence.");
    expect(staggeredApply?.id).toBe("motion.timeline.animation.preset.apply");
  });

  it("keeps title entrance animation prompts on the typed animation preset lane", () => {
    const plan = planAction("make the title slide in and preview it");

    expect(plan.action?.id).toBe("motion.timeline.animation.preset.apply");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.state",
      "motion.timeline.animation.preset.apply",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect(plan.verify).toContain("Animation preset apply receipt includes layer id or layer ids, preset id, timing or staggered per-layer timings, affected targets, changed paths, validation result, and preview evidence.");
  });

  it("finds typed timeline layer trim edits from natural wording", () => {
    const action = findAction("trim selected layer duration");

    expect(action?.id).toBe("motion.timeline.layer.trim");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.trim", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer trim receipt includes layer id, old timing, new timing, changed paths, and validation result.");
  });

  it("finds typed timeline layer creates from natural wording", () => {
    const action = findAction("add a text layer to the timeline");

    expect(action?.id).toBe("motion.timeline.layer.create");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.create", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer create receipt includes layer id, stack index, optional track ref, changed paths, inserted track refs, and validation result.");
  });

  it("finds typed timeline layer split edits from natural wording", () => {
    const action = findAction("split clip at playhead");

    expect(action?.id).toBe("motion.timeline.layer.split");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.split", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer split receipt includes original layer id, new layer id, split timestamp, segment timings, changed paths, track order updates, and validation result.");
  });

  it("finds typed timeline layer text edits from natural wording", () => {
    const action = findAction("change title text");

    expect(action?.id).toBe("motion.timeline.layer.text.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.text.set", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer text receipt includes layer id, old/new text, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer style edits from natural wording", () => {
    const action = findAction("change title color");

    expect(action?.id).toBe("motion.timeline.layer.style.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.style.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer style receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer transform edits from natural wording", () => {
    const action = findAction("move layer");

    expect(action?.id).toBe("motion.timeline.layer.transform.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.transform.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer transform receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer effect edits from natural wording", () => {
    const action = findAction("blur layer");

    expect(action?.id).toBe("motion.timeline.layer.effect.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.effect.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer effect receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer blend edits from natural wording", () => {
    const action = findAction("set layer blend mode");

    expect(action?.id).toBe("motion.timeline.layer.blend.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.blend.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer blend receipt includes layer id, old/new blend mode, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer crop edits from natural wording", () => {
    const action = findAction("crop image layer");

    expect(action?.id).toBe("motion.timeline.layer.crop.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.crop.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer crop receipt includes layer id, old/new crop rectangles, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer mask edits from natural wording", () => {
    const action = findAction("mask layer");

    expect(action?.id).toBe("motion.timeline.layer.mask.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.mask.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer mask receipt includes layer id, old/new mask shapes, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer fit edits from natural wording", () => {
    const action = findAction("fit image layer");

    expect(action?.id).toBe("motion.timeline.layer.fit.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.fit.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer fit receipt includes layer id, old/new media fit, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer media source edits from natural wording", () => {
    const action = findAction("set layer media source");

    expect(action?.id).toBe("motion.timeline.layer.media.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.media.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer media receipt includes layer id, old/new source refs, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer display-name edits from natural wording", () => {
    const action = findAction("rename selected layer");

    expect(action?.id).toBe("motion.timeline.layer.name.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.name.set", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer name receipt includes layer id, old/new display name, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer visibility edits from natural wording", () => {
    const action = findAction("hide layer");

    expect(action?.id).toBe("motion.timeline.layer.visibility.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.visibility.set", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer visibility receipt includes layer id, old/new visibility, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer lock edits from natural wording", () => {
    const action = findAction("lock selected layer");

    expect(action?.id).toBe("motion.timeline.layer.lock");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.lock", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer lock receipt includes layer id, old/new lock state, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer deletes from natural wording", () => {
    const action = findAction("delete selected layer from timeline");

    expect(action?.id).toBe("motion.timeline.layer.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.delete", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer delete receipt includes layer id, removed layer, changed paths, removed track refs, remaining count, and validation result.");
  });

  it("finds typed timeline layer duplicates from natural wording", () => {
    const action = findAction("duplicate selected layer on timeline");

    expect(action?.id).toBe("motion.timeline.layer.duplicate");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.duplicate", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer duplicate receipt includes source layer id, new layer id, offset, changed paths, inserted track refs, and validation result.");
  });

  it("finds typed timeline layer stack reorders from natural wording", () => {
    const action = findAction("bring selected layer forward");

    expect(action?.id).toBe("motion.timeline.layer.reorder");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.reorder", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer reorder receipt includes layer id, old/new stack indexes, changed paths, reordered track refs, and validation result.");
  });

  it("finds typed timeline cleanup from natural wording", () => {
    const action = findAction("clean up stale timeline refs");

    expect(action?.id).toBe("motion.timeline.cleanup");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.cleanup", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline cleanup receipt includes removed stale refs, duplicate refs, duration change, changed paths, and validation result.");
  });

  it("finds typed timeline track creates from natural wording", () => {
    const action = findAction("create an overlay track");

    expect(action?.id).toBe("motion.timeline.track.create");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.create", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track create receipt includes track id, stack index, attached layer ids, changed paths, and validation result.");
  });

  it("finds typed timeline track reorders from natural wording", () => {
    const action = findAction("move music track to top");

    expect(action?.id).toBe("motion.timeline.track.reorder");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.reorder", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track reorder receipt includes track id, old/new stack indexes, old/new track order, changed paths, and validation result.");
  });

  it("finds typed timeline track deletes from natural wording", () => {
    const action = findAction("delete timeline track");

    expect(action?.id).toBe("motion.timeline.track.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.delete", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track delete receipt includes track id, removed track, detached layer ids, removed scene refs, changed paths, and validation result.");
  });

  it("finds typed timeline track renames from natural wording", () => {
    const action = findAction("rename timeline track");

    expect(action?.id).toBe("motion.timeline.track.rename");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.rename", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track rename receipt includes track id, old/new name, changed paths, action, and validation result.");
  });

  it("finds typed timeline track lock edits from natural wording", () => {
    const action = findAction("lock selected timeline track");

    expect(action?.id).toBe("motion.timeline.track.lock");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.lock", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track lock receipt includes track id, old/new lock state, changed paths, action, and validation result.");
  });

  it("finds typed timeline track mute edits from natural wording", () => {
    const action = findAction("mute music track");

    expect(action?.id).toBe("motion.timeline.track.mute");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.mute", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track mute receipt includes track id, old/new mute state, changed paths, action, and validation result.");
  });

  it("finds typed timeline track solo edits from natural wording", () => {
    const action = findAction("solo music track");

    expect(action?.id).toBe("motion.timeline.track.solo");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.solo", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track solo receipt includes track id, old/new solo state, changed paths, action, and validation result.");
  });

  it("finds typed timeline track volume edits from natural wording", () => {
    const action = findAction("set music track volume");

    expect(action?.id).toBe("motion.timeline.track.volume");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.volume", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track volume receipt includes track id, old/new volume, changed paths, action, and validation result.");
  });

  it("finds typed timeline track fade edits from natural wording", () => {
    const action = findAction("set music track fade in and fade out");

    expect(action?.id).toBe("motion.timeline.track.fade");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.fade", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track fade receipt includes track id, old/new fade values, changed paths, action, and validation result.");
  });

  it("finds typed timeline track pan edits from natural wording", () => {
    const action = findAction("pan music track left");

    expect(action?.id).toBe("motion.timeline.track.pan");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.track.pan", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline track pan receipt includes track id, old/new pan values, changed paths, action, and validation result.");
  });

  it("finds typed timeline layer ducking edits from natural wording", () => {
    const action = findAction("duck music under voice");

    expect(action?.id).toBe("motion.timeline.layer.ducking.set");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.ducking.set", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer ducking receipt includes layer id, trigger layer ids, old/new ducking controls, changed paths, action, and validation result.");
  });

  it("finds audio mix panel workflows from natural wording", () => {
    const action = findAction("show audio mix panel");

    expect(action?.id).toBe("motion.audio.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.audio.panel"]);
    expect(action?.verify).toContain("Audio panel returns resolved audio inputs, automation counts, track controls, ducking, and export-preset compatibility warnings.");
  });

  it("finds typed timeline layer track assignments from natural wording", () => {
    const action = findAction("move selected layer to captions track");

    expect(action?.id).toBe("motion.timeline.layer.track.assign");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.layer.track.assign", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline layer track assignment receipt includes layer id, old/new track ids, order indexes, changed paths, removed source track refs, and validation result.");
  });

  it("finds typed timeline caption import and upsert flows", () => {
    const importAction = findAction("import captions from srt");
    const upsertAction = findAction("edit caption at playhead");

    expect(importAction?.id).toBe("motion.timeline.caption.import");
    expect(importAction?.permission).toBe("edit_motion");
    expect(importAction?.calls).toEqual(["motion.state", "motion.timeline.caption.import", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(importAction?.verify).toContain("Caption import receipt includes source format, cue count, inserted layer ids, track refs, changed paths, and validation result.");
    expect(upsertAction?.id).toBe("motion.timeline.caption.upsert");
    expect(upsertAction?.permission).toBe("edit_motion");
    expect(upsertAction?.calls).toEqual(["motion.state", "motion.timeline.caption.upsert", "motion.timeline.inspect", "motion.receipts.read"]);
    expect(upsertAction?.verify).toContain("Caption upsert receipt includes layer id, timing, text, track ref, changed paths, and validation result.");
  });

  it("finds typed timeline transition edits from natural wording", () => {
    const action = findAction("add slide transition with ease out");

    expect(action?.id).toBe("motion.timeline.transition.upsert");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.transition.upsert", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline transition receipt includes layer id, edge, transition type, duration, easing, changed path, and validation result.");
  });

  it("finds typed timeline transition deletes from natural wording", () => {
    const action = findAction("delete transition at playhead");

    expect(action?.id).toBe("motion.timeline.transition.delete");
    expect(action?.permission).toBe("edit_motion");
    expect(action?.calls).toEqual(["motion.state", "motion.timeline.transition.delete", "motion.preview.frame", "motion.receipts.read"]);
    expect(action?.verify).toContain("Timeline transition delete receipt includes layer id, edge, removed transition, changed path, and validation result.");
  });

  it("finds export preset discovery from natural wording", () => {
    const action = findAction("show export presets and formats");

    expect(action?.id).toBe("motion.export.presets");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.export.presets"]);
    expect(action?.verify).toContain("Export preset response includes extensions, MIME types, codec choices, and audio/alpha support.");
  });

  it("finds export panel workflows from natural wording", () => {
    const action = findAction("show export panel");

    expect(action?.id).toBe("motion.export.panel");
    expect(action?.permission).toBe("read_motion");
    expect(action?.calls).toEqual(["motion.export.panel"]);
    expect(action?.verify).toContain("Export panel groups presets with recommendations, badges, and suggested render arguments.");
  });

  it("finds export planning workflows from natural wording", () => {
    const action = findAction("plan transparent overlay export with quality gates");

    expect(action?.id).toBe("motion.export.plan");
    expect(action?.permission).toBe("read_motion");
    expect(action?.mutates).toBe(false);
    expect(action?.calls).toEqual(["motion.export.plan"]);
    expect(action?.verify).toContain("Export plan explains preset choice, audio/alpha feature impact, deterministic capture preflight, quality gates, platform verification, and render follow-up arguments.");
  });

  it("returns ordered runbook guidance before mutation", () => {
    const plan = planAction("make the title blue and preview it");

    expect(plan.ok).toBe(true);
    expect(plan.action?.id).toBe("motion.timeline.layer.style.set");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.state",
      "motion.timeline.layer.style.set",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
    expect(plan.verify).toContain("Timeline layer style receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
    expect(plan.verify).toContain("Preview receipt includes output frame hash.");
  });

  it("keeps matched typed timeline actions when planning an edit and preview", () => {
    const plan = planAction("change transition easing and preview it");

    expect(plan.action?.id).toBe("motion.timeline.transition.upsert");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.state",
      "motion.timeline.transition.upsert",
      "motion.preview.frame",
      "motion.receipts.read"
    ]);
  });

  it("keeps browser workflow action verification in prompt plans", () => {
    const plan = planAction("capture browser workflow with replay trace");

    expect(plan.action?.id).toBe("motion.browser.workflow.capture");
    expect(plan.verify).toEqual(expect.arrayContaining([
      "Browser capture receipt includes a redacted per-step workflow trace artifact.",
      "Workflow trace omits typed text while preserving step status and selectors.",
      "Optional workflow catalog records baseline/latest output hashes and drift status for replay diagnostics."
    ]));
  });

  it("keeps batch render action verification in prompt plans", () => {
    const plan = planAction("render CSV rows with WebM export preset");

    expect(plan.action?.id).toBe("motion.render.batch");
    expect(plan.verify).toEqual(expect.arrayContaining([
      "Batch render receipt includes per-row output paths, preset, and statuses.",
      "Each row render receipt includes final media facts for the selected preset.",
      "Render status returns queue-style job state and progress derived from host receipts."
    ]));
  });

  it("keeps Cut Generate plans on the script-to-Cut connector lane", () => {
    const plan = planAction("apply Cut Generate scripted video to Cut timeline");

    expect(plan.action?.id).toBe("motion.connector.cut_generate_to_cut");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.connector.cut_generate_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
    expect(plan.verify).toEqual(expect.arrayContaining([
      "Cut Generate connector receipt includes script, render, quality, and Cut import plan evidence.",
      "Quality check receipt includes representative-frame visual and alpha facts."
    ]));
  });

  it("describes Cut Generate verification through the connector receipt", () => {
    const action = findAction("apply Cut Generate scripted video to Cut timeline");

    expect(action?.id).toBe("motion.connector.cut_generate_to_cut");
    expect(action?.verify).toContain("Cut Generate connector receipt includes script, render, quality, and Cut import plan evidence.");
    expect(action?.verify).not.toContain("Script compile receipt includes source storyboard hash.");
  });

  it("keeps generic scripted-video plans on the Script-to-Cut connector lane", () => {
    const plan = planAction("send scripted video JSON to Cut without Canvas");

    expect(plan.action?.id).toBe("motion.connector.script_to_cut");
    expect(plan.steps.map((step) => step.call)).toEqual([
      "motion.connector.script_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ]);
    expect(plan.verify).toEqual(expect.arrayContaining([
      "Script-to-Cut connector receipt includes script, render, quality, and Cut import plan evidence.",
      "Quality check receipt includes representative-frame visual and alpha facts."
    ]));
  });

  it("covers visible surfaces with debug commands", () => {
    const coverage = actionCoverage(["packages", "timeline", "templateInspector", "preview", "receipts", "assets", "brand", "prompt"]);

    expect(coverage.uncovered).toEqual([]);
  });

  it("maps all required first-slice debug commands to visible surfaces", () => {
    const coverage = actionCoverage(["packages", "timeline", "templateInspector", "preview", "receipts", "assets", "brand", "prompt"]);

    expect(coverage.commands).toEqual(expect.arrayContaining([
      "motion.script.compile",
      "motion.actions.panel",
      "motion.packages.browse",
      "motion.preview.panel",
      "motion.preview.playhead",
      "motion.preview.strip",
      "motion.agent.transcript",
      "motion.prompt.queue",
      "motion.prompt.cancel",
      "motion.prompt.retry",
      "motion.receipts.panel",
      "motion.assets.panel",
      "motion.brand.panel",
      "motion.render.queue",
      "motion.render.cancel",
      "motion.render.retry",
      "motion.render.status",
      "motion.canvas.package",
      "motion.connector.canvas_to_cut",
      "motion.connector.script_to_cut",
      "motion.connector.source_to_cut",
      "motion.connector.cut_generate_to_cut",
      "motion.connector.template_to_cut",
      "motion.template.catalog",
      "motion.template.plan",
      "motion.template.panel",
      "motion.template.controls",
      "motion.template.apply",
      "motion.template.media.replace",
      "motion.browser.workflow.capture",
      "motion.render.batch",
      "motion.timeline.panel",
      "motion.timeline.inspect",
      "motion.timeline.playhead.set",
      "motion.timeline.range.select",
      "motion.timeline.viewport.set",
      "motion.timeline.scene.create",
      "motion.timeline.scene.resize",
      "motion.timeline.scene.name.set",
      "motion.timeline.keyframe.upsert",
      "motion.timeline.keyframe.delete",
      "motion.timeline.keyframe.move",
      "motion.timeline.keyframe.easing.apply",
      "motion.timeline.keyframe.shift",
      "motion.timeline.keyframe.scale",
      "motion.timeline.keyframe.duplicate",
      "motion.timeline.keyframe.distribute",
      "motion.timeline.keyframe.range.delete",
      "motion.timeline.keyframe.reverse",
      "motion.timeline.keyframe.snap",
      "motion.timeline.easing.panel",
      "motion.timeline.easing.presets",
      "motion.timeline.animation.presets",
      "motion.timeline.animation.preset.apply",
      "motion.timeline.layer.trim",
      "motion.timeline.layer.split",
      "motion.timeline.layer.transform.set",
      "motion.timeline.layer.effect.set",
      "motion.timeline.layer.rich.set",
      "motion.timeline.layer.blend.set",
      "motion.timeline.layer.crop.set",
      "motion.timeline.layer.mask.set",
      "motion.timeline.layer.fit.set",
      "motion.timeline.layer.media.set",
      "motion.timeline.layer.name.set",
      "motion.timeline.layer.visibility.set",
      "motion.timeline.layer.lock",
      "motion.timeline.layer.delete",
      "motion.timeline.layer.duplicate",
      "motion.timeline.layer.reorder",
      "motion.timeline.cleanup",
      "motion.timeline.track.lock",
      "motion.timeline.track.mute",
      "motion.timeline.track.solo",
      "motion.timeline.track.volume",
      "motion.timeline.track.fade",
      "motion.timeline.track.pan",
      "motion.timeline.layer.ducking.set",
      "motion.timeline.layer.track.assign",
      "motion.timeline.caption.import",
      "motion.timeline.caption.upsert",
      "motion.timeline.transition.upsert",
      "motion.timeline.transition.delete",
      "motion.export.presets",
      "motion.export.panel",
      "motion.export.plan",
      "motion.package.archive",
      "motion.package.extract",
      "motion.html.snippet.export",
      "motion.html.snippet.import",
      "motion.review.html.bundle",
      "motion.support.bundle"
    ]));
  });

  it("keeps debug coverage fixture in sync with visible surface commands", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/debug/coverage.expected.json", import.meta.url), "utf8")) as {
      visibleSurfaces: string[];
      requiredCommands: string[];
    };
    const coverage = actionCoverage(fixture.visibleSurfaces);

    expect(fixture.requiredCommands).toEqual(expect.arrayContaining(coverage.commands));
    expect(coverage.commands).toEqual(expect.arrayContaining(fixture.requiredCommands));
  });
});
