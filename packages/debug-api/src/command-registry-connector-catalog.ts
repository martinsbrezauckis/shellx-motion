import type { MotionDebugCommandDefinitionBase } from "./command-registry.js";

export const CONNECTOR_CATALOG_COMMAND_DEFINITIONS = [
  { command: "motion.connector.catalog", domain: "integration", permission: "read_motion", mutates: false }
] as const satisfies readonly MotionDebugCommandDefinitionBase[];
