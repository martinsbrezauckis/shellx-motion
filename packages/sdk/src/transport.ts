/** Local handler transport that preserves SDK request identity and error envelopes. */
import {
  MOTION_SDK_SCHEMA,
  type MotionSdkError,
  type MotionSdkOperation,
  type MotionSdkRequestMap,
  type MotionSdkResponseMap,
  type MotionSdkTransport,
  type MotionSdkTransportRequest,
  type MotionSdkTransportResponse
} from "./types";

export type MotionSdkHandlerResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: MotionSdkError; warnings?: string[] };

export type MotionSdkHandler<K extends MotionSdkOperation> = (
  input: MotionSdkRequestMap[K],
  request: Pick<MotionSdkTransportRequest<K>, "requestId" | "cacheKey">
) => MotionSdkHandlerResult<MotionSdkResponseMap[K]> | Promise<MotionSdkHandlerResult<MotionSdkResponseMap[K]>>;

export type MotionSdkHandlers = { [K in MotionSdkOperation]?: MotionSdkHandler<K> };

export function createMotionSdkHandlerTransport(handlers: MotionSdkHandlers): MotionSdkTransport {
  return {
    async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>): Promise<MotionSdkTransportResponse<K>> {
      const handler = handlers[request.operation] as MotionSdkHandler<K> | undefined;
      if (!handler) {
        return {
          schema: MOTION_SDK_SCHEMA,
          operation: request.operation,
          requestId: request.requestId,
          cacheKey: request.cacheKey,
          ok: false,
          error: { code: "capability_unavailable", message: `Motion SDK ${request.operation} is unavailable on this transport.`, retryable: false },
          warnings: []
        };
      }
      try {
        const result = await handler(request.input, { requestId: request.requestId, cacheKey: request.cacheKey });
        return result.ok
          ? { schema: MOTION_SDK_SCHEMA, operation: request.operation, requestId: request.requestId, cacheKey: request.cacheKey, ok: true, output: result.output }
          : { schema: MOTION_SDK_SCHEMA, operation: request.operation, requestId: request.requestId, cacheKey: request.cacheKey, ok: false, error: result.error, warnings: result.warnings ?? [] };
      } catch (error) {
        return {
          schema: MOTION_SDK_SCHEMA,
          operation: request.operation,
          requestId: request.requestId,
          cacheKey: request.cacheKey,
          ok: false,
          error: { code: "handler_failed", message: error instanceof Error ? error.message : String(error), retryable: false },
          warnings: []
        };
      }
    }
  };
}
