/**
 * The frame lane must not report an expected division of work as something going wrong.
 *
 * the success-status invariant, the delivery failure: the browser lane pushed
 * "Browser generated renderer skipped unsupported audio layer music-bed." into the frame receipt's
 * `warnings`, a frame receipt's status is derived from `warnings.length`, and the CLI escalates the
 * final receipt to the worst frame status — so a completely successful audio render was delivered
 * as `status: "warning"` and failed the `audio-launch` product-pack proof.
 *
 * The rule these pin: a layer another lane owns is EVIDENCE; a layer nobody can draw is a WARNING.
 */
import { describe, expect, it } from "vitest";
import type { MotionLayer } from "@shellx-motion/core";
import { createFrameLaneNotes, frameLaneAudioHandoff, noteUnrenderedLayer } from "./frame-lane-handoff";

function layer(id: string, type: string): MotionLayer {
  return { id, type, startMs: 0, durationMs: 1000 } as MotionLayer;
}

describe("frame-lane handoff", () => {
  it("records an audio layer as downstream evidence, never as a warning", () => {
    const notes = createFrameLaneNotes();

    noteUnrenderedLayer(notes, layer("music-bed", "audio"));

    expect(notes.warnings).toEqual([]);
    expect(frameLaneAudioHandoff(notes)).toEqual({
      status: "handled_downstream",
      handledBy: "ffmpeg",
      layers: [{ id: "music-bed", type: "audio" }]
    });
  });

  it("still warns about a layer type NO lane can draw", () => {
    const notes = createFrameLaneNotes();

    noteUnrenderedLayer(notes, layer("mystery", "hologram"));

    expect(notes.warnings).toEqual(["Browser generated renderer skipped unsupported hologram layer mystery."]);
    expect(frameLaneAudioHandoff(notes)).toBeUndefined();
  });

  it("deduplicates a layer seen once per motion-blur sample", () => {
    // Motion blur renders a layer up to 8 times per frame; the handoff is one fact, not eight.
    const notes = createFrameLaneNotes();
    for (let sample = 0; sample < 8; sample += 1) noteUnrenderedLayer(notes, layer("music-bed", "audio"));
    noteUnrenderedLayer(notes, layer("mystery", "hologram"));
    noteUnrenderedLayer(notes, layer("mystery", "hologram"));

    expect(frameLaneAudioHandoff(notes)?.layers).toEqual([{ id: "music-bed", type: "audio" }]);
    expect(notes.warnings).toHaveLength(1);
  });

  it("reports no handoff at all when the composition has no audio", () => {
    expect(frameLaneAudioHandoff(createFrameLaneNotes())).toBeUndefined();
  });

  it("keeps several audio layers in first-seen order", () => {
    const notes = createFrameLaneNotes();
    noteUnrenderedLayer(notes, layer("music-bed", "audio"));
    noteUnrenderedLayer(notes, layer("voice-over", "audio"));

    expect(frameLaneAudioHandoff(notes)?.layers).toEqual([
      { id: "music-bed", type: "audio" },
      { id: "voice-over", type: "audio" }
    ]);
  });
});
