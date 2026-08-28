/** Host-held producer authentication for public attested-render-reuse descriptors. */
import {
  canonicalJson,
  canonicalJsonSha256,
  readBoundedStableFile,
  writeVerifiedBoundedFile,
  type AttestedRenderReuseDescriptor,
} from "@shellx-motion/core";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, resolve } from "node:path";

export const ATTESTED_RENDER_REUSE_PRODUCER_SCHEMA = "shellx-motion/attested-render-reuse-producer@1" as const;
const MAX_PRODUCER_PROOF_BYTES = 8 * 1024;
const authorityKeys = new WeakMap<object, Buffer>();
declare const producerAuthorityBrand: unique symbol;

/**
 * Opaque host authority. Command arguments and package data can never construct one; an embedding
 * host injects it into MotionDebugContext after retaining its key outside caller output roots.
 */
export interface AttestedRenderReuseProducerAuthority {
  readonly [producerAuthorityBrand]: true;
}

export interface AttestedRenderReuseProducerProof {
  schema: typeof ATTESTED_RENDER_REUSE_PRODUCER_SCHEMA;
  cacheKey: string;
  descriptorId: string;
  descriptorSha256: string;
  outputRootSha256: string;
  createdAt: string;
  authentication: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

export function configureAttestedRenderReuseProducerAuthority(input: {
  key: Uint8Array;
}): AttestedRenderReuseProducerAuthority {
  if (!(input.key instanceof Uint8Array) || input.key.byteLength < 32) {
    throw new Error("Attested render reuse producer authority requires at least 256 bits of host-held key material.");
  }
  const authority = Object.freeze({}) as AttestedRenderReuseProducerAuthority;
  authorityKeys.set(authority, Buffer.from(input.key));
  return authority;
}

/** Process-lifetime authority for trusted in-process hosts that did not configure durable reuse. */
export function createEphemeralAttestedRenderReuseProducerAuthority(): AttestedRenderReuseProducerAuthority {
  return configureAttestedRenderReuseProducerAuthority({ key: randomBytes(32) });
}

export function attestedRenderReuseProducerProofPath(root: string, cacheKey: string): string {
  assertSha256(cacheKey, "cache key");
  return join(resolve(root), ".shellx-motion", "render-reuse", "v2", `${cacheKey}.producer.json`);
}

export async function issueAndWriteAttestedRenderReuseProducerProof(input: {
  authority: AttestedRenderReuseProducerAuthority;
  root: string;
  descriptor: AttestedRenderReuseDescriptor;
}): Promise<AttestedRenderReuseProducerProof> {
  const proof = issueProof(input.authority, input.root, input.descriptor);
  const path = attestedRenderReuseProducerProofPath(input.root, input.descriptor.cacheKey);
  const bytes = Buffer.from(`${canonicalJson(proof)}\n`, "utf8");
  await writeVerifiedBoundedFile(path, bytes, {
    label: "attested render reuse producer proof",
    maxBytes: MAX_PRODUCER_PROOF_BYTES,
    withinRoot: input.root,
  });
  return proof;
}

export async function verifyAttestedRenderReuseProducerProof(input: {
  authority: AttestedRenderReuseProducerAuthority;
  root: string;
  descriptor: AttestedRenderReuseDescriptor;
}): Promise<AttestedRenderReuseProducerProof> {
  const path = attestedRenderReuseProducerProofPath(input.root, input.descriptor.cacheKey);
  const file = await readBoundedStableFile(path, {
    label: "attested render reuse producer proof",
    maxBytes: MAX_PRODUCER_PROOF_BYTES,
    withinRoot: input.root,
    requireSingleLink: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    throw new Error("attested render reuse producer proof is not JSON");
  }
  const proof = readProof(parsed);
  if (!file.bytes.equals(Buffer.from(`${canonicalJson(proof)}\n`, "utf8"))) {
    throw new Error("attested render reuse producer proof is not canonical");
  }
  const expected = issueProof(input.authority, input.root, input.descriptor);
  if (!sameProofFacts(proof, expected) || !safeEqualHex(proof.authentication.value, expected.authentication.value)) {
    throw new Error("attested render reuse producer proof was not issued by this host for the current descriptor");
  }
  return proof;
}

function issueProof(
  authority: AttestedRenderReuseProducerAuthority,
  root: string,
  descriptor: AttestedRenderReuseDescriptor,
): AttestedRenderReuseProducerProof {
  const key = authorityKeys.get(authority);
  if (!key) throw new Error("Attested render reuse producer authority is not host-issued.");
  const unsigned = {
    schema: ATTESTED_RENDER_REUSE_PRODUCER_SCHEMA,
    cacheKey: descriptor.cacheKey,
    descriptorId: descriptor.id,
    descriptorSha256: canonicalJsonSha256(descriptor),
    outputRootSha256: canonicalJsonSha256({ schema: "shellx-motion/attested-render-reuse-output-root@1", root: resolve(root) }),
    createdAt: descriptor.createdAt,
  } as const;
  return {
    ...unsigned,
    authentication: {
      algorithm: "hmac-sha256",
      value: createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex"),
    },
  };
}

function readProof(value: unknown): AttestedRenderReuseProducerProof {
  const record = objectRecord(value);
  if (!record || !exactKeys(record, ["authentication", "cacheKey", "createdAt", "descriptorId", "descriptorSha256", "outputRootSha256", "schema"])) {
    throw new Error("attested render reuse producer proof has invalid fields");
  }
  const authentication = objectRecord(record.authentication);
  if (!authentication || !exactKeys(authentication, ["algorithm", "value"]) || authentication.algorithm !== "hmac-sha256") {
    throw new Error("attested render reuse producer proof has invalid authentication fields");
  }
  if (record.schema !== ATTESTED_RENDER_REUSE_PRODUCER_SCHEMA || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("attested render reuse producer proof has invalid identity fields");
  }
  if (typeof record.cacheKey !== "string" || typeof record.descriptorId !== "string" || typeof record.descriptorSha256 !== "string"
    || typeof record.outputRootSha256 !== "string" || typeof authentication.value !== "string") {
    throw new Error("attested render reuse producer proof has invalid scalar fields");
  }
  assertSha256(record.cacheKey, "cache key");
  assertSha256(record.descriptorSha256, "descriptor hash");
  assertSha256(record.outputRootSha256, "output-root hash");
  assertSha256(authentication.value, "authentication value");
  return {
    schema: ATTESTED_RENDER_REUSE_PRODUCER_SCHEMA,
    cacheKey: record.cacheKey,
    descriptorId: record.descriptorId,
    descriptorSha256: record.descriptorSha256,
    outputRootSha256: record.outputRootSha256,
    createdAt: record.createdAt,
    authentication: { algorithm: "hmac-sha256", value: authentication.value },
  };
}

function sameProofFacts(left: AttestedRenderReuseProducerProof, right: AttestedRenderReuseProducerProof): boolean {
  return left.schema === right.schema
    && left.cacheKey === right.cacheKey
    && left.descriptorId === right.descriptorId
    && left.descriptorSha256 === right.descriptorSha256
    && left.outputRootSha256 === right.outputRootSha256
    && left.createdAt === right.createdAt
    && left.authentication.algorithm === right.authentication.algorithm;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`attested render reuse producer ${label} must be a SHA-256 hex digest`);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}
