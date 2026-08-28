import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "@shellx-motion/core";
import { planRenderSegments } from "./segmented-final-internal/render-segment-plan.js";
import { segmentFrameSequenceSha256 } from "./segmented-final-internal/render-segment-store-identity.js";
import { createRenderSegmentStore } from "./segmented-final-internal/render-segment-store.js";
import { RENDER_SEGMENT_STORE_SCHEMA } from "./segmented-final-internal/render-segment-store-types.js";

const schemaPath = resolve("../../schemas/render-segment-store.schema.json");
const fixturePath = resolve("../../fixtures/renderer-segment-store/empty-store.json");
const hash = "a".repeat(64);

describe("published render-segment-store schema contract", () => {
  it("accepts its checked-in fixture and rejects structural wire-contract drift", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchemaDocument;
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(schema.$id).toBe(RENDER_SEGMENT_STORE_SCHEMA);
    expect(validateAgainstPublishedSchema(schema, fixture)).toEqual([]);
    expect(schema).toMatchObject({
      properties: { completed: { maxItems: 512 } },
      $defs: {
        plan: { properties: { ranges: { maxItems: 512 } } },
        checkpoint: { properties: { frameHashes: { maxItems: 36_000 } } }
      }
    });

    const malformed = structuredClone(fixture);
    malformed.completed = [{ index: 0 }];
    expect(validateAgainstPublishedSchema(schema, malformed)).not.toEqual([]);
  });

  it("keeps the public schema aligned with the engine-owned fresh manifest", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "shellx-motion-segment-schema-"));
    try {
      const store = await createRenderSegmentStore({
        rootPath,
        plan: planRenderSegments({ frameCount: 2, segmentFrames: 2 }),
        package: { id: "schema-test", manifestSha256: hash, contentSha256: "b".repeat(64) },
        frameLane: "native",
        producer: { frameLane: "native" },
        timeline: { motionSha256: "b".repeat(64), durationMs: 1000, fps: 30, width: 640, height: 360 },
        intermediate: { container: "matroska", codec: "ffv1", extension: ".mkv" },
        delivery: {
          schema: "shellx-motion/segmented-final-delivery@1",
          outputPathSha256: "c".repeat(64),
          preset: "mp4-h264",
          audio: [{ contentSha256: "d".repeat(64), controlsSha256: "e".repeat(64) }],
          quality: { minDurationMs: 0, minUniqueFrameHashes: 2 },
          forceSoftwareEncode: true,
          verifyDeliveredColor: true
        },
        verifyReadback: () => ({
          ok: true,
          readback: { verified: true, frameCount: 2, width: 640, height: 360, fps: 30, durationMs: 1000 / 30 }
        })
      });
      const range = store.manifest.plan.ranges[0];
      const frameHashes = ["c".repeat(64), "d".repeat(64)];
      await writeFile(store.temporaryArtifactPath(0), "schema-checkpoint");
      await store.commit({
        index: 0,
        temporaryArtifactPath: store.temporaryArtifactPath(0),
        frameSequenceSha256: segmentFrameSequenceSha256({ range, frameHashes }),
        frameHashes,
        blankFrameCount: 0,
        producer: { schema: "shellx-motion/segment-range-producer@1", frameLane: "native", warningUnion: [], warningsOmitted: 0 }
      });
      const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchemaDocument;
      expect(validateAgainstPublishedSchema(schema, store.manifest)).toEqual([]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
