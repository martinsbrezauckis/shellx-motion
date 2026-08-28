/**
 * Snippet for the staging-TOCTOU regression: two image assets, the bulky one declared first so it
 * is also staged first (manifest asset order follows document order). The second asset is the one
 * the test swaps for a symlink once the first has begun landing in the package.
 */
export function htmlSnippetTocTouFixture(): string {
  return `<!doctype html>
<html lang="en" data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_html_toctou">
<head><meta charset="utf-8"><title>Staging Race</title></head>
<body>
  <main class="shellx-motion-composition"
    data-composition-id="motion_html_toctou"
    data-start="0"
    data-duration="2400"
    data-fps="24"
    style="width: 1280px; height: 720px; background: #0f172a;">
    <img class="shellx-motion-layer shellx-motion-media"
      data-layer-id="bulk"
      data-layer-type="image"
      data-start="0"
      data-duration="1200"
      src="assets/bulk.png"
      style="left: 0px; top: 0px; width: 64px; height: 64px;">
    <img class="shellx-motion-layer shellx-motion-media"
      data-layer-id="photo"
      data-layer-type="image"
      data-start="0"
      data-duration="1200"
      src="assets/photo.png"
      style="left: 0px; top: 0px; width: 64px; height: 64px;">
  </main>
</body>
</html>
`;
}
