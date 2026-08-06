/**
 * The falsifier for panels that counted stored keyframes as animation, kept permanently.
 *
 * ca8ee4c fixed the two panels dedicated to keyframes (`motion.timeline.keyframes.panel` and
 * `motion.timeline.easing.panel`). It left the panels an author reaches for FIRST:
 *
 *   - `motion.timeline.panel` and `motion.preview.panel` counted `keyframedLayers` as "layers with
 *     any keyframe TARGET". That is a statement about the document's shape, not about whether
 *     anything moves: the ca8ee4c package, frozen for ~90% of its duration, was reported as fully
 *     keyframed.
 *   - `motion.audio.panel` reported `volumeAutomationKeyframeCount` as the STORED track length. The
 *     encoder's reader is all-or-nothing — one unreadable entry drops the whole envelope and the
 *     input encodes flat — so the panel said "your fade is set up" about audio that will not fade.
 *
 * A shipped package can no longer carry unreadable keyframes; an IN-PROGRESS one being authored
 * can, and these panels are exactly what an author opens to find out why nothing moves.
 *
 * Both directions are pinned: the broken package is counted honestly and warned about once, and a
 * healthy package produces the identical counts it produced before, with no warning and no new key.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The shape the external agent produced: `t`/`v` where the schema says `atMs`/`value`. */
const UNREADABLE_KEYFRAMES = {
  opacity: [{ t: 0, v: 0 }, { t: 600, v: 1 }],
  "transform.x": [{ t: 0, v: -80 }, { t: 700, v: 40 }]
};

const READABLE_KEYFRAMES = {
  opacity: [{ atMs: 0, value: 0 }, { atMs: 600, value: 1 }],
  "transform.x": [{ atMs: 0, value: -80 }, { atMs: 700, value: 40 }]
};

/** A two-layer package: one layer carries the supplied keyframes, one carries none. */
async function writePackage(keyframes: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keyframe-panel-counts-"));
  roots.push(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_keyframe_panel_counts",
    name: "Keyframe Panel Counts Probe",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser"], hosts: ["motion"] }
  }, null, 2), "utf8");
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_keyframe_panel_counts",
    name: "Keyframe Panel Counts Probe",
    durationMs: 2000,
    fps: 30,
    width: 640,
    height: 360,
    background: "#101820",
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [
      {
        id: "panel",
        type: "shape",
        shape: "rectangle",
        fill: "#172033",
        startMs: 0,
        durationMs: 2000,
        width: 320,
        height: 120,
        transform: { x: 40, y: 100, scale: 1, rotation: 0 },
        keyframes
      },
      {
        id: "backdrop",
        type: "shape",
        shape: "rectangle",
        fill: "#0b1220",
        startMs: 0,
        durationMs: 2000,
        width: 640,
        height: 360,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 }
      }
    ]
  }, null, 2), "utf8");
  return root;
}

/** An audio package whose one input carries the supplied volume and pan automation tracks. */
async function writeAudioPackage(volume: unknown[], pan: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-audio-panel-counts-"));
  roots.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "music.wav"), "fake music wav", "utf8");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    schema: "shellx-motion/package-manifest@1",
    id: "pkg_audio_panel_counts",
    name: "Audio Panel Counts Probe",
    motion: "motion.json",
    assets: ["assets/music.wav"],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["ffmpeg"], hosts: ["motion"] }
  }, null, 2), "utf8");
  await writeFile(join(root, "motion.json"), JSON.stringify({
    schema: "shellx-motion/motion@1",
    id: "motion_audio_panel_counts",
    name: "Audio Panel Counts Probe",
    durationMs: 2400,
    fps: 30,
    width: 640,
    height: 360,
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [{
      id: "music",
      type: "audio",
      source: "assets/music.wav",
      startMs: 0,
      durationMs: 2400,
      volume: 0.8,
      keyframes: { volume, pan }
    }]
  }, null, 2), "utf8");
  return root;
}

describe("motion.timeline.panel counts what animates", () => {
  it("does not count a layer whose keyframes cannot be read as keyframed", async () => {
    const packageRoot = await writePackage(UNREADABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.timeline.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.result as Record<string, unknown>;
    const counts = body.counts as Record<string, number>;
    // Previously keyframedLayers: 1 — one layer had targets, so the panel called the piece animated.
    expect(counts.keyframedLayers).toBe(0);
    expect(counts.unreadableKeyframes).toBe(4);
    const layers = body.layers as Array<Record<string, unknown>>;
    expect(layers[0]).toMatchObject({ id: "panel", unreadableKeyframeCount: 4 });
    // The stored targets are still reported: the panel says what is there AND what runs.
    expect(layers[0].keyframeTargets).toEqual(["opacity", "transform.x"]);
    expect(layers[1]).not.toHaveProperty("unreadableKeyframeCount");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("4 keyframes on 1 layer cannot be read by the timeline evaluator");
    expect(result.warnings[0]).toContain("{ atMs, value }");
  });

  it("counts a healthy package exactly as before, with no warning and no new key", async () => {
    const packageRoot = await writePackage(READABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.timeline.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.result as Record<string, unknown>;
    const counts = body.counts as Record<string, number>;
    expect(counts.keyframedLayers).toBe(1);
    expect(counts).not.toHaveProperty("unreadableKeyframes");
    const layers = body.layers as Array<Record<string, unknown>>;
    expect(layers.every((layer) => !("unreadableKeyframeCount" in layer))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("says nothing about a package with no keyframes at all", async () => {
    const packageRoot = await writePackage({});

    const result = await dispatchDebugCommand("motion.timeline.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = (result.result as Record<string, unknown>).counts as Record<string, number>;
    expect(counts.keyframedLayers).toBe(0);
    expect(counts).not.toHaveProperty("unreadableKeyframes");
    expect(result.warnings).toEqual([]);
  });
});

describe("motion.preview.panel counts what animates", () => {
  it("reports the same keyframe counts as the timeline panel", async () => {
    const packageRoot = await writePackage(UNREADABLE_KEYFRAMES);

    const preview = await dispatchDebugCommand("motion.preview.panel", { packageRoot }, { tier: "read_motion" });
    const timeline = await dispatchDebugCommand("motion.timeline.panel", { packageRoot }, { tier: "read_motion" });

    expect(preview.ok && timeline.ok).toBe(true);
    if (!preview.ok || !timeline.ok) return;
    const previewCounts = (preview.result as Record<string, unknown>).counts as Record<string, number>;
    const timelineCounts = (timeline.result as Record<string, unknown>).counts as Record<string, number>;
    expect(previewCounts.keyframedLayers).toBe(timelineCounts.keyframedLayers);
    expect(previewCounts.unreadableKeyframes).toBe(timelineCounts.unreadableKeyframes);
    expect(preview.warnings).toHaveLength(1);
  });

  it("leaves a healthy package's preview panel untouched", async () => {
    const packageRoot = await writePackage(READABLE_KEYFRAMES);

    const result = await dispatchDebugCommand("motion.preview.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = (result.result as Record<string, unknown>).counts as Record<string, number>;
    expect(counts.keyframedLayers).toBe(1);
    expect(counts).not.toHaveProperty("unreadableKeyframes");
    expect(result.warnings).toEqual([]);
  });
});

describe("motion.audio.panel counts automation the encoder will apply", () => {
  it("reports zero for an envelope the encoder drops whole", async () => {
    const packageRoot = await writeAudioPackage(
      [{ atMs: 0, value: 0 }, { t: 1200, v: 1 }, { atMs: 2400, value: 1 }],
      [{ atMs: 0, value: -0.4 }, { atMs: 2400, value: 0.2 }]
    );

    const result = await dispatchDebugCommand("motion.audio.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.result as Record<string, unknown>;
    const counts = body.counts as Record<string, number>;
    // Previously 3: the stored length. The encoder applies none of them — readNumericKeyframes is
    // all-or-nothing, so one bad entry means the input encodes at a flat volume.
    expect(counts.volumeAutomationKeyframes).toBe(0);
    expect(counts.panAutomationKeyframes).toBe(2);
    expect(counts.unreadableAutomationKeyframes).toBe(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("3 audio automation keyframes on 1 input cannot be read by the encoder");
  });

  it("reports zero for a pan envelope whose values leave -1..1, which the encoder also drops", async () => {
    const packageRoot = await writeAudioPackage(
      [{ atMs: 0, value: 0 }, { atMs: 2400, value: 1 }],
      [{ atMs: 0, value: -0.4 }, { atMs: 2400, value: 4 }]
    );

    const result = await dispatchDebugCommand("motion.audio.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const counts = (result.result as Record<string, unknown>).counts as Record<string, number>;
    expect(counts.volumeAutomationKeyframes).toBe(2);
    expect(counts.panAutomationKeyframes).toBe(0);
    expect(counts.unreadableAutomationKeyframes).toBe(2);
  });

  it("counts a healthy mix exactly as before, with no warning and no new key", async () => {
    const packageRoot = await writeAudioPackage(
      [{ atMs: 0, value: 0 }, { atMs: 1200, value: 1 }, { atMs: 2400, value: 1 }],
      [{ atMs: 0, value: -0.4 }, { atMs: 2400, value: 0.2 }]
    );

    const result = await dispatchDebugCommand("motion.audio.panel", { packageRoot }, { tier: "read_motion" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.result as Record<string, unknown>;
    const counts = body.counts as Record<string, number>;
    expect(counts.volumeAutomationKeyframes).toBe(3);
    expect(counts.panAutomationKeyframes).toBe(2);
    expect(counts).not.toHaveProperty("unreadableAutomationKeyframes");
    const inputs = body.inputs as Array<Record<string, unknown>>;
    expect(inputs.every((input) => !("unreadableAutomationKeyframeCount" in input))).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
