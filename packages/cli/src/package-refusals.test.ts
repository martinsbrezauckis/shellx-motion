/**
 * `validate` must actually validate.
 *
 * No `validate` door may skip structural JSON Schema or runtime semantic validation. The CLI, Debug API/MCP, and SDK must not only
 * load the package and report
 * metadata, so `shellx-motion validate` answered `ok: true` for a document `core.validateDocument`
 * rejects outright.
 *
 * That is the worst shape this bug can take: an unchecked document reported as checked. An agent acts
 * on the verdict, so a false pass costs it the whole build. Running the real validator across the
 * shipped corpus supplies the independent proof that every promoted package satisfies the same contract.
 *
 * The negative cases matter as much as the positive one: a validator that refuses sound packages is
 * just as useless, and the corpus proof (34/34 shipping packages accepted) is what says this refusal
 * does not over-trigger.
 */
import { describe, expect, it } from "vitest";
import type { MotionDocument, MotionPackage } from "@shellx-motion/core";
import { packageValidationRefusal, packageValidationResult } from "./package-refusals";

/** A minimal document that satisfies `shellx-motion/motion@1`. */
function soundDocument(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_test",
    name: "Test",
    durationMs: 1000,
    fps: 30,
    width: 1920,
    height: 1080,
    background: "#000000",
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
    layers: [
      {
        id: "title",
        type: "text",
        text: "Hello",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 120, y: 820, scale: 1, rotation: 0 },
        style: { fontFamily: "Inter", fontSize: 64, color: "#ffffff" }
      }
    ]
  } as unknown as MotionDocument;
}

function packageAround(motion: MotionDocument): MotionPackage {
  return {
    root: "/pkg",
    manifest: {
      id: "pkg_test",
      name: "Test",
      assets: [],
      compatibility: { hosts: ["motion"], lanes: ["browser"] }
    },
    motion
  } as unknown as MotionPackage;
}

describe("shellx-motion validate runs the two-stage contract", () => {
  it("refuses a document the schema validator rejects, naming the offending path", async () => {
    // The exact shape that shipped past validate: an 8-digit hex where the engine takes #RRGGBB.
    const motion = soundDocument() as unknown as Record<string, unknown>;
    (motion.layers as Record<string, unknown>[]).push({
      id: "weather",
      name: "Rain",
      type: "environment",
      startMs: 0,
      durationMs: 1000,
      transform: { x: 0, y: 0, width: 1920, height: 1080 },
      environment: {
        schema: "shellx-motion/environment@1",
        kind: "rain",
        seed: 1,
        quality: "cinematic",
        mode: "scene",
        intensity: 0.5,
        wind: 0,
        dropSpeed: 1,
        dropLength: 1,
        depthLayers: 2,
        color: "#D6F5FF",
        backgroundColor: "#04091100",
        lightColor: "#5EE7F7",
        accentColor: "#FF5C8A",
        ground: { horizon: 0.5, wetness: 0.5, roughness: 0.5, rippleAmount: 0.5, splashAmount: 0.5, reflectionStrength: 0.5 },
        atmosphere: { mist: 0.5, lensDroplets: 0.2 }
      }
    });

    const refusal = await packageValidationRefusal(motion as unknown as MotionDocument, "validate");

    expect(refusal).not.toBeNull();
    expect(refusal?.ok).toBe(false);
    expect((refusal?.error as { code: string }).code).toBe("invalid_motion_document");
    // The caller must be able to act on this without guessing which layer is wrong.
    const errors = refusal?.schemaErrors as Array<{ path: string; message: string }>;
    expect(errors.some((error) => error.path.includes("backgroundColor"))).toBe(true);
    expect(errors.some((error) => /\^#\[0-9A-Fa-f\]\{6\}\$/.test(error.message))).toBe(true);
    expect(refusal?.validation).toEqual({
      contract: "shellx-motion/motion-validation@1",
      structural: "failed",
      semantic: "not_run",
      renderability: "not_proven",
    });
  });

  it("does not refuse a document the schema validator accepts", async () => {
    expect(await packageValidationRefusal(soundDocument(), "validate")).toBeNull();
  });

  it("still answers ok for a sound package, and reports its identity", async () => {
    const result = await packageValidationResult(packageAround(soundDocument()), "validate");
    expect(result.ok).toBe(true);
    expect(result.packageId).toBe("pkg_test");
    expect(result.layers).toBe(1);
    expect(result.validation).toEqual({
      contract: "shellx-motion/motion-validation@1",
      structural: "passed",
      semantic: "passed",
      renderability: "not_proven",
    });
  });

  it("stops after structural failure before considering semantic renderability", async () => {
    // A document that is both structurally invalid and has an unrenderable layer type cannot make a
    // renderer claim. The public order is structural first, semantic second.
    const motion = soundDocument() as unknown as Record<string, unknown>;
    (motion as { fps: unknown }).fps = "thirty";
    (motion.layers as Record<string, unknown>[]).push({
      id: "bogus",
      name: "Unrenderable",
      type: "definitely-not-a-layer-type",
      startMs: 0,
      durationMs: 1000
    });

    const refusal = await packageValidationRefusal(motion as unknown as MotionDocument, "validate");

    expect(refusal).not.toBeNull();
    expect((refusal?.error as { code: string }).code).toBe("invalid_motion_document");
    expect(refusal?.validation).toMatchObject({ structural: "failed", semantic: "not_run", renderability: "not_proven" });
  });

  it("catches a structural defect before rendering", async () => {
    // Grok's actual case: renderable layers, readable keyframes, and an environment colour the
    // engine refuses at preview. Nothing but the schema check sees this one.
    const motion = soundDocument() as unknown as Record<string, unknown>;
    (motion as { fps: unknown }).fps = "thirty";

    const refusal = await packageValidationRefusal(motion as unknown as MotionDocument, "validate");

    expect((refusal?.error as { code: string }).code).toBe("invalid_motion_document");
  });

  it("caps the reported errors so one malformed document cannot flood a terminal", async () => {
    const motion = soundDocument() as unknown as Record<string, unknown>;
    const layers = motion.layers as Record<string, unknown>[];
    for (let index = 0; index < 80; index += 1) {
      layers.push({ id: `bad-${index}`, name: `Bad ${index}`, type: "text", startMs: 0, durationMs: -1 });
    }

    const refusal = await packageValidationRefusal(motion as unknown as MotionDocument, "validate");

    const errors = refusal?.schemaErrors as unknown[];
    expect(errors.length).toBeLessThanOrEqual(50);
    expect(refusal?.schemaErrorCount as number).toBeGreaterThan(errors.length);
    expect(refusal?.schemaErrorsTruncated).toBe(true);
  });
});
