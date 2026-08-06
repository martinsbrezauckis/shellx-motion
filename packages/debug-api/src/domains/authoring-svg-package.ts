/** SVG-specific wrapper around the shared atomic vector package writer. */
import { lowerStaticSvgToMotion } from "@shellx-motion/core";
import {
  writeStaticVectorPackage,
  type StaticVectorPackageOptions,
  type WrittenStaticVectorPackage
} from "./authoring-vector-package.js";

export interface WriteStaticSvgPackageOptions extends StaticVectorPackageOptions {}
export interface WrittenStaticSvgPackage extends WrittenStaticVectorPackage {}

/** Lowers one strict static SVG source and atomically installs its package. */
export async function writeStaticSvgPackage(options: WriteStaticSvgPackageOptions): Promise<WrittenStaticSvgPackage> {
  return writeStaticVectorPackage({
    adapterId: "adapter.svg",
    formatLabel: "SVG",
    sourceApp: "svg",
    sourceFileName: "input.svg",
    packagePrefix: "pkg_svg",
    lower: lowerStaticSvgToMotion
  }, options);
}
