/** Exact direct-hybrid receipt admission; Browser owns capture, FFmpeg owns final projection. */
import { canonicalJson, AGENT_SCRIPT_RESOLVER_VERSION, isSafeShaderUniformName, MAX_RESTRICTED_SHADER_UNIFORMS } from "@shellx-motion/core";
import { createHash } from "node:crypto";
import type { GpuStreamingFrameProducerEvidence } from "@shellx-motion/renderer-browser";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TEXTURE_DIMENSION = 4_096;
const MAX_TEXTURE_PIXELS = 16 * 1024 * 1024;

type DirectHybrid = NonNullable<GpuStreamingFrameProducerEvidence["hybrid"]>;

export function exactDirectHybridEvidence(value: GpuStreamingFrameProducerEvidence["hybrid"], canonicalFrameCount: number): {
  sourceBindingSha256: string;
  captureFrameSequenceSha256: string;
  exactCaptureLedgerSequenceSha256: string;
} | undefined {
  const legacySequence = value?.captureFrameSequenceSha256;
  const exactSequence = value?.exactCaptureLedgerSequenceSha256;
  if (value === null || !Number.isSafeInteger(value.capturedFrames) || value.capturedFrames < 1 || value.capturedFrames > canonicalFrameCount
    || !SHA256.test(legacySequence ?? "") || !SHA256.test(exactSequence ?? "")
    || !directHybridSourceBinding(value)) return undefined;
  const { capturedFrames: _capturedFrames, captureFrameSequenceSha256: _legacy, exactCaptureLedgerSequenceSha256: _exact, ...sourceBinding } = value;
  return {
    sourceBindingSha256: createHash("sha256").update(canonicalJson(sourceBinding)).digest("hex"),
    captureFrameSequenceSha256: legacySequence!,
    exactCaptureLedgerSequenceSha256: exactSequence!
  };
}

function directHybridSourceBinding(value: DirectHybrid): boolean {
  if (!commonBinding(value)) return false;
  if (value.schema === "shellx-motion/gpu-hybrid-capture@1") return htmlBinding(value);
  return restrictedShaderBinding(value);
}

function commonBinding(value: DirectHybrid): boolean {
  if (!nonEmpty(value.layerId) || !packagePath(value.source) || !browser(value.browser)
    || !strictDataOnlyScript(value.scriptExecution) || !noEgressNetwork(value.network)
    || !hashRecord(value.inputHashes)) return false;
  return value.schema === "shellx-motion/gpu-hybrid-capture@1"
    ? exactKeys(value, HTML_BINDING_KEYS)
    : exactKeys(value, RESTRICTED_BINDING_KEYS);
}

function htmlBinding(value: Extract<DirectHybrid, { schema: "shellx-motion/gpu-hybrid-capture@1" }>): boolean {
  const source = value.sourceDocument;
  return value.classification === "gpu-hybrid" && value.producer === "governed-browser-surface"
    && value.browserOwnership === "borrowed-gpu-runtime" && value.captureScope === "declared-browser-source-document"
    && value.typography === "browser-html-canvas-unverified" && record(source)
    && exactKeys(source, ["schema", "policy", "source", "sourceSha256", "byteLength"])
    && source.schema === "shellx-motion/gpu-hybrid-html-policy@1" && source.policy === "strict-data-only-html"
    && source.source === value.source && SHA256.test(source.sourceSha256)
    && boundedInteger(source.byteLength, 1, 8 * 1024 * 1024)
    && htmlInputHashes(value.inputHashes, value.source, source.sourceSha256);
}

function restrictedShaderBinding(value: Exclude<DirectHybrid, { schema: "shellx-motion/gpu-hybrid-capture@1" }>): boolean {
  const shader = value.shader, texture = value.texture;
  return value.schema === "shellx-motion/gpu-restricted-shader-hybrid@1"
    && value.classification === "gpu-restricted-shader-hybrid" && value.producer === "governed-restricted-glsl-webgl"
    && value.browserOwnership === "borrowed-gpu-runtime" && value.captureScope === "isolated-shader-layer-texture"
    && value.typography === "not-applicable-isolated-webgl" && record(shader) && record(texture)
    && exactKeys(shader, ["schema", "language", "assetRef", "sourceSha256", "byteLength", "seed", "uniformNames", "validation"])
    && shader.schema === "shellx-motion/shader-plugin@1" && shader.language === "glsl-es-100-expression"
    && shader.assetRef === value.source && SHA256.test(shader.sourceSha256)
    && boundedInteger(shader.byteLength, 1, 16 * 1024) && boundedInteger(shader.seed, 0, 0xffff_ffff)
    && uniqueSortedNames(shader.uniformNames) && shader.validation === "restricted-expression-only"
    && exactKeys(texture, ["width", "height", "encoding", "alpha"])
    && texture.encoding === "png" && texture.alpha === "straight-rgba" && dimensions(texture.width, texture.height)
    && restrictedInputHashes(value.inputHashes, value.source, shader.sourceSha256);
}

function strictDataOnlyScript(value: unknown): boolean {
  return record(value) && exactKeys(value, ["schema", "detectedClass", "requestedMode", "activeMode", "resolverVersion", "sources"])
    && value.schema === "shellx-motion/script-execution@1" && value.detectedClass === "data-only"
    && value.requestedMode === "none" && value.activeMode === "data-only"
    && value.resolverVersion === AGENT_SCRIPT_RESOLVER_VERSION && Array.isArray(value.sources) && value.sources.length === 0;
}

function noEgressNetwork(value: unknown): boolean {
  if (!record(value) || !exactKeys(value, ["policy", "allowPrivateNetwork", "resolutionTimeoutMs", "approvedOrigins", "pins", "responsePolicy"])
    || value.policy !== "host-approved-origins" || value.allowPrivateNetwork !== false
    || !boundedInteger(value.resolutionTimeoutMs, 1, 30_000) || !Array.isArray(value.approvedOrigins) || value.approvedOrigins.length !== 0
    || !Array.isArray(value.pins) || value.pins.length !== 0 || !record(value.responsePolicy)) return false;
  const policy = value.responsePolicy;
  return exactKeys(policy, ["maxResponseBytes", "maxAggregateBytes", "maxConcurrentResponses", "contentTypes"])
    && boundedInteger(policy.maxResponseBytes, 1, 64 * 1024 * 1024)
    && boundedInteger(policy.maxAggregateBytes, policy.maxResponseBytes as number, 256 * 1024 * 1024)
    && boundedInteger(policy.maxConcurrentResponses, 1, 8) && policy.contentTypes === "bounded-render-media";
}

function htmlInputHashes(value: Readonly<Record<string, string>>, source: string, sha256: string): boolean {
  return value.motion !== undefined && value.html !== undefined && value[`browser-package/${source}`] === sha256;
}

function restrictedInputHashes(value: Readonly<Record<string, string>>, source: string, sha256: string): boolean {
  return value.motion !== undefined && value[source] === sha256;
}

function hashRecord(value: unknown): value is Readonly<Record<string, string>> {
  return record(value) && Object.keys(value).length > 0
    && Object.entries(value).every(([key, hash]) => nonEmpty(key) && typeof hash === "string" && SHA256.test(hash));
}

function browser(value: unknown): boolean {
  return record(value) && exactKeys(value, ["name", "version"])
    && value.name === "chromium" && nonEmpty(value.version);
}

function dimensions(width: unknown, height: unknown): boolean {
  return boundedInteger(width, 1, MAX_TEXTURE_DIMENSION) && boundedInteger(height, 1, MAX_TEXTURE_DIMENSION)
    && (width as number) * (height as number) <= MAX_TEXTURE_PIXELS;
}

function uniqueSortedNames(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_RESTRICTED_SHADER_UNIFORMS
    && value.every((name) => typeof name === "string" && isSafeShaderUniformName(name))
    && value.every((name, index) => index === 0 || value[index - 1] < name);
}

function packagePath(value: unknown): value is string {
  return nonEmpty(value) && value.length <= 1_024 && !value.includes("\\") && !value.includes("\0")
    && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: object, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); const ordered = [...expected].sort(); return keys.length === ordered.length && keys.every((key, index) => key === ordered[index]); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }

const HTML_BINDING_KEYS = ["schema", "classification", "producer", "browserOwnership", "captureScope", "layerId", "source", "sourceDocument", "browser", "scriptExecution", "network", "inputHashes", "typography", "capturedFrames", "captureFrameSequenceSha256", "exactCaptureLedgerSequenceSha256"] as const;
const RESTRICTED_BINDING_KEYS = ["schema", "classification", "producer", "browserOwnership", "captureScope", "layerId", "source", "shader", "texture", "browser", "scriptExecution", "network", "inputHashes", "typography", "capturedFrames", "captureFrameSequenceSha256", "exactCaptureLedgerSequenceSha256"] as const;
