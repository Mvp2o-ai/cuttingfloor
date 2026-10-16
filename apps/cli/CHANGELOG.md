# cuttingfloor

## 0.2.0

### Minor Changes

- 33dd088: Clip compositing for overlays and picture-in-picture: `clip.set_transform` (position, scale, rotation, opacity, crop, flip and fit, each number animatable with keyframes and 34 eases), `clip.set_mask` (rectangle with rounded corners, ellipse, linear, mirror, heart, star and polygon, with feather and invert), `clip.set_blend` (13 blend modes) and `clip.set_animation` (entrance, exit and loop presets). Accepted names are resources at `video://catalog/{name}`. Pictures with an alpha channel keep it through conform and previews. Timeline documents are now version 2; `timeline.load` still accepts version 1 JSON.

## 0.1.0

### Minor Changes

- 5a66d33: Phase 1 editor: media import with conform and proxies, immutable timelines with clip editing and `edit.batch`, image previews on every edit, `render.frames`, exact `qa.check`, H.264 and ProRes export with signed downloads, and long-running work as MCP Tasks or `job.*`.
