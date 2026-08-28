/** Build the server's fail-closed render context from host-owned authority only. */
export function strictServerRenderContext<Context extends object, ReuseAuthority, EffectAuthority>(
  serverContext: Context,
  attestedRenderReuseProducerAuthority: ReuseAuthority,
  gpuEffectModuleUseAuthority?: EffectAuthority,
): Context & {
  attestedRenderReuseProducerAuthority: ReuseAuthority;
  enforceRenderRoots: true;
  gpuEffectModuleUseAuthority?: EffectAuthority;
} {
  return {
    ...serverContext,
    attestedRenderReuseProducerAuthority,
    // Every server transport is a privilege boundary. It must have explicit
    // render roots; unlike an in-process host it may not inherit legacy
    // unconstrained render paths.
    enforceRenderRoots: true,
    ...(gpuEffectModuleUseAuthority ? { gpuEffectModuleUseAuthority } : {})
  };
}
