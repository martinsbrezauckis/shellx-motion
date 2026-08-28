/**
 * Source-only host boundary for reversible layout applications.
 *
 * This module is deliberately absent from the public Core barrel and from the
 * published package exports. Normal barrel/data callers cannot create a
 * recognised authorization: values are recognised only through this module's
 * private WeakMap and are consumed exactly once. Trusted Debug-host source
 * code may import this source-only subpath, but only after immutable-store
 * verification.
 */
const authorizationState = new WeakMap<object, MotionLayoutRemovalAuthorizationState>();

declare const motionLayoutRemovalAuthorizationBrand: unique symbol;

export interface MotionLayoutRemovalAuthorization {
  readonly [motionLayoutRemovalAuthorizationBrand]: "shellx-motion/layout-removal-authorization@1";
  /** Releases an unused host authorization without performing a removal. */
  release(): void;
}

export interface MintMotionLayoutRemovalAuthorizationInput {
  packageId: string;
  applicationId: string;
  applicationFingerprint: string;
  receiptId: string;
}

interface MotionLayoutRemovalAuthorizationState extends MintMotionLayoutRemovalAuthorizationInput {
  consumed: boolean;
  released: boolean;
}

/** Mints a one-shot authorization for trusted host code after immutable apply-authority verification. */
export function mintMotionLayoutRemovalAuthorization(
  input: MintMotionLayoutRemovalAuthorizationInput,
): MotionLayoutRemovalAuthorization {
  assertInput(input);
  const state: MotionLayoutRemovalAuthorizationState = { ...input, consumed: false, released: false };
  const authorization = Object.freeze({
    release: (): void => { state.released = true; },
  }) as unknown as MotionLayoutRemovalAuthorization;
  authorizationState.set(authorization, state);
  return authorization;
}

/**
 * Checks a token before expensive Core reconstruction. It intentionally does
 * not consume it: a no-write stale-state refusal may be retried after the
 * document is restored. Successful removal consumes it below.
 */
export function hasMotionLayoutRemovalAuthorization(
  value: unknown,
  expected: Omit<MintMotionLayoutRemovalAuthorizationInput, "receiptId">,
): boolean {
  const state = stateFor(value);
  return state !== undefined
    && !state.consumed
    && !state.released
    && state.packageId === expected.packageId
    && state.applicationId === expected.applicationId
    && state.applicationFingerprint === expected.applicationFingerprint;
}

/** Consumes exactly the authorization that was checked for the current application. */
export function consumeMotionLayoutRemovalAuthorization(
  value: unknown,
  expected: Omit<MintMotionLayoutRemovalAuthorizationInput, "receiptId">,
): boolean {
  if (!hasMotionLayoutRemovalAuthorization(value, expected)) return false;
  const state = stateFor(value);
  if (!state) return false;
  state.consumed = true;
  return true;
}

function stateFor(value: unknown): MotionLayoutRemovalAuthorizationState | undefined {
  return typeof value === "object" && value !== null ? authorizationState.get(value) : undefined;
}

function assertInput(input: MintMotionLayoutRemovalAuthorizationInput): void {
  if (!identifier(input.packageId) || !identifier(input.applicationId) || !identifier(input.receiptId)) {
    throw new Error("Layout removal authorization ids must be 1..128-character strings.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.applicationFingerprint)) {
    throw new Error("Layout removal authorization fingerprint must be a lowercase SHA-256 hex string.");
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
