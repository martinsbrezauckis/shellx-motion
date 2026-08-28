import { describe, expect, it } from "vitest";
import { TIMELINE_GROUP_COMMANDS, isTimelineGroupCommand, readTimelineGroupIntent } from "./timeline-groups";

describe("timeline group Debug-domain intents", () => {
  it("keeps a typed create group record intact for the future Core join", () => {
    const group = { id: "pack", type: "group", startMs: 20, durationMs: 100, childLayerIds: ["a"], transform: { x: 0 } };
    const result = readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.create, { group, parentGroupId: "parent", childIndex: 0 });
    expect(result).toEqual({ ok: true, intent: { kind: "create", group, parentGroupId: "parent", childIndex: 0 } });
    if (result?.ok) expect(result.intent.kind === "create" && result.intent.group).not.toBe(group);
  });

  it("requires explicit source ownership for a move, preserving null as an intentional root source", () => {
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.childMove, { sourceGroupId: null, destinationGroupId: "pack", childLayerId: "a" }))
      .toEqual({ ok: true, intent: { kind: "child-move", sourceGroupId: null, destinationGroupId: "pack", childLayerId: "a" } });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.childMove, { destinationGroupId: "pack", childLayerId: "a" }))
      .toEqual({ ok: false, problem: "sourceGroupId must be an explicit non-empty string or null." });
  });

  it("refuses lossy or ambiguous structural arguments before a registry transaction exists", () => {
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.wrap, { group: { id: "pack" }, childLayerIds: ["a", "a"] }))
      .toEqual({ ok: false, problem: "childLayerIds must be unique non-empty strings." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.wrap, { group: { id: "pack" }, childLayerIds: ["a", " a "] }))
      .toEqual({ ok: false, problem: "childLayerIds must be unique non-empty strings." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.childReorder, { groupId: "pack", childLayerId: "a", index: 1.5 }))
      .toEqual({ ok: false, problem: "index must be a non-negative integer." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.delete, { groupId: "pack", disposition: "delete" }))
      .toEqual({ ok: false, problem: "disposition must be 'cascade' or 'unwrap'." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.unwrap, { groupId: "pack", force: true }))
      .toEqual({ ok: false, problem: "Unknown argument: force." });
  });

  it("has a closed command vocabulary", () => {
    expect(isTimelineGroupCommand(TIMELINE_GROUP_COMMANDS.duplicate)).toBe(true);
    expect(isTimelineGroupCommand(TIMELINE_GROUP_COMMANDS.split)).toBe(true);
    expect(isTimelineGroupCommand("motion.timeline.group.flatten")).toBe(false);
    expect(readTimelineGroupIntent("motion.timeline.group.flatten", {})).toBeNull();
  });

  it("strictly parses local timing, root order, and recursive split operations", () => {
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.trim, { groupId: "pack", startMs: 10, durationMs: 90 }))
      .toEqual({ ok: true, intent: { kind: "trim", groupId: "pack", startMs: 10, durationMs: 90 } });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.trim, { groupId: "pack" }))
      .toEqual({ ok: false, problem: "Group trim requires startMs or durationMs." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.trim, { groupId: "pack", durationMs: 0 }))
      .toEqual({ ok: false, problem: "durationMs must be a positive finite number when provided." });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.rootReorder, { groupId: "pack", index: 2 }))
      .toEqual({ ok: true, intent: { kind: "root-reorder", groupId: "pack", index: 2 } });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.split, { groupId: "pack", atMs: 125, newGroupId: "tail" }))
      .toEqual({ ok: true, intent: { kind: "split", groupId: "pack", atMs: 125, newGroupId: "tail" } });
    expect(readTimelineGroupIntent(TIMELINE_GROUP_COMMANDS.split, { groupId: "pack", atMs: -1 }))
      .toEqual({ ok: false, problem: "atMs must be a non-negative finite number." });
  });
});
