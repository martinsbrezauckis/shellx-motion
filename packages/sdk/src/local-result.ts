import { isPublicationCommitUncertain } from "@shellx-motion/core";
import type { MotionSdkHandlerResult } from "./transport.js";

export async function localResult<T>(run: () => Promise<T>): Promise<MotionSdkHandlerResult<T>> {
  try {
    return { ok: true, output: await run() };
  } catch (error) {
    if (isPublicationCommitUncertain(error)) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: false,
          detail: {
            possiblyCommitted: true,
            publicPaths: [error.evidence.publicPath],
            expectedPublication: error.evidence
          }
        }
      };
    }
    return {
      ok: false,
      error: error instanceof LocalMotionSdkError
        ? {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.detail !== undefined ? { detail: error.detail } : {}),
          }
        : {
            code: "local_operation_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
    };
  }
}

/**
 * Error carrying an SDK error code out of an in-process operation.
 *
 * `detail` is optional structured context forwarded verbatim into `MotionSdkError.detail`, so a
 * refusal that the Debug API answers with extra fields (a correction, the offending layers) can
 * reach an SDK caller without being flattened into prose it would have to parse back out.
 */
export class LocalMotionSdkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}
