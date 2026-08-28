/** Shared hard caps for host-declared receipt-store inspection. */
export const MAX_DEBUG_JSON_DISCOVERY_DEPTH = 16;
export const MAX_DEBUG_JSON_DISCOVERY_FILES = 10_000;
export const MAX_DEBUG_JSON_DISCOVERY_ENTRIES = 20_000;
/** Refuse to buffer a "receipt" larger than this; a receipt is metadata, never a payload. */
export const MAX_DEBUG_RECEIPT_BYTES = 4 * 1024 * 1024;
