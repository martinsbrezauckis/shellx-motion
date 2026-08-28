/**
 * Native compatibility surface for the delivery-text policy.
 *
 * Core owns the pure policy so renderer capability discovery and native delivery sessions cannot
 * disagree; this module preserves the native package's established public exports.
 */
export {
  nativeTextDeliveryIssues,
  nativeTextDeliveryMessage,
  requestedNativeTextFontFamily as requestedFontFamily,
  type NativeTextDeliveryIssue
} from "@shellx-motion/core";
