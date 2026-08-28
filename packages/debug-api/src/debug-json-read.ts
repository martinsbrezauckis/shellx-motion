import { readBoundedStableFile } from "@shellx-motion/core";

const MAX_DEBUG_JSON_BYTES = 4 * 1024 * 1024;

/** Host JSON reader shared by command paths; bounded and descriptor-stable before parsing. */
export async function readDebugJson(path: string, withinRoot?: string): Promise<unknown> {
  const file = await readBoundedStableFile(path, {
    label: "Debug JSON input",
    maxBytes: MAX_DEBUG_JSON_BYTES,
    ...(withinRoot ? { withinRoot } : {})
  });
  return JSON.parse(file.bytes.toString("utf8"));
}
