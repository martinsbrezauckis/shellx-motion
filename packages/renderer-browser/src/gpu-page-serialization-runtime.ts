/**
 * Fixed page bootstrap for source-mode builds transformed by TSX/esbuild.
 *
 * Those transforms preserve function names by inserting `__name(fn, name)`
 * inside functions which Playwright later serializes in isolation. The helper
 * itself lives in Node and is therefore absent in Chromium. Installed-package
 * output emitted by TypeScript does not need this compatibility binding, but
 * the same immutable bootstrap is harmless there and is fingerprinted with the
 * rest of the page runtime.
 */
export const GPU_PAGE_SERIALIZATION_RUNTIME = `(() => {
  const marker = "__SHELLX_MOTION_PAGE_SERIALIZATION_RUNTIME__";
  if (Object.prototype.hasOwnProperty.call(globalThis, "__name")) {
    return globalThis[marker] === true;
  }
  Object.defineProperty(globalThis, "__name", {
    value: (target) => target,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(globalThis, marker, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });
  return globalThis.__name(() => true, "shellxMotionSerializationProbe")() === true;
})()`;
