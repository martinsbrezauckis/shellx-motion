const sharedArgs = [
  "--enable-gpu",
  "--force-high-performance-gpu",
  "--use-webgpu-power-preference=default-high-performance"
] as const;

const linuxVulkanArgs = [
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--disable-vulkan-surface"
] as const;

/** Fixed, hardware-only Chromium profile; Linux alone requires Vulkan compositing. */
export function gpuBrowserHardwareArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "linux" ? [...sharedArgs, ...linuxVulkanArgs] : [...sharedArgs];
}

export const GPU_BROWSER_HARDWARE_ARGS = gpuBrowserHardwareArgs();
