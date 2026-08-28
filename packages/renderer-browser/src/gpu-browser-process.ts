/** Concrete identity and containment facts for one trusted GPU browser root. */
export interface GpuBrowserProcess {
  readonly pid: number;
  readonly launcher: "playwright-launch-server" | "precontained-direct-chromium";
  readonly containment: GpuBrowserProcessContainment | null;
}

export type GpuBrowserProcessContainment =
  | { readonly rootPid: number; readonly mode: "unix-process-group"; readonly status: "enforced"; readonly killTree: true; readonly memoryLimit: "rss-monitor"; readonly maxProcessTreeRssBytes: number }
  | { readonly rootPid: number; readonly mode: "windows-job-object"; readonly status: "enforced"; readonly killTree: true; readonly memoryLimit: "job-commit"; readonly maxProcessTreeRssBytes: number; readonly maxActiveProcesses: number; readonly launcher: { readonly kind: "powershell-csharp"; readonly sha256: string } };

/** Required only for strict final delivery after outer job admission. */
export interface GpuFinalBrowserLaunchContext {
  readonly scratchRoot: string;
  readonly maxProcessTreeRssBytes: number;
  readonly signal?: AbortSignal;
}
