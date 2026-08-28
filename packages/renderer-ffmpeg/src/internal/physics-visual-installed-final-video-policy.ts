/**
 * Packed host-internal access to the existing governed streaming final policy.
 *
 * It intentionally adds no command, renderer lane, or generic public encoder API. The C7B5
 * installed-output proof owns its presentation authority and output publication transaction;
 * this module only keeps that proof on the production image2pipe policy.
 */
export { runStreamingFinalEncodePolicy } from "../streaming-final-encode-policy.js";
export type {
  StreamingFinalEncodePolicyInput,
  StreamingFinalEncodePolicyResult,
} from "../streaming-final-encode-policy.js";
