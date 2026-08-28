const MAX_GROUP_CHILDREN = 256;
const MAX_GROUPS = 64;
const MAX_GROUP_DEPTH = 4;

/** Validates ownership, local timing, cycles and nesting for group/precomposition layers. */
export function validateMotionGroups(layers: unknown[], errors: Array<{ path: string; message: string }>): void {
  const records = layers.map(record); const ids = new Map<string, number>();
  records.forEach((layer, index) => { if (layer && typeof layer.id === "string") ids.set(layer.id, index); });
  const owners = new Map<string, string>(); const groups = new Map<string, { index: number; children: string[] }>();
  records.forEach((layer, index) => {
    if (!layer) return; const children = layer.childLayerIds;
    if (layer.type !== "group") {
      if (children !== undefined) errors.push({ path: `/layers/${index}/childLayerIds`, message: "is supported only on group layers" });
      return;
    }
    if (!Array.isArray(children) || children.length < 1 || children.length > MAX_GROUP_CHILDREN) {
      errors.push({ path: `/layers/${index}/childLayerIds`, message: `must contain 1..${MAX_GROUP_CHILDREN} unique layer ids` }); return;
    }
    const values: string[] = []; const seen = new Set<string>();
    children.forEach((child, childIndex) => {
      const path = `/layers/${index}/childLayerIds/${childIndex}`;
      if (typeof child !== "string" || child.length === 0) { errors.push({ path, message: "must be a non-empty string" }); return; }
      if (seen.has(child)) { errors.push({ path, message: "must be unique within the group" }); return; } seen.add(child); values.push(child);
      if (child === layer.id) errors.push({ path, message: "cannot reference the group itself" });
      const childIndexInLayers = ids.get(child); if (childIndexInLayers === undefined) errors.push({ path, message: "must reference an existing layer" });
      const prior = owners.get(child); if (prior && prior !== layer.id) errors.push({ path, message: `is already owned by group ${prior}` }); else owners.set(child, String(layer.id));
      const childLayer = childIndexInLayers === undefined ? null : records[childIndexInLayers];
      if (childLayer && finite(childLayer.startMs) && finite(childLayer.durationMs) && finite(layer.durationMs) && (Number(childLayer.startMs) < 0 || Number(childLayer.startMs) + Number(childLayer.durationMs) > Number(layer.durationMs))) {
        errors.push({ path, message: "must fit within the owning group's local timeline" });
      }
    });
    if (typeof layer.id === "string") groups.set(layer.id, { index, children: values });
  });
  if (groups.size > MAX_GROUPS) errors.push({ path: "/layers", message: `must contain at most ${MAX_GROUPS} group layers` });
  const visiting = new Set<string>(); const complete = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const group = groups.get(id); if (!group || complete.has(id)) return;
    if (visiting.has(id)) { errors.push({ path: `/layers/${group.index}/childLayerIds`, message: "must not contain a group cycle" }); return; }
    if (depth > MAX_GROUP_DEPTH) { errors.push({ path: `/layers/${group.index}/childLayerIds`, message: `group nesting must not exceed depth ${MAX_GROUP_DEPTH}` }); return; }
    visiting.add(id); for (const child of group.children) visit(child, depth + 1); visiting.delete(id); complete.add(id);
  };
  for (const id of groups.keys()) visit(id, 1);
}

function record(value: unknown): Record<string, unknown> | null { return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function finite(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value); }
