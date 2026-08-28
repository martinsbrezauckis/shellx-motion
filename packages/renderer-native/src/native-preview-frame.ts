/** One-shot Native frame wrapper over the reusable, load-once render session. */
import {
  createNativeRenderSession,
  type NativePreviewFrameResult
} from "./index.js";
import {
  assertNoStructuralNativePrivatePublication,
  resolveNativePrivateOutputPublication,
  withNativePrivateOutputPublication
} from "./private-output-publication.js";

export interface NativePreviewFrameInput {
  packageRoot: string;
  outputPath?: string;
  outputRoots?: string[];
  atMs?: number;
  now?: () => string;
}

/**
 * Render one Native preview frame. It opens then closes the reusable session, preserving
 * the established public one-frame contract while the private-stage capability remains opaque.
 */
export async function renderNativePreviewFrame(input: NativePreviewFrameInput): Promise<NativePreviewFrameResult> {
  assertNoStructuralNativePrivatePublication(input);
  const privateOutputPublication = resolveNativePrivateOutputPublication(input);
  const sessionInput = {
    packageRoot: input.packageRoot,
    ...(input.outputRoots ? { outputRoots: input.outputRoots } : {}),
    ...(input.now ? { now: input.now } : {})
  };
  const session = await createNativeRenderSession(privateOutputPublication
    ? withNativePrivateOutputPublication(sessionInput, privateOutputPublication)
    : sessionInput);
  try {
    return await session.renderFrameAtMs(input.atMs ?? 0, input.outputPath);
  } finally {
    session.close();
  }
}
