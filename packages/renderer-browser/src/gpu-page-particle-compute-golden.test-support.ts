/** Float32-tolerant reference for the one fixed WGSL analytic field. Test-only, no runtime fallback. */
export function evaluateFixedGpuParticleGolden(input: {
  seed: number; index: number; atMs: number; startMs: number; lifetimeMs: number; width: number; height: number;
  minSize: number; maxSize: number; minSpeed: number; maxSpeed: number; direction: number; spread: number; gravity: number; fadeOut: boolean;
  color: { r: number; g: number; b: number; a: number }; secondaryColor: { r: number; g: number; b: number; a: number };
  sources: ReadonlyArray<{ kind: "radial" | "vortex"; centerX: number; centerY: number; strength: number; softening: number }>;
}): { x: number; y: number; size: number; color: { r: number; g: number; b: number; a: number } } {
  const random = (channel: number): number => {
    let value = (input.seed ^ Math.imul((input.index + 1) >>> 0, 0x9e3779b1) ^ Math.imul((channel + 1) >>> 0, 0x85ebca6b)) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0; value = Math.imul(value, 0x7feb352d) >>> 0;
    value = (value ^ (value >>> 15)) >>> 0; value = Math.imul(value, 0x846ca68b) >>> 0;
    return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
  };
  const phase = random(0) * input.lifetimeMs;
  const age = (Math.max(0, input.atMs - input.startMs) + phase) % input.lifetimeMs;
  const progress = age / input.lifetimeMs;
  const angle = (input.direction + (random(1) - 0.5) * input.spread) * Math.PI / 180;
  const speed = input.minSpeed + random(2) * (input.maxSpeed - input.minSpeed);
  const size = input.minSize + random(3) * (input.maxSize - input.minSize);
  const seconds = age / 1_000;
  const baseX = input.width / 2 + Math.cos(angle) * speed * seconds;
  const baseY = input.height / 2 + Math.sin(angle) * speed * seconds + 0.5 * input.gravity * seconds * seconds;
  let dx = 0, dy = 0;
  for (const source of input.sources) {
    const x = source.centerX - baseX / input.width, y = source.centerY - baseY / input.height, distance2 = x * x + y * y;
    if (distance2 === 0) continue;
    const distance = Math.sqrt(distance2), magnitude = source.strength * progress * progress * (source.softening * source.softening / (distance2 + source.softening * source.softening));
    if (source.kind === "vortex") { dx -= y / distance * magnitude; dy += x / distance * magnitude; } else { dx += x / distance * magnitude; dy += y / distance * magnitude; }
  }
  const chosen = random(4) < 0.5 ? input.color : input.secondaryColor;
  return { x: Math.fround(baseX + Math.max(-2, Math.min(2, dx)) * input.width), y: Math.fround(baseY + Math.max(-2, Math.min(2, dy)) * input.height), size: Math.fround(size), color: { ...chosen, a: Math.fround(chosen.a * (input.fadeOut ? Math.max(0, 1 - progress) : 1)) } };
}
