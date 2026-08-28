/**
 * Host-only controls for strict GPU segmented delivery.
 *
 * This intentionally has no identity, browser, store, range, or producer
 * field. The admitted executor creates all of those only after its one outer
 * job has acquired scratch/process authority.
 */
import type { SegmentedGpuHostPolicy } from "./segmented-final-gpu-host-types.js";

export type SegmentedGpuToolPolicy = SegmentedGpuHostPolicy;
