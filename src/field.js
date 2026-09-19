/**
 * The scalar field that the terrain mesh (and the water's shore contour) are
 * extracted from: the VoxelGrid sampled at cell centres, offset by a small
 * deterministic per-cell amount so the blocks are not all the same size.
 *
 * Marching Cubes / Squares place the surface where the field crosses ISO,
 * interpolated between neighbouring samples. On exact 0 / 1 data every
 * crossing sits halfway between cell centres, i.e. on the cell boundary, and
 * every block renders as the same machined unit cube. Here a solid cell is
 * sampled as 1 + s and an empty one as 0 + s, with the same signed offset
 * field s for both. Where s is positive the crossing slides towards the empty
 * side, so the terrain there is fatter and taller; where it is negative,
 * thinner and lower. Because s is shared by the two cells the shift equals s
 * exactly (in cell units) wherever s is locally constant.
 *
 * s has two parts: a smooth, low-frequency value noise so whole stretches of
 * coast bulge or recede and plateaus undulate (this is what varies the
 * island's silhouette), and a small per-cell white noise so neighbouring
 * blocks still differ a little from each other. Classification is unaffected
 * as long as |s| < 0.5: solid cells stay above ISO and empty ones below, so
 * topology, picking and placement all still follow the grid.
 *
 * Keyed by cell coordinates, so a cell always has the same offset and editing
 * elsewhere does not reshuffle the rest of the island.
 */

export const ISO = 0.5;
// Amplitude (±, in cell units) of the smooth, island-scale part of the offset.
// This is the main "how irregular" knob. Together with CELL_JITTER it must stay
// well under 0.5 or cells would flip solid/empty; past ~0.3 one-cell blocks in
// a negative region shrink to pebbles.
export const SHAPE_AMPLITUDE = 0.25;
// Wavelength of that noise, in cells. Smaller gives choppier coasts, larger
// gives broader swells; at 32 cells across, 5 gives a handful of bulges per side.
export const SHAPE_SCALE = 5;
// Amplitude (±) of the independent per-cell part, so adjacent blocks are not
// exact copies of each other even where the smooth field is flat.
export const CELL_JITTER = 0.06;
// Negative offsets are scaled by this. Growing a block is harmless, but
// shrinking eats one-cell features (a fresh block, a thin wall), so the
// terrain is allowed to swell further out than it may recede.
const SHRINK_FACTOR = 0.6;

// Integer-lattice hash to [0, 1). Cell coordinates may be negative (the
// mesher and shore map pad the grid), which the |0 wrap handles. Also used by
// trees.js (with salted coordinates) so tree placement is per-cell stable.
export function cellHash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1911520717) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

// Trilinear value noise in [-1, 1] at (x, y, z), features ~1 unit across.
// Lattice points are hashed with a salt so they do not correlate with the
// per-cell jitter, which uses the same hash on the raw cell coordinates.
function valueNoise(x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0);
  const n = (i, j, k) => cellHash(x0 + i + 1013, y0 + j + 2027, z0 + k + 3041);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c00 = lerp(n(0, 0, 0), n(1, 0, 0), fx);
  const c10 = lerp(n(0, 1, 0), n(1, 1, 0), fx);
  const c01 = lerp(n(0, 0, 1), n(1, 0, 1), fx);
  const c11 = lerp(n(0, 1, 1), n(1, 1, 1), fx);
  const c0 = lerp(c00, c10, fy);
  const c1 = lerp(c01, c11, fy);
  return lerp(c0, c1, fz) * 2 - 1;
}

/** Signed offset s for cell (x, y, z), |s| ≤ SHAPE_AMPLITUDE + CELL_JITTER. */
export function cellOffset(x, y, z) {
  const shape = valueNoise(x / SHAPE_SCALE, y / SHAPE_SCALE, z / SHAPE_SCALE) * SHAPE_AMPLITUDE;
  const jitter = (cellHash(x, y, z) * 2 - 1) * CELL_JITTER;
  const s = shape + jitter;
  return s < 0 ? s * SHRINK_FACTOR : s;
}

/** Field value of cell (x, y, z): 1 + s if solid, s if empty. */
export function cellFill(grid, x, y, z) {
  return (grid.get(x, y, z) ? 1 : 0) + cellOffset(x, y, z);
}
