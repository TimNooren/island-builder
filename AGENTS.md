# island-builder

A browser toy for sculpting a small island out of blocks, Townscaper-style:
click on the water or on a face to add a block, right-click to remove one.
The blocky data is rendered as smooth, cartoonish terrain sitting in animated
water. No backend, no framework, no tests — a single Vite page and Three.js.

## Stack

- Vanilla ES modules, no TypeScript, no bundler config beyond Vite defaults.
- `three` (with addons imported from `three/addons/...`) for rendering.
- `npm run dev` for the dev server (HMR picks up edits), `npm run build` for `dist/`.

## Layout

```
index.html        page shell + HUD text
src/main.js       app wiring: renderer, camera/controls, lights, input, picking, cursor, render loop
src/voxels.js     VoxelGrid: the editable data model and grid-space queries (bounds, raycast)
src/field.js      voxel grid -> scalar field at cell centres, with the per-cell offsets that make blocks irregular
src/terrainmesh.js field -> smooth render mesh (marching cubes + smoothing + vertex colours)
src/water.js      water surface: shader tweaks, shore-distance map derived from the field
src/retro.js      PS1 presentation: low-res target + nearest upscale, vertex snapping, 15-bit dither
src/style.css     HUD styling
docs/             design notes and longer-form reasoning about approaches tried or planned
```

Rule of thumb: `main.js` orchestrates; anything with its own algorithm or state
lives in a module under `src/` and exposes a small function/class. Keep new
subsystems in that shape rather than growing `main.js`.

## Model

- World units = grid cells. Cell `(x, y, z)` occupies `[x, x+1) × [y, y+1) × [z, z+1)`;
 its centre is at `+0.5`. `y` is up. The still water surface is at
 `WATER_LEVEL = 0.5` (exported from `water.js`), so level 0 is half submerged.
- `VoxelGrid` is the single source of truth. The terrain mesh and the water's
  shore map are derived from it and rebuilt in full after every edit
  (rebuilds are cheap at this size — don't add chunking or caching unless
  measured to be needed).
- The render mesh is a smoothed approximation of the cubes. Anything that
  needs to be exact (picking, placement, bounds) should query the grid, not
  the mesh.

## Conventions

- Constants (sizes, tuning knobs) go at the top of the file they belong to,
  with a short comment on what the value trades off.
- Comment the *why* of algorithms (a few lines above a block), not the what.
- No dependencies beyond `three` unless there is a strong reason.
- Verification is done with throwaway Node scripts that import a module
  directly (e.g. `VoxelGrid` or `buildSmoothTerrainGeometry`). Keep those
  outside the repo. Visual checks: run the dev server and look.
- Design discussions that outlive a change belong in `docs/`, not in code
  comments or this file.
