export function proceduralTopologicalOrder(ids: Iterable<string>, dependencies: Map<string, Set<string>>): string[] {
  const all = [...ids].sort();
  const degree = new Map(all.map((id) => [id, dependencies.get(id)?.size ?? 0]));
  const outgoing = new Map<string, string[]>();
  for (const [target, sources] of dependencies) {
    for (const source of sources) outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
  }
  const ready = all.filter((id) => degree.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const target of (outgoing.get(id) ?? []).sort()) {
      const next = (degree.get(target) ?? 1) - 1;
      degree.set(target, next);
      if (next === 0) { ready.push(target); ready.sort(); }
    }
  }
  return order;
}

export function proceduralGraphDepth(order: string[], dependencies: Map<string, Set<string>>): number {
  const depth = new Map<string, number>();
  for (const id of order) {
    depth.set(id, 1 + Math.max(0, ...[...(dependencies.get(id) ?? [])].map((source) => depth.get(source) ?? 0)));
  }
  return Math.max(0, ...depth.values());
}
