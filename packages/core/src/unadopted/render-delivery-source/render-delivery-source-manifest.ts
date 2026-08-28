/**
 * Private C5A source admission for provider deliveries.
 *
 * This module reads only from a host-selected provider root and returns durable, path-free facts.
 * The matching source locations live in a process-local WeakMap so callers cannot accidentally
 * put a provider filesystem path into a Motion document, package record, receipt, or log. It does
 * not create a package, stage an output, or invoke a provider/runtime; the later Debug host adapter
 * must revalidate these facts while it performs the one PackageEditWorkspace COW transaction.
 */

import { resolve } from "node:path";
import { canonicalJsonSha256 } from "../../canonical-json";
import { describeMotionRenderDeliveryImportRequest } from "./render-delivery-import-plan";
import { assertTrustedWorkspaceAnchorPath, withTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "../../output-path-trusted-workspace";
import {
  assertC5ABeautyDecoderBounds,
  expectedAnchorSource,
  classifySourceFailure,
  expectedBeautySources,
  preflightAnchorSource,
  preflightBeautySequence,
  readPreflightedAnchorSource,
  readPreflightedBeautySequence,
} from "./render-delivery-source-read";
import {
  MAX_RENDER_DELIVERY_ANCHOR_BYTES,
  MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  RENDER_DELIVERY_SOURCE_LIMITS,
  RenderDeliverySourceAdmissionError,
  type EphemeralSourceLocations,
  type RenderDeliveryAnchorSourceFileFact,
  type RenderDeliveryBeautySourceFileFact,
  type RenderDeliverySourceAdmissionErrorCode,
  type RenderDeliverySourceFileFact,
} from "./render-delivery-source-support";
import { BoundedResourceBudget } from "../../stable-file-read";
import { describeMotionRenderDelivery } from "./render-delivery-validate";
import type {
  MotionRenderDelivery,
  MotionRenderDeliveryImportPlan,
} from "./render-delivery-types";

export {
  MAX_RENDER_DELIVERY_ANCHOR_BYTES,
  MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  RenderDeliverySourceAdmissionError,
};
export type { RenderDeliverySourceAdmissionErrorCode, RenderDeliverySourceFileFact };

/**
 * Durable source facts contain zero provider-local paths. They are enough for a receipt to bind
 * the delivered bytes and source identity, while the WeakMap below keeps paths process-local.
 */
export interface MotionRenderDeliverySourceManifest {
  readonly schema: "motion.render-delivery-source-manifest/v1";
  readonly fingerprint: string;
  readonly delivery: MotionRenderDelivery;
  readonly deliveryFingerprint: string;
  readonly plan: MotionRenderDeliveryImportPlan;
  readonly sources: {
    readonly beauty: readonly RenderDeliveryBeautySourceFileFact[];
    readonly anchors?: RenderDeliveryAnchorSourceFileFact;
  };
  readonly sourceByteLength: number;
}

export interface MotionRenderDeliverySourceAdmissionOptions {
  /** Host-configured lexical root containing provider-local transient files. Never retained. */
  readonly providerInputRoot: string;
  /**
   * Optional host-only POSIX authority for exactly the configured provider root. Windows retains
   * the existing full-route raw-DACL/topology admission because it cannot mint this POSIX anchor.
   */
  readonly providerInputRootAuthority?: TrustedWorkspaceAnchor;
}

/** Test-only interruption seam between all metadata reservations and the first stable byte read. */
export interface MotionRenderDeliverySourceAdmissionServices {
  readonly afterPreflight?: () => Promise<void>;
}

const locationsByManifest = new WeakMap<MotionRenderDeliverySourceManifest, EphemeralSourceLocations>();
const authorityByManifest = new WeakMap<MotionRenderDeliverySourceManifest, { readonly providerInputRootAuthority?: TrustedWorkspaceAnchor }>();

/**
 * Preflight every beauty and optional anchor leaf before reading any source bytes, then bind stable
 * path-free facts to the already-admitted delivery. This is read-only Core work; it stops before COW.
 *
 * `motion.render-delivery/v1` allows an 8K descriptor for future providers, but C5A uses the
 * existing bounded decoder and therefore admits only its 3840x2160/8,294,400-pixel PNG subset.
 * No decoded RGBA is retained after each frame check.
 */
export async function admitMotionRenderDeliverySources(
  value: unknown,
  options: MotionRenderDeliverySourceAdmissionOptions,
  services: MotionRenderDeliverySourceAdmissionServices = {},
): Promise<MotionRenderDeliverySourceManifest> {
  const root = resolve(options.providerInputRoot);
  try {
    await assertProviderInputRootAuthority(options.providerInputRootAuthority, root);
  } catch {
    throw new RenderDeliverySourceAdmissionError("source_identity");
  }
  const described = describeMotionRenderDeliveryImportRequest(value);
  if (!described.ok) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  assertC5ABeautyDecoderBounds(described.delivery);

  const inputLocations = freeze({ providerInputRoot: root, beauty: described.sources.beauty, ...(described.sources.anchors ? { anchors: described.sources.anchors } : {}) });
  const expected = expectedBeautySources(described.delivery, described.plan);
  const expectedAnchors = expectedAnchorSource(described.delivery, described.plan);
  if ((expectedAnchors === undefined) !== (inputLocations.anchors === undefined)) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  const budget = new BoundedResourceBudget(RENDER_DELIVERY_SOURCE_LIMITS, "provider delivery source");

  return await withProviderInputRootAuthority(options.providerInputRootAuthority, async () => {
    try {
      // Reserve every regular single-link beauty and optional anchor source before opening any
      // bytes. A later source cannot turn a partly read import into an unbounded operation.
      const preflightedBeauty = await preflightBeautySequence(inputLocations.beauty, root, expected, budget);
      const preflightedAnchors = expectedAnchors && inputLocations.anchors
        ? await preflightAnchorSource(inputLocations.anchors, root, expectedAnchors, budget, MAX_RENDER_DELIVERY_ANCHOR_BYTES)
        : undefined;
      await services.afterPreflight?.();
      const verifiedBeauty = await readPreflightedBeautySequence(preflightedBeauty, root, budget);
      const beauty = freeze(verifiedBeauty.map((source) => source.fact));
      const verifiedAnchors = preflightedAnchors
        ? await readPreflightedAnchorSource(preflightedAnchors, root, described.delivery, MAX_RENDER_DELIVERY_ANCHOR_BYTES)
        : undefined;
      const sourceFacts = freeze({ beauty, ...(verifiedAnchors ? { anchors: verifiedAnchors.fact } : {}) });
      const sourceByteLength = beauty.reduce((total, source) => total + source.byteLength, 0) + (verifiedAnchors?.fact.byteLength ?? 0);
      const fingerprint = renderDeliverySourceManifestFingerprint(described.fingerprint, described.plan, sourceFacts, sourceByteLength);
      const manifest = freeze({
        schema: "motion.render-delivery-source-manifest/v1" as const,
        fingerprint,
        delivery: described.delivery,
        deliveryFingerprint: described.fingerprint,
        plan: described.plan,
        sources: sourceFacts,
        sourceByteLength,
      });
      locationsByManifest.set(manifest, freeze({
        providerInputRoot: root,
        beauty: inputLocations.beauty.map((source, index) => freeze({ ...source, identity: verifiedBeauty[index]!.identity })),
        ...(inputLocations.anchors && verifiedAnchors ? { anchors: freeze({ ...inputLocations.anchors, identity: verifiedAnchors.identity }) } : {}),
      }));
      authorityByManifest.set(manifest, freeze({ ...(options.providerInputRootAuthority ? { providerInputRootAuthority: options.providerInputRootAuthority } : {}) }));
      return manifest;
    } catch (error) {
      if (error instanceof RenderDeliverySourceAdmissionError) throw error;
      throw new RenderDeliverySourceAdmissionError(classifySourceFailure(error));
    }
  });
}

/**
 * Re-read each source and require the original delivery, schedule, hash, byte length and file
 * identity. The later host adapter calls this immediately before its own retained-descriptor copy.
 */
export async function revalidateMotionRenderDeliverySources(
  manifest: MotionRenderDeliverySourceManifest,
  services: MotionRenderDeliverySourceAdmissionServices = {},
): Promise<MotionRenderDeliverySourceManifest> {
  const locations = locationsByManifest.get(manifest);
  if (!locations) throw new RenderDeliverySourceAdmissionError("source_identity");
  const delivery = describeMotionRenderDelivery(manifest.delivery);
  if (!delivery.ok || delivery.fingerprint !== manifest.deliveryFingerprint) {
    throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  }
  if (manifest.plan.deliveryFingerprint !== manifest.deliveryFingerprint
    || renderDeliverySourceManifestFingerprint(manifest.deliveryFingerprint, manifest.plan, manifest.sources, manifest.sourceByteLength) !== manifest.fingerprint) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  assertC5ABeautyDecoderBounds(delivery.delivery);

  const expected = expectedBeautySources(delivery.delivery, manifest.plan);
  const expectedAnchors = expectedAnchorSource(delivery.delivery, manifest.plan);
  if ((expectedAnchors === undefined) !== (locations.anchors === undefined) || (expectedAnchors === undefined) !== (manifest.sources.anchors === undefined)) {
    throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  }
  const budget = new BoundedResourceBudget(RENDER_DELIVERY_SOURCE_LIMITS, "provider delivery source");
  const sourceAuthority = authorityByManifest.get(manifest);
  if (!sourceAuthority) throw new RenderDeliverySourceAdmissionError("source_identity");
  try {
    await assertProviderInputRootAuthority(sourceAuthority.providerInputRootAuthority, locations.providerInputRoot);
  } catch {
    throw new RenderDeliverySourceAdmissionError("source_identity");
  }
  return await withProviderInputRootAuthority(sourceAuthority.providerInputRootAuthority, async () => {
    try {
      const preflightedBeauty = await preflightBeautySequence(locations.beauty, locations.providerInputRoot, expected, budget);
      const preflightedAnchors = expectedAnchors && locations.anchors
        ? await preflightAnchorSource(locations.anchors, locations.providerInputRoot, expectedAnchors, budget, MAX_RENDER_DELIVERY_ANCHOR_BYTES)
        : undefined;
      await services.afterPreflight?.();
      const actual = await readPreflightedBeautySequence(preflightedBeauty, locations.providerInputRoot, budget);
      const actualFacts = actual.map((source) => source.fact);
      const actualAnchors = preflightedAnchors
        ? await readPreflightedAnchorSource(preflightedAnchors, locations.providerInputRoot, delivery.delivery, MAX_RENDER_DELIVERY_ANCHOR_BYTES)
        : undefined;
      const actualSourceFacts = { beauty: actualFacts, ...(actualAnchors ? { anchors: actualAnchors.fact } : {}) };
      if (canonicalJsonSha256(actualFacts) !== canonicalJsonSha256(manifest.sources.beauty)
        || canonicalJsonSha256(actualSourceFacts) !== canonicalJsonSha256(manifest.sources)
        || canonicalJsonSha256(actual.map((source) => source.identity)) !== canonicalJsonSha256(locations.beauty.map((source) => source.identity))
        || (actualAnchors && locations.anchors && canonicalJsonSha256(actualAnchors.identity) !== canonicalJsonSha256(locations.anchors.identity))
        || actualFacts.reduce((total, source) => total + source.byteLength, 0) + (actualAnchors?.fact.byteLength ?? 0) !== manifest.sourceByteLength) {
        throw new RenderDeliverySourceAdmissionError("source_identity");
      }
      return manifest;
    } catch (error) {
      if (error instanceof RenderDeliverySourceAdmissionError) throw error;
      throw new RenderDeliverySourceAdmissionError(classifySourceFailure(error));
    }
  });
}

/**
 * Private handoff for the future Debug-owned COW adapter. Locations are absent from the manifest
 * and this accessor fails for reconstructed/deserialized values, preventing durable path storage.
 */
export function renderDeliveryEphemeralSourceLocations(manifest: MotionRenderDeliverySourceManifest): EphemeralSourceLocations {
  const locations = locationsByManifest.get(manifest);
  if (!locations) throw new RenderDeliverySourceAdmissionError("source_identity");
  return locations;
}

/**
 * Debug-only handoff for one original admitted manifest. It scopes the retained provider authority
 * around source descriptor use without serializing or exposing that authority to the Debug host.
 */
export async function withRenderDeliveryEphemeralSourceAuthority<T>(
  manifest: MotionRenderDeliverySourceManifest,
  operation: (locations: EphemeralSourceLocations) => Promise<T>,
): Promise<T> {
  const locations = locationsByManifest.get(manifest);
  const sourceAuthority = authorityByManifest.get(manifest);
  if (!locations || !sourceAuthority) throw new RenderDeliverySourceAdmissionError("source_identity");
  try {
    await assertProviderInputRootAuthority(sourceAuthority.providerInputRootAuthority, locations.providerInputRoot);
  } catch (error) {
    if (error instanceof RenderDeliverySourceAdmissionError) throw error;
    throw new RenderDeliverySourceAdmissionError("source_identity");
  }
  // The callback owns the distinct staged-package authority. Do not relabel its target write,
  // descriptor, topology, or transaction failures as provider-source failures.
  return await withProviderInputRootAuthority(sourceAuthority.providerInputRootAuthority, async () => await operation(locations));
}

/** Preserve the original host authority mode through revalidation; never synthesize an anchor. */
async function withProviderInputRootAuthority<T>(
  authority: TrustedWorkspaceAnchor | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return authority ? await withTrustedWorkspaceAnchor(authority, operation) : await operation();
}

async function assertProviderInputRootAuthority(
  authority: TrustedWorkspaceAnchor | undefined,
  root: string,
): Promise<void> {
  if (!authority) {
    if (process.platform !== "win32") throw new Error("A trusted provider-input-root authority is required on POSIX.");
    return;
  }
  await assertTrustedWorkspaceAnchorPath(authority, root);
}

/** Internal durable-fact identity shared with the private package receipt verifier. */
export function renderDeliverySourceManifestFingerprint(
  deliveryFingerprint: string,
  plan: MotionRenderDeliveryImportPlan,
  sources: MotionRenderDeliverySourceManifest["sources"],
  sourceByteLength: number,
): string {
  return canonicalJsonSha256({
    schema: "motion.render-delivery-source-manifest/v1",
    deliveryFingerprint,
    plan,
    sources,
    sourceByteLength,
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
