# Trees

Why trees are placed and drawn the way they are.

## Derived, not stored

Trees are a function of the `VoxelGrid`, like the terrain mesh and the shore
map: `buildTreesGeometry(grid)` runs after every edit (~5 ms for ~50 trees)
via `derived.rebuild` in `derived.js`, and nothing about them is saved. This
keeps the data model a plain grid of cells and means undo/redo, storage and
picking are untouched. The cost is that a tree cannot be placed or removed by
hand; it comes and goes with the lawn it stands on. To tear trees out, drop
them from `derived.js` — edit sites never name them.

## Where they grow (`src/trees.js`)

The material paints a cell top green when it is high enough and flat enough
(`terrainmaterial.js`), so "grass" in grid terms is: solid cell at level ≥ 1
with an empty cell above. From there:

1. Grass tops at the same level are labelled into 4-connected patches.
   Same-level on purpose: a step between terraces is a visible break in the
   lawn, and it keeps trees off the bevel between two levels.
2. Patches under `MIN_PATCH_CELLS` stay bare. The default (9, a 3×3) is the
   smallest lawn that has a flat interior cell at all, so effectively any
   lawn that could hold a tree does; raise it to keep hilltop tufts bare.
3. Only interior cells (all 8 neighbours in the same patch) are candidates.
   The Marching Cubes surface over a cell depends on its 3×3 neighbourhood,
   so this is exactly the condition for the ground under the trunk to be
   flat, and it keeps canopies clear of adjacent walls. Cells with a block
   two above (an arch) are also skipped.
4. Each candidate rolls a hash of its cell coordinates. It grows a tree when
   the roll is below `TREE_CHANCE` and lower than every candidate's within
   `TREE_SPACING` cells. The local-minimum test gives blue-noise-ish spacing
   with no iteration; the threshold thins it. Density tops out at
   1 / (2·spacing + 1)² per cell.
5. A patch that has candidates but rolled no tree gets one at its
   lowest-rolling candidate. This is what makes a small lawn reliably grow
   something without cranking `TREE_CHANCE` up for the big ones.

Because the roll is keyed to the cell, edits elsewhere never reshuffle
existing trees, and a rebuild of the same grid gives the same forest. The
fallback tree is equally stable: it only moves if the patch's own candidate
set changes.

The tree stands at the actual rendered lawn height: the MC crossing between
the cell and the one above (`field.js` offsets included) plus `GRASS_LIFT`,
with the trunk continuing a little below ground to cover smoothing/jitter.

## The model (`src/treemodel.js`)

One parametric shape: a 5-sided tapered trunk and an icosahedron canopy
squashed to an ellipsoid, with the canopy overlapping the top of the trunk.
Every dimension is a parameter; `trees.js` draws height (1–2 units, one to
two cells), trunk fraction, canopy aspect, trunk radius and colour per tree
from the cell hash. Canopy vertices are jittered radially, with the jitter
hashed from the vertex position so the duplicated corners of the non-indexed
icosahedron move together and the blob stays closed. The underside is baked
darker for cheap contact shading.

Trees are non-indexed geometries with `position`/`normal`/`color`, appended
into one buffer and drawn with one vertex-coloured `MeshStandardMaterial`
whose facets are softened the same way as the terrain. The mesh is created
before `snapScene()` so it gets the PS1 vertex snapping; only its geometry
is swapped on rebuild.

Rejected: `InstancedMesh` (per-instance scale can't vary trunk vs canopy
proportions, and one draw call is already what the merge gives us), and
storing trees in the grid as a cell type (would touch storage, history and
picking for a decoration).

## Knobs

| Constant | File | Effect |
| --- | --- | --- |
| `MIN_PATCH_CELLS` | `trees.js` | Smallest lawn that gets trees (9 = any lawn with a flat cell). |
| `TREE_CHANCE` | `trees.js` | Density on large lawns; 0.2 ≈ one per 10 interior cells. |
| `TREE_SPACING` | `trees.js` | Minimum distance between trunks, in cells. |
| `TREE_MIN_HEIGHT` / `TREE_MAX_HEIGHT` | `trees.js` | Height range. |
| `CANOPY_LUMPINESS`, `CANOPY_DETAIL` | `treemodel.js` | Blobbiness / polygon count. |
