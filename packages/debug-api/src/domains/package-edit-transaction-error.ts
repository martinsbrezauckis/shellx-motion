export type PackageEditTransactionErrorCode =
  | "unsafe_output"
  | "output_not_empty"
  | "source_changed"
  | "copy_mismatch"
  | "closed_inventory_changed"
  | "unsupported_source_entry"
  | "package_limit_exceeded"
  | "output_changed"
  | "layout_gap_animation_active"
  | "cancelled";

export class PackageEditTransactionError extends Error {
  constructor(readonly code: PackageEditTransactionErrorCode, message: string) {
    super(message);
    this.name = "PackageEditTransactionError";
  }
}
