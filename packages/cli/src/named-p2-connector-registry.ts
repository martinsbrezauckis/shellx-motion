/** Current named P2 CLI verbs are trusted adapters over the same Motion-owned generic registry. */
import { motionCapabilityCatalog } from "@shellx-motion/core";
import {
  executePreparedMotionConnectorJob,
  prepareAdmittedMotionConnectorJob,
  type runCanvasToCutConnector,
  type runScriptToCutConnector,
  type runSourceToCutConnector,
  type runTemplateToCutConnector
} from "@shellx-motion/connectors";

const P2_CAPABILITY_BY_NAMED_CONNECTOR = Object.freeze({
  "canvas-to-cut": "connector.canvas-to-cut@1",
  "script-to-cut": "connector.script-to-cut@1",
  "source-to-cut": "connector.source-to-cut@1",
  "template-to-cut": "connector.template-to-cut@1"
} as const);

export type NamedP2ConnectorSubcommand = keyof typeof P2_CAPABILITY_BY_NAMED_CONNECTOR;

export async function runNamedP2ConnectorThroughRegistry(input: {
  subcommand: NamedP2ConnectorSubcommand;
  inputPath: string;
  outputPath: string;
  signal: AbortSignal;
  namedCompatibilityOptions: Readonly<Record<string, unknown>>;
}): Promise<
  | Awaited<ReturnType<typeof runCanvasToCutConnector>>
  | Awaited<ReturnType<typeof runScriptToCutConnector>>
  | Awaited<ReturnType<typeof runSourceToCutConnector>>
  | Awaited<ReturnType<typeof runTemplateToCutConnector>>
> {
  const capabilityId = P2_CAPABILITY_BY_NAMED_CONNECTOR[input.subcommand];
  const descriptor = motionCapabilityCatalog().descriptors.find((candidate) => candidate.id === capabilityId);
  if (!descriptor) throw new Error(`Named connector registry descriptor is unavailable: ${capabilityId}.`);
  const prepared = prepareAdmittedMotionConnectorJob({
    capabilityId,
    descriptorRevision: descriptor.revision,
    descriptorFingerprint: descriptor.fingerprint,
    requestSchemaId: descriptor.request.id,
    request: { input: "named_input", output: "named_output" }
  });
  const execution = await executePreparedMotionConnectorJob(prepared, {
    signal: input.signal,
    namedCompatibilityOptions: input.namedCompatibilityOptions,
    references: {
      async resolvePath(reference) {
        if (reference.fieldId === "input" && reference.reference === "named_input" && reference.access === "read") return input.inputPath;
        if (reference.fieldId === "output" && reference.reference === "named_output" && reference.access === "write") return input.outputPath;
        throw new Error(`Named connector reference was refused: ${reference.fieldId}.`);
      }
    }
  });
  if (!execution.ok) throw new NamedConnectorRegistryError(execution.error.code, execution.error.message);
  return execution.result as
    | Awaited<ReturnType<typeof runCanvasToCutConnector>>
    | Awaited<ReturnType<typeof runScriptToCutConnector>>
    | Awaited<ReturnType<typeof runSourceToCutConnector>>
    | Awaited<ReturnType<typeof runTemplateToCutConnector>>;
}

export class NamedConnectorRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NamedConnectorRegistryError";
  }
}
