# island-builder

A browser toy for sculpting a small island out of blocks, Townscaper-style:
click on the water or on a face to add a block, right-click to remove one.
The blocky data is rendered as smooth, cartoonish terrain sitting in animated
water. No backend, no framework, no tests — a single Vite page and Three.js.

## Stack

- Vanilla ES modules, no TypeScript, no bundler config beyond Vite defaults
  (plus a relative `base` so the build works on GitHub Pages).
- `three` (with addons imported from `three/addons/...`) for rendering.
- `npm run dev` for the dev server (HMR picks up edits), `npm run build` for `dist/`.

## Layout

```
index.html   page shell + HUD text
src/         app modules (ES)
docs/        design notes and longer-form reasoning about approaches tried or planned
```

Rule of thumb: one entry module orchestrates renderer, input, and the render
loop; anything with its own algorithm or state lives in a sibling module under
`src/` and exposes a small function/class. Keep new subsystems in that shape
rather than growing the orchestrator.

## Model

- World units = grid cells. Cell `(x, y, z)` occupies `[x, x+1) × [y, y+1) × [z, z+1)`;
  its centre is at `+0.5`. `y` is up; still water sits slightly above `y = 0`
  so the ground layer is half submerged.
- The voxel grid is the single source of truth. Derived views (terrain mesh,
  water shore map, and so on) rebuild in full after every edit — cheap at this
  size; don't add chunking or caching unless measured to be needed.
- The render mesh is a smoothed approximation of the cubes. Anything that
  needs to be exact (picking, placement, bounds) should query the grid, not
  the mesh.

## Deployment

- Hosted on GitHub Pages from `main` via `.github/workflows/pages.yml`
  (build → upload `dist/` → deploy).
- Site URL: `https://timnooren.github.io/island-builder/`.
- Vite `base` is `./` so asset URLs resolve under that project path (and under
  `vite preview`). Do not switch back to an absolute `/` base unless the app
  moves to a domain root.
- Pushing to `main` deploys; use workflow_dispatch on the same workflow for a
  manual redeploy.

## Conventions

- Constants (sizes, tuning knobs) go at the top of the file they belong to,
  with a short comment on what the value trades off.
- Comment the *why* of algorithms (a few lines above a block), not the what.
- No dependencies beyond `three` unless there is a strong reason.
- Verification is done with throwaway Node scripts that import a module
  directly. Keep those outside the repo. Visual checks: run the dev server
  and look.
- Design discussions that outlive a change belong in `docs/`, not in code
  comments or this file.
