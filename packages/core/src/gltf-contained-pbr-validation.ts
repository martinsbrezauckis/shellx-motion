import type { ParsedGltfContainer } from "./gltf-types";

/** The material route has a deliberately small structural inspection budget. */
export const MAX_GLTF_CONTAINED_PBR_JSON_CONTAINERS = 4_096;

/**
 * Rejects glTF's inheritable extension hooks across the complete parsed data tree.
 *
 * `extensions` and `extras` can occur on every glTF property object, including property
 * families the closed subset subsequently rejects. Walking the parsed JSON containers rather
 * than only the selected scene/material schema means an extension cannot hide in an otherwise
 * unconsulted mesh, camera, sparse accessor, or nested PBR record. This is iterative and caps
 * the number of records/arrays before following children.
 */
export function assertGltfContainedPbrNoExtensionsOrExtras(container: ParsedGltfContainer): void {
  const pending: Array<{ value: object; path: string }> = [{ value: container.json, path: "glTF document" }];
  const seen = new WeakSet<object>();
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.value)) throw new Error(`Contained glTF PBR JSON must be acyclic; repeated value at ${current.path}.`);
    seen.add(current.value);
    inspected += 1;
    if (inspected > MAX_GLTF_CONTAINED_PBR_JSON_CONTAINERS) {
      throw new Error(`Contained glTF PBR JSON exceeds ${MAX_GLTF_CONTAINED_PBR_JSON_CONTAINERS} object/array containers.`);
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => queueChild(child, `${current.path}[${index}]`, pending));
      continue;
    }
    if (Object.getPrototypeOf(current.value) !== Object.prototype) {
      throw new Error(`Contained glTF PBR ${current.path} must be a plain JSON object.`);
    }
    const record = current.value as Record<string, unknown>;
    if (Object.hasOwn(record, "extensions") || Object.hasOwn(record, "extras")) {
      throw new Error(`Contained glTF PBR ${current.path} uses extensions or extras, which are not supported.`);
    }
    for (const [key, child] of Object.entries(record)) queueChild(child, `${current.path}.${key}`, pending);
  }
}

/** Extra top-level exclusions for the one static contained-PNG PBR transaction route. */
export function assertGltfContainedPbrStaticFeatureSubset(container: ParsedGltfContainer): void {
  assertGltfContainedPbrNoExtensionsOrExtras(container);
  for (const field of ["animations", "skins", "samplers", "cameras"] as const) {
    if (Array.isArray(container.json[field]) && container.json[field].length > 0) {
      throw new Error(`Contained glTF PBR ${field} are not supported by the fixed static route.`);
    }
  }
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) {
    if (container.json[field] !== undefined && (!Array.isArray(container.json[field]) || container.json[field].length > 0)) {
      throw new Error(`Contained glTF PBR ${field} must be empty.`);
    }
  }
}

function queueChild(value: unknown, path: string, pending: Array<{ value: object; path: string }>): void {
  if (value !== null && typeof value === "object") pending.push({ value, path });
}
