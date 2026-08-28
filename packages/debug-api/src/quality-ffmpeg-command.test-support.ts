export function qualityFfmpegInputArgs(format: "mov" | "matroska"): string[] {
  return format === "mov"
    ? ["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"]
    : ["-protocol_whitelist", "file", "-format_whitelist", "matroska"];
}
