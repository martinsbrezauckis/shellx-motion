/**
 * Post-commit inverse observation for the three literal diagnostic slots.
 * The sibling diagnostic lifecycle has already authenticated the pair observation and owns lease state.
 */
import type {
  LocalMotionJobContext,
  LocalMotionProcessContainmentEvidence,
} from "@shellx-motion/core";
import { createHash } from "node:crypto";
import type { LinearSrgbSdrFinalRoute } from "@shellx-motion/core/internal/linear-srgb-sdr-final";
import type { StrictSdrCandidateHeldPair, StrictSdrCandidateHeldPairObservation } from "@shellx-motion/core/internal/strict-sdr-candidate-held-pair";
import type { LinearSrgbSdrFinalJob } from "./linear-srgb-sdr-final-adapter.js";
import { assertStrictSdrCandidateF2bSemanticSamples, type StrictSdrCandidateF2bSemanticVectors } from "./linear-srgb-sdr-final-three-slot-f2b-semantics.js";
import { sealStrictSdrEvent18Pending } from "./linear-srgb-sdr-final-three-slot-event18-pending.js";
import { assertStrictSdrFixedSceneR4IndexedRgba, selectStrictSdrFixedSceneR4SlotFromCoreReceipt } from "./linear-srgb-sdr-final-three-slot-fixed-reference-private.js";
import type {
  StrictSdrCandidateThreeSlotLeaseOwner,
  StrictSdrCandidateThreeSlotLeaseTransfer,
} from "./linear-srgb-sdr-final-three-slot-diagnostic.js";
import { recordCurrentStrictSdrCandidateFrame0Pack, stageCurrentStrictSdrCandidateFrame0Pack } from "./linear-srgb-sdr-final-three-slot-frame0-pack.js";
import {
  currentStrictSdrCandidateThreeSlotQ1StaticContinuityCapability,
  currentStrictSdrDecodedQualityCapability,
  currentStrictSdrCandidateThreeSlotM1aMeasurementExpectation,
  registerCurrentStrictSdrCandidateThreeSlotQ1StaticContinuityPlan,
  recordCurrentStrictSdrCandidateAllDeliveredFrameObservation,
  stageCurrentStrictSdrCandidateAllDeliveredFrameObservation,
} from "./linear-srgb-sdr-final-three-slot-temporal-observation.js";
import { assertStrictSdrDecodedQualityReportJoin, type StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan, type StrictSdrDecodedQualityCollectorCapability } from "./linear-srgb-sdr-final-three-slot-observation-contract.js";
import {
  buildStrictSdrCandidateThreeSlot2dMeasurementPlan,
  disposeStrictSdrCandidateThreeSlot2dMeasurementPlan,
  type StrictSdrCandidateThreeSlot2dMeasurementPlan,
} from "./linear-srgb-sdr-final-three-slot-2d-plan.js";
import {
  assertStrictSdrCandidateThreeSlot2dSpatialPlan,
  measureStrictSdrCandidateThreeSlot2dMeasurement,
} from "./linear-srgb-sdr-final-three-slot-2d-measurement.js";
import {
  assertStrictSdrCandidateThreeSlotInverseMeasurement,
  measureStrictSdrCandidateThreeSlotAllPixels,
  strictSdrCandidateF2bScreenControlsThreeSlotSamples,
  type StrictSdrCandidateF2bScreenControlsThreeSlotSamples,
  type StrictSdrCandidateThreeSlot,
  type StrictSdrCandidateThreeSlotBaseMeasurement,
} from "./linear-srgb-sdr-final-three-slot-measurement.js";

type Snapshot = Readonly<{ bytes: Buffer; sha256: string; byteLength: number; route: LinearSrgbSdrFinalRoute }>;
type Descriptor = <T>(operation: (input: Readonly<{
  fd: number;
  media: Readonly<{ sha256: string; byteLength: number }>;
}>) => Promise<T> | T) => Promise<T>;

type EvaluationInput = Readonly<{
  pair: StrictSdrCandidateHeldPair;
  observation: StrictSdrCandidateHeldPairObservation;
  slot: StrictSdrCandidateThreeSlot;
  controls: boolean;
  descriptor: Descriptor;
  expectedMedia: Readonly<{ sha256: string; byteLength: number }>;
  snapshot: Snapshot;
  transfer: StrictSdrCandidateThreeSlotLeaseTransfer;
  owner: StrictSdrCandidateThreeSlotLeaseOwner;
  temporal: boolean;
  f2bSemanticVectors?: StrictSdrCandidateF2bSemanticVectors;
  event18PendingRequested: boolean;
}>;
type EvaluationResult = StrictSdrCandidateThreeSlotBaseMeasurement & {
  samples?: StrictSdrCandidateF2bScreenControlsThreeSlotSamples;
};
type TemporalFrame = Readonly<{
  decoded: Readonly<{ sha256: string; byteLength: number }>;
  measurement: import("./linear-srgb-sdr-final-three-slot-measurement.js").StrictSdrCandidateThreeSlotDecodedMeasurement;
}>;

export async function evaluateStrictSdrCandidateThreeSlotCommittedDescriptor(input: EvaluationInput): Promise<EvaluationResult> {
  if (input.event18PendingRequested && !input.temporal) throw new Error("Strict-SDR Event-18 pending evaluation requires all delivered frames.");
  if (input.event18PendingRequested && input.slot === "f2b-screen-controls" && !input.f2bSemanticVectors) throw new Error("Strict-SDR Event-18 pending controls require the F2b semantic fixture.");
  if (input.temporal) return await evaluateAllDeliveredFrames(input);
  return await input.descriptor(async ({ fd, media }) => {
    if (!Number.isInteger(fd) || fd < 3 || media.sha256 !== input.expectedMedia.sha256 || media.byteLength !== input.expectedMedia.byteLength) {
      throw new Error("Strict-SDR three-slot Core descriptor callback did not preserve committed media identity.");
    }
    const inverse = await input.transfer.governor.run({
      lane: "ffmpeg",
      operation: `ffmpeg.strict-sdr-candidate-three-slot-${input.slot}-inverse`,
      scratchRoot: input.transfer.scratchRoot,
      ...(input.transfer.signal ? { signal: input.transfer.signal } : {}),
      ...(input.transfer.callerId ? { callerId: input.transfer.callerId } : {}),
    }, async (context) => await input.owner.runThreeSlotInverse({
      sourceFd: fd,
      job: inverseJob(context, input.transfer.governor.policy.maxProcessTreeRssBytes),
      measureDecoded: async (decoded) => {
        const measurement = Object.freeze({
          allPixels: measureStrictSdrCandidateThreeSlotAllPixels(input.snapshot.bytes, decoded, input.snapshot.route),
          ...(input.controls ? { samples: strictSdrCandidateF2bScreenControlsThreeSlotSamples(input.snapshot.bytes, decoded, input.snapshot.route) } : {}),
        });
        if (input.f2bSemanticVectors) assertStrictSdrCandidateF2bSemanticSamples(measurement.samples!, input.f2bSemanticVectors, 0);
        await stageCurrentStrictSdrCandidateFrame0Pack({ slot: input.slot, pair: input.pair, observation: input.observation, snapshot: input.snapshot, decoded });
        return measurement;
      },
    }));
    assertStrictSdrCandidateThreeSlotInverseMeasurement(inverse.value, input.snapshot.route, input.controls);
    if (media.sha256 !== input.expectedMedia.sha256 || media.byteLength !== input.expectedMedia.byteLength) {
      throw new Error("Strict-SDR three-slot Core descriptor callback did not preserve committed media identity.");
    }
    const samples = inverse.value.measurement.samples;
    if (input.controls && !samples) throw new Error("Strict-SDR three-slot controls inverse omitted its sealed vector samples.");
    const result = Object.freeze({
      media: Object.freeze({ sha256: media.sha256, byteLength: media.byteLength }),
      sourceFrame: Object.freeze({ sha256: input.snapshot.sha256, byteLength: input.snapshot.byteLength }),
      decodedFrame: Object.freeze({ ...inverse.value.decoded }),
      allPixels: inverse.value.measurement.allPixels,
      inverseCommandSha256: inverse.value.inverseCommandSha256,
      inverseJob: inverse.evidence,
      ...(samples ? { samples } : {}),
    });
    recordCurrentStrictSdrCandidateFrame0Pack(input.pair, input.slot, {
      media: result.media,
      receipt: input.observation.receipt,
      sourceFrame: result.sourceFrame,
      decodedFrame: result.decodedFrame,
      inverseCommandSha256: result.inverseCommandSha256,
      inverseJob: result.inverseJob,
    });
    return result;
  });
}

async function evaluateAllDeliveredFrames(input: EvaluationInput): Promise<EvaluationResult> {
  return await input.descriptor(async ({ fd, media }) => {
    if (!Number.isInteger(fd) || fd < 3 || media.sha256 !== input.expectedMedia.sha256 || media.byteLength !== input.expectedMedia.byteLength) {
      throw new Error("Strict-SDR three-slot Core descriptor callback did not preserve committed media identity.");
    }
    const selectedR4 = input.event18PendingRequested ? await (async () => {
      const receipt = await input.observation.readReceipt();
      if (receipt.byteLength !== input.observation.receipt.byteLength
        || createHash("sha256").update(receipt).digest("hex") !== input.observation.receipt.sha256) {
        throw new Error("Strict-SDR Event-18 Core-held receipt bytes differ from the exact pair observation.");
      }
      return selectStrictSdrFixedSceneR4SlotFromCoreReceipt(receipt, input.slot);
    })() : undefined;
    const expectedM1a = currentStrictSdrCandidateThreeSlotM1aMeasurementExpectation(input.slot, input.transfer.preparation);
    const q1 = currentStrictSdrCandidateThreeSlotQ1StaticContinuityCapability(input.slot, input.transfer.preparation);
    const quality = currentStrictSdrDecodedQualityCapability(input.slot, input.transfer.preparation);
    let plan: StrictSdrCandidateThreeSlot2dMeasurementPlan | undefined;
    let q1Plan: StrictSdrCandidateThreeSlotQ1StaticContinuityCapabilityPlan | undefined;
    let qualityCollector: StrictSdrDecodedQualityCollectorCapability | undefined;
    let primary: unknown, hasPrimary = false;
    try {
      if (expectedM1a) {
        const { q1StaticContinuity, ...m1Expected } = expectedM1a;
        plan = buildStrictSdrCandidateThreeSlot2dMeasurementPlan({ route: input.snapshot.route, sourceRgba8: input.snapshot.bytes, expected: m1Expected });
        assertStrictSdrCandidateThreeSlot2dSpatialPlan(plan.spatialPlan);
        if (q1StaticContinuity) {
          if (!q1) throw new Error("Strict-SDR @3 all-delivered-frame evaluation lacks its sealed Q1 capability.");
          q1Plan = q1.buildPlan({ route: input.snapshot.route, sourceRgba8: input.snapshot.bytes, m1Plan: plan, expected: expectedM1a });
          registerCurrentStrictSdrCandidateThreeSlotQ1StaticContinuityPlan(input.slot, input.transfer.preparation, q1Plan);
        } else if (q1) {
          throw new Error("Strict-SDR @2 all-delivered-frame evaluation retained an unexpected Q1 capability.");
        }
      }
      if (quality) {
        if (quality.sourceFrameSha256 !== input.snapshot.sha256) throw new Error("Strict SDR decoded quality capability source differs from held snapshot");
        qualityCollector = quality.createCollector(input.snapshot.bytes);
        if (!qualityCollector || typeof qualityCollector.observe !== "function" || typeof qualityCollector.complete !== "function"
          || typeof qualityCollector.dispose !== "function") throw new Error("Strict SDR decoded quality collector capability is incomplete");
      }
      const inverse = await input.transfer.governor.run({
        lane: "ffmpeg",
        operation: `ffmpeg.strict-sdr-candidate-three-slot-${input.slot}-all-delivered-frame-inverse`,
        scratchRoot: input.transfer.scratchRoot,
        ...(input.transfer.signal ? { signal: input.transfer.signal } : {}),
        ...(input.transfer.callerId ? { callerId: input.transfer.callerId } : {}),
      }, async (context) => await input.owner.runThreeSlotAllDeliveredFrames<TemporalFrame>({
        slot: input.slot,
        sourceFd: fd,
        job: inverseJob(context, input.transfer.governor.policy.maxProcessTreeRssBytes),
        observeFrame: async ({ frame, withOwnedRgba }) => await withOwnedRgba(async (rgba) => {
          if (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0 || frame.frameIndex >= 60
            || !/^[a-f0-9]{64}$/u.test(frame.decoded.sha256) || frame.decoded.byteLength !== 3_686_400) {
            throw new Error("Strict-SDR three-slot all-delivered-frame callback lacks its fixed decoded frame identity.");
          }
          if (selectedR4) assertStrictSdrFixedSceneR4IndexedRgba(selectedR4, frame.frameIndex, rgba, frame.decoded.sha256);
          const spatial = plan === undefined ? undefined : measureStrictSdrCandidateThreeSlot2dMeasurement({ plan, sourceRgba8: input.snapshot.bytes, decodedRgba8: rgba });
          const q1Measurement = q1Plan === undefined ? undefined : q1!.measureFrame({ plan: q1Plan, sourceRgba8: input.snapshot.bytes, decodedRgba8: rgba });
          const spatialContinuity = q1Measurement?.spatialContinuity;
          const measurement = Object.freeze({
            allPixels: measureStrictSdrCandidateThreeSlotAllPixels(input.snapshot.bytes, rgba, input.snapshot.route),
            ...(input.controls ? { samples: strictSdrCandidateF2bScreenControlsThreeSlotSamples(input.snapshot.bytes, rgba, input.snapshot.route) } : {}),
          });
          if (input.f2bSemanticVectors) assertStrictSdrCandidateF2bSemanticSamples(measurement.samples!, input.f2bSemanticVectors, frame.frameIndex);
          if (frame.frameIndex === 0) {
            await stageCurrentStrictSdrCandidateFrame0Pack({ slot: input.slot, pair: input.pair, observation: input.observation, snapshot: input.snapshot, decoded: rgba });
          }
          stageCurrentStrictSdrCandidateAllDeliveredFrameObservation({
            slot: input.slot,
            pair: input.pair,
            observation: input.observation,
            snapshot: input.snapshot,
            frameIndex: frame.frameIndex,
            decodedFrame: frame.decoded,
            allPixels: measurement.allPixels,
            ...(measurement.samples ? { samples: measurement.samples } : {}),
            ...(plan === undefined ? {} : { spatialPlan: plan.spatialPlan, spatial }),
            ...(q1Plan === undefined ? {} : { spatialContinuityPlan: q1Plan.spatialContinuityPlan, spatialContinuity }),
          });
          if (qualityCollector && qualityCollector.observe(frame.frameIndex, frame.decoded.sha256, rgba) !== undefined) {
            throw new Error("Strict SDR decoded quality observation must finish synchronously");
          }
          return Object.freeze({ decoded: frame.decoded, measurement });
        }),
      }));
      if (inverse.value.frames.length !== 60 || inverse.value.decodedByteLength !== 221_184_000) {
        throw new Error("Strict-SDR three-slot all-delivered-frame inverse did not retain its exact 60-frame byte coverage.");
      }
      const first = inverse.value.frames[0];
      if (!first) throw new Error("Strict-SDR three-slot all-delivered-frame inverse omitted its first frame.");
      assertStrictSdrCandidateThreeSlotInverseMeasurement({
        decoded: first.decoded,
        measurement: first.measurement,
        inverseCommandSha256: inverse.value.inverseCommandSha256,
      }, input.snapshot.route, input.controls);
      await input.observation.verifyCurrentPair();
      const temporalRecord = recordCurrentStrictSdrCandidateAllDeliveredFrameObservation({
        pair: input.pair,
        slot: input.slot,
        heldFfmpeg: inverse.value.heldFfmpeg,
        inverseCommandSha256: inverse.value.inverseCommandSha256,
        inverseJob: inverse.evidence,
      });
      if (media.sha256 !== input.expectedMedia.sha256 || media.byteLength !== input.expectedMedia.byteLength) {
        throw new Error("Strict-SDR three-slot Core descriptor callback did not preserve committed media identity.");
      }
      const samples = first.measurement.samples;
      if (input.controls && !samples) throw new Error("Strict-SDR three-slot controls all-delivered-frame inverse omitted its sealed vector samples.");
      const result = Object.freeze({
        media: Object.freeze({ sha256: media.sha256, byteLength: media.byteLength }),
        sourceFrame: Object.freeze({ sha256: input.snapshot.sha256, byteLength: input.snapshot.byteLength }),
        decodedFrame: Object.freeze({ ...first.decoded }),
        allPixels: first.measurement.allPixels,
        inverseCommandSha256: inverse.value.inverseCommandSha256,
        inverseJob: inverse.evidence,
        ...(samples ? { samples } : {}),
      });
      recordCurrentStrictSdrCandidateFrame0Pack(input.pair, input.slot, {
        media: result.media,
        receipt: input.observation.receipt,
        sourceFrame: result.sourceFrame,
        decodedFrame: result.decodedFrame,
        inverseCommandSha256: result.inverseCommandSha256,
        inverseJob: result.inverseJob,
      });
      if (quality && qualityCollector) {
        const hashes = temporalRecord.frames.map((frame) => frame.decodedFrame.sha256);
        const report = qualityCollector.complete(temporalRecord.sequenceSha256, hashes);
        assertStrictSdrDecodedQualityReportJoin(report, quality, temporalRecord.sequenceSha256, hashes);
        const accepted = quality.assertSlot(report, { bindingSha256: quality.bindingSha256, slot: input.slot,
          sourceFrameSha256: input.snapshot.sha256, sequenceSha256: temporalRecord.sequenceSha256, decodedFrameSha256: hashes });
        if (accepted === undefined || accepted instanceof Promise) throw new Error("Strict SDR decoded quality slot assertion must finish synchronously");
        assertStrictSdrDecodedQualityReportJoin(accepted, quality, temporalRecord.sequenceSha256, hashes);
        if (quality.record(accepted) !== undefined) throw new Error("Strict SDR decoded quality record sink must finish synchronously");
      }
      if (input.event18PendingRequested) {
        if (!selectedR4) throw new Error("Strict-SDR Event-18 pending evaluator lost its receipt-selected R4 arm.");
        sealStrictSdrEvent18Pending({
          pair: input.pair, observation: input.observation, slot: input.slot,
          referenceArm: selectedR4.arm, referenceSha256: selectedR4.referenceSha256,
          preparation: input.transfer.preparation, temporal: input.temporal,
          controlsFixturePresent: input.f2bSemanticVectors !== undefined,
          mediaSha256: result.media.sha256, sourceFrameSha256: result.sourceFrame.sha256,
          decodedSequenceSha256: temporalRecord.sequenceSha256,
          decodedFrameSha256: temporalRecord.frames.map((frame) => frame.decodedFrame.sha256),
        });
      }
      return result;
    } catch (error) {
      primary = error;
      hasPrimary = true;
      throw error;
    } finally {
      const cleanup: unknown[] = [];
      if (qualityCollector) try { qualityCollector.dispose(); } catch (error) { cleanup.push(error); }
      if (q1Plan) try { q1!.disposePlan(q1Plan); } catch (error) { cleanup.push(error); }
      if (plan) try { disposeStrictSdrCandidateThreeSlot2dMeasurementPlan(plan); } catch (error) { cleanup.push(error); }
      if (cleanup.length === 1) {
        if (hasPrimary) throw new AggregateError([primary, cleanup[0]], q1Plan === undefined
          ? "Strict-SDR all-delivered-frame evaluation and M1a plan cleanup both failed."
          : "Strict-SDR all-delivered-frame evaluation and measurement-plan cleanup both failed.");
        throw cleanup[0];
      }
      if (cleanup.length > 1) throw new AggregateError(hasPrimary ? [primary, ...cleanup] : cleanup, "Strict-SDR all-delivered-frame evaluation and measurement-plan cleanup failed.");
    }
  });
}

function inverseJob(context: LocalMotionJobContext, maxProcessTreeRssBytes: number): LinearSrgbSdrFinalJob {
  return Object.freeze({
    admission: "pre-acquired" as const,
    signal: context.signal,
    scratchRoot: context.scratchRoot,
    maxProcessTreeRssBytes,
    watchProcess: (pid: number) => context.watchProcess(pid),
    reportProcessContainment: (evidence: LocalMotionProcessContainmentEvidence) => context.reportProcessContainment(evidence),
  });
}
