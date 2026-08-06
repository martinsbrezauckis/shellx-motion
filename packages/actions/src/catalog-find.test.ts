/**
 * The no-match answer.
 *
 * `motion.actions.find("permission elevation")` used to return `null`. The catalog genuinely has no
 * elevation action, so the answer was true — and useless: an agent cannot tell "searched, nothing
 * matches" apart from "this tool is broken", and its only remaining move is to retry the query.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS, findAction, findActionMatch, nearestActions } from "./catalog.js";

describe("catalog lookup misses", () => {
  it("states that nothing matched and offers the nearest actions", () => {
    const match = findActionMatch("permission elevation");

    expect(findAction("permission elevation")).toBeNull();
    expect(match.matched).toBe(false);
    expect(match.action).toBeNull();
    expect(match.message).toContain("No Motion action matches");
    // The honest part: it names where the real answer is, rather than implying one exists.
    expect(match.message).toContain("motion.actions.panel");
    expect(match.nearest.length).toBeGreaterThan(0);
  });

  it.each([
    ["permission elevation"],
    ["how do I get write access"],
    ["qwertyuiop zxcvbnm"],
    [""]
  ])("never answers %j with an empty suggestion list", (request) => {
    const match = findActionMatch(request);

    // An empty `nearest` would reintroduce the dead end under a new field name.
    expect(match.nearest.length).toBeGreaterThan(0);
    expect(match.nearest.every((entry) => entry.id.startsWith("motion."))).toBe(true);
  });

  it("keeps the strict matcher strict", () => {
    // The near-miss scorer is deliberately looser than the alias matcher, so it must never be
    // allowed to promote a one-word overlap into a match. These are the cold-start queries that
    // previously resolved to the wrong action.
    expect(findActionMatch("create new empty motion package").action?.id).toBe("motion.package.create");
    expect(findActionMatch("validate package").action?.id).toBe("motion.package.validate");
    expect(findActionMatch("import this glb model and render it in canvas").action?.id).toBe("motion.scene3d.gltf.import");
  });

  it("excludes the matched action from its own near-miss list", () => {
    const match = findActionMatch("render mp4");

    expect(match.matched).toBe(true);
    expect(match.nearest.some((entry) => entry.id === match.action?.id)).toBe(false);
  });

  it("ranks by shared vocabulary, not catalog order", () => {
    const nearest = nearestActions("keyframe easing curve", ACTIONS);

    expect(nearest.length).toBeGreaterThan(0);
    expect(nearest.some((entry) => entry.id.includes("keyframe"))).toBe(true);
    // Each entry says WHY it is listed, so the agent can judge the suggestion instead of trusting it.
    expect(nearest.every((entry) => typeof entry.matchedOn === "string" && entry.matchedOn.length > 0)).toBe(true);
  });
});
