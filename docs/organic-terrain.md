# Making the terrain more organic

Notes on where the current mesher stops and what the next step up looks like.

## Where we are

`src/terrainmesh.js` turns the binary `VoxelGrid` (each cell is solid or empty)
into a smooth mesh:

1. Sample the grid at cell centres as a 0/1 field, padded with empty space on
   the sides/top and with level 0 copied two layers below the water.
2. Marching Cubes at ISO = 0.5, with vertices welded per grid edge so the mesh
   is indexed and watertight.
3. Taubin (λ/μ) smoothing, with each vertex clamped to within `MAX_DRIFT` of
   its Marching Cubes position.
4. Smooth normals, slope/height based vertex colours, a little jitter.

With a purely binary field, every crossing sits exactly halfway between two
cell centres. That is what gives flat tops at integer heights and 45° bevels
along every edge. The surface has only two "slopes" available to it: flat and
45°. Everything softer than that comes from the mesh smoothing pass, and that
pass is deliberately capped (`MAX_DRIFT = 0.25`) because any low-pass filter
also erodes one-cell features — an uncapped pass turned a freshly placed block
into a pebble.

So the ceiling of the current approach is "rounded Marching Cubes". It reads
as soft low-poly terrain, not as sculpted landscape.

### Done since: per-cell offsets (a light version of option C below)

`src/field.js` now sits between the grid and the mesher. It samples a solid
cell as `1 + s` and an empty one as `0 + s`, where `s` is a deterministic
signed offset per cell: smooth 3D value noise (~5 cells wavelength, ±0.25)
plus a little per-cell white noise (±0.06). Because both sides of a face get
the same `s`, the crossing moves by `s` towards the empty side, so whole
stretches of coast swell or recede and plateaus undulate, while neighbouring
blocks still differ slightly. Negative offsets are damped (×0.6) so one-cell
features stay about half a unit wide at worst. The grid is still binary and
picking is unchanged; the water's shore contour samples the same field so
ripples keep following the mesh outline. Rebuild went from ~3 ms to ~7 ms.

## The next step: a fractional field

The limitation is the data, not the algorithm. Marching Cubes already
interpolates crossing positions from the field values:

```
t = (ISO - va) / (vb - va)
```

With 0/1 data `t` is always 0.5. If cells instead store a fill value in
`[0, 1]`, crossings slide along edges and the surface tilts to any angle.
A cell at 0.7 next to a cell at 0.2 puts the surface 40% of the way across,
and a smooth gradient of values gives a smooth slope. Nothing in the mesher
needs to change except the field type.

### Data model

- `VoxelGrid.data` becomes `Float32Array`, values in `[0, 1]`.
- "Solid" for gameplay/picking purposes means `value > 0.5`.
- Clicking still adds/removes whole cells (set to 1 / 0) so the current
  Townscaper-style interaction keeps working unchanged.

### Getting fractional values into the grid

Three options, in increasing order of ambition. They can coexist.

**A. Derive them — cheapest, zero UI change.**
Keep the editing binary and compute the render field from it:

- Blur the 0/1 field with a small kernel (e.g. weights `0.5` self,
  `0.5 / 6` per face-neighbour) before meshing.
- Iso stays at 0.5. Concave corners fill in, convex edges round off, ramps
  get an S-curve profile instead of a straight 45° line.
- Cost: convex one-cell features shrink (an isolated block's centre value
  drops toward 0.5). Mitigate by keeping the kernel centre-heavy, or by
  clamping the blurred value to at least the original where the original
  is 1. A 2× upsample before meshing helps too but multiplies the cell
  count by 8; the current rebuild is ~4 ms so there is room for that.

**B. A sculpt brush — the real "organic" tool.**
Add a second interaction alongside click-to-place:

- Drag with a modifier held (or a toolbar toggle) to paint into the field.
  Each frame, for cells within radius `r` of the hit point, add or subtract
  `strength * falloff(distance)` and clamp to `[0, 1]`.
- Raise/lower become continuous. Small strength values give gentle hills;
  a negative brush carves bowls and undercuts.
- Keep the padding rule (level 0 copied downwards) so the coastline still
  meets the water cleanly, and keep `MAX_DRIFT` smoothing as a finishing
  pass — with real gradients in the field it can be reduced or removed.

**C. Procedural relief on top.**
Modulate the field with low-amplitude 3D noise (value or simplex) before
meshing, e.g. `field += 0.15 * noise(x, y, z)` for cells near the surface.
Gives broken, natural-looking rock faces for free. Deterministic per cell
so edits elsewhere don't reshuffle it.

## Algorithm upgrades that only pay off with a fractional field

- **Dual Contouring** (Ju et al. 2002) places one vertex per cell by solving a
  small least-squares problem from edge crossings *and their normals*
  (Hermite data). It preserves sharp features where the field says there
  should be one and produces nicer quad topology than MC. Needs a field
  gradient to be worth it; on 0/1 data it degenerates to Surface Nets, which
  we already tried and rejected because it collapses one-cell features.
- **Manifold Dual Contouring** fixes the non-manifold cases DC can produce.
- **Finer sample grid** (2×–3× per voxel) with trilinear or smoothstep
  upsampling of the coarse field. Buys curved slopes within a single cell at
  8×–27× the mesh cost. Only sensible once the field itself carries gradient
  information, otherwise it just reproduces the same 45° planes with more
  triangles.
- **Transvoxel / chunked LOD** is for large worlds. Not relevant at 32×32.

## Grass variation: colour bake, not geometry

Flat green plateaus looked plastic. The options considered for "grass":

- **Instanced blades / cross-quads / shell layers.** Real geometry fights the
  smooth, rounded look, adds a subsystem (spawn points, culling, wind), and
  at 32×32 the payoff is small. Rejected for this style.
- **Image textures / splat maps.** Needs UVs on a Marching Cubes mesh, which
  it doesn't have, plus asset management. Rejected.
- **Shader injection (`onBeforeCompile`) with procedural noise.** Gives
  per-pixel detail, but the failure mode of the terrain isn't facets, it's
  flatness of colour. Deferred; nothing here prevents adding it later.
- **Patchwork in the vertex-colour bake — chosen.** Soft Worley cells on
  world XZ pick a per-patch mix between two close greens plus a per-patch
  brightness offset, applied before the existing beach/rock lerps. Zero
  material or render-loop changes, and the rebuild already recomputes colours.

The constraint to know about: on binary MC data a flat top has exactly one
vertex per cell, so colour resolution on plateaus is ~1 world unit. Patches
therefore need to be several cells wide (`PATCH_CELL`), and any "soft edge"
term finer than that (e.g. Worley `F2 − F1`) is invisible under Gouraud
interpolation. Brightness variation does more for legibility than hue: two
close greens alone wash out under lit shading. Sampling is keyed to world XZ
so stacking a block keeps its patch and the same grid always yields the same
colours. If patches ever read as a quilt, the fallback is smooth value noise
/ fBm for the mix parameter instead of a cell id.

## Things to keep as constraints

- One-cell features must survive: a single click on water must produce a
  visible mound of roughly unit height. Whatever smoothing or blurring is
  added, test the isolated block and the 1-wide wall (see the Node checks
  described below).
- Arches and caves depend on overhangs being representable. Anything that
  turns the field into a heightmap breaks them; fractional fill does not.
- Rebuild time stays well under a frame. Currently ~4 ms for a 32×32×24
  island; a full rebuild per edit is fine, chunking is not needed.

## Verifying changes to the mesher

A quick Node script (kept outside the repo while iterating) that imports
`buildSmoothTerrainGeometry` and checks:

- **Watertight**: every edge used by exactly two triangles, except along the
  bottom of the below-water padding.
- **Outward normals**: for a convex shape, face normals point away from its
  centre.
- **Extents**: an isolated block keeps roughly ±0.5 extents; a 3×3×2 plateau
  tops out near y = 2.
- **Random grids**: 20 random 10×10×10 grids hit every Marching Cubes case,
  including the ambiguous ones — no holes expected.
- **Timing**: rebuild of a full-size island.
