export type WorkspacePackage = {
  name: string;
  dir: string;
  manifest: Record<string, unknown>;
};

export type PackedRuntimeExportEntry = {
  packageName: string;
  subpath: string;
  specifier: string;
  sourceTarget: string;
  targets: {
    default: string;
    types: string;
  };
};

export type PackedRuntimeExportContract = {
  runtime: PackedRuntimeExportEntry[];
  privateEntries: PackedRuntimeExportEntry[];
};

export function collectShippingWorkspaceImportSpecifiers(packages?: WorkspacePackage[]): Set<string>;
export function collectPackedRuntimeExportContract(packages?: WorkspacePackage[]): PackedRuntimeExportContract;
