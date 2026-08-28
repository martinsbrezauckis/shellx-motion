import { PUBLIC_SCHEMA_EXTENSION_COMMENT } from "./motion-public-schema-environments";

/** Portable object shape; geometry, single-subpath, and stroke ownership are runtime semantics. */
export const PATH_REVEAL_SCHEMA = {
  type: "object",
  required: ["start", "end"],
  additionalProperties: false,
  properties: {
    start: { type: "number", minimum: 0, maximum: 1 },
    end: { type: "number", minimum: 0, maximum: 1 }
  },
  $comment: "The runtime additionally requires one validated SVG path subpath and an explicit visible positive-width stroke. end <= start is an empty runtime window. " + PUBLIC_SCHEMA_EXTENSION_COMMENT
};
