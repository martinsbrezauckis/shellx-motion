/** Tears down the exact page-held device. Browser close remains the outer fallback. */
export async function closeWebGpuPageSession(): Promise<{ dynamicImageTextureDestructions: number }> {
  const browserGlobal = globalThis as unknown as { __shellxMotionGpuSessionV1?: { device?: { destroy?(): void }; images?: Map<string,{texture:{destroy?():void}; dynamic?: boolean}>; textSurfaces?: Map<string,{texture:{destroy?():void}}>; dynamicImages?: { reservations?: Map<string, unknown>; metrics: { destructions: number } }; computeParticles?: { destroy(): void }; computeParticlesV2?: { destroy(): void }; instanceBuffers?: { destroy(): void }; resources?: { destroy():void } } };
  const state = browserGlobal.__shellxMotionGpuSessionV1;
  delete browserGlobal.__shellxMotionGpuSessionV1;
  let dynamicImageTextureDestructions = 0;
  try {
    state?.resources?.destroy?.(); state?.instanceBuffers?.destroy?.(); state?.computeParticles?.destroy?.(); state?.computeParticlesV2?.destroy?.();
    const dynamicIds = new Set(state?.dynamicImages?.reservations?.keys() ?? []);
    for (const [id, image] of state?.images?.entries() ?? []) {
      image.texture.destroy?.();
      if (dynamicIds.has(id)) dynamicImageTextureDestructions += 1;
    }
    if (state?.dynamicImages) state.dynamicImages.metrics.destructions += dynamicImageTextureDestructions;
    for (const text of state?.textSurfaces?.values() ?? []) text.texture.destroy?.(); state?.device?.destroy?.();
  } catch { /* browser close remains the final boundary */ }
  return { dynamicImageTextureDestructions };
}
