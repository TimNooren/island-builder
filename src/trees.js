import * as THREE from 'three';
import { ISO, cellFill, cellHash } from './field.js';
import { GRASS_EDGE_HEIGHT, SOFTEN_FACETS_GLSL } from './terrainmaterial.js';
import { GRASS_LIFT } from './terrainmesh.js';
import { createTreeGeometry, canopyHalfHeight, concat } from './treemodel.js';

/**
 * Trees: derived from the VoxelGrid like the terrain mesh, rebuilt in full
 * after every edit, never stored.
 *
 * Where trees can grow. A "grass top" is a solid cell at level >= MIN_LEVEL
 * with nothing above it (the material paints those tops green, see
 * terrainmaterial.js). Grass tops at the same level are grouped into
 * 4-connected patches; a patch smaller than MIN_PATCH_CELLS stays bare. In a
 * large enough patch, only *interior* cells (all 8 neighbours are grass tops
 * of the same patch) are candidates, so a tree always stands on the flat
 * part of the lawn rather than on the rounded rim, and never against a wall.
 *
 * Which candidates get a tree. Every candidate rolls a hash of its cell
 * coordinates. It grows a tree if the roll is under TREE_CHANCE and beats
 * every other candidate within TREE_SPACING cells, which spreads trees out
 * (no two canopies collide) and, because the roll is keyed to the cell,
 * keeps existing trees where they are when the island is edited elsewhere.
 * A patch that has candidates but rolled no tree gets one anyway, at its
 * lowest-rolling candidate, so every flat lawn carries at least one tree.
 * The same hash picks the tree's proportions and colour.
 */

// Level-0 tops are beach; a top at world height y+1 is grass once it clears
// the material's height threshold, so level 1 is the first tree-bearing one.
const MIN_LEVEL = Math.floor(GRASS_EDGE_HEIGHT);
// Fewest grass cells for a patch to get trees at all. 9 is a bare 3x3, the
// smallest lawn with a flat interior cell, so any lawn wide enough to hold a
// tree gets one. Raise it to keep hilltop tufts bare.
const MIN_PATCH_CELLS = 9;
// Chebyshev radius (cells) within which a candidate must have the lowest
// roll. 1 keeps tree centres >= 2 cells apart; the widest canopy is ~1.4.
const TREE_SPACING = 1;
// Density knob for large lawns: with TREE_SPACING = 1 the ceiling is one tree
// per 9 cells; 0.2 gives roughly one per 10. Small lawns are covered by the
// one-per-patch guarantee regardless.
const TREE_CHANCE = 0.2;
// Trees stand 1-2 cells tall, as asked; the rest of the shape follows height.
const TREE_MIN_HEIGHT = 1.0;
const TREE_MAX_HEIGHT = 2.0;
// Trunk as a fraction of the total height, and the canopy's width relative
// to its own vertical radius (1 is a sphere; lower is an egg, higher a bun).
const TRUNK_FRACTION = [0.25, 0.4];
const CANOPY_ASPECT = [0.8, 1.15];
const TRUNK_RADIUS = [0.07, 0.12];
// How far a tree may stand off its cell centre, so trees do not line up.
const CELL_JITTER = 0.25;
// Canopy greens, kept a shade darker/bluer than the grass so trees read as
// separate objects on a lawn instead of bumps in it.
const CANOPY_A = new THREE.Color(0x3f8f3a);
const CANOPY_B = new THREE.Color(0x6aae48);
const CANOPY_SHADE = 0.15;
const TRUNK = new THREE.Color(0x6b4a2e);
// Salts keep the placement rolls independent of the field's own per-cell hash.
const SALT_ROLL = 5001;
const SALT_SHAPE = 6001;

const NEIGHBOURS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function isGrassTop(grid, x, y, z) {
  return y >= MIN_LEVEL && grid.get(x, y, z) && !grid.get(x, y + 1, z);
}

/**
 * Tree sites for `grid`: [{ x, y, z, roll }] with (x, y, z) the cell the tree
 * stands on. Exposed separately from the geometry for testing.
 */
export function findTreeSites(grid) {
  const { size, height } = grid;
  const idx = (x, z) => z * size + x;
  const sites = [];
  const patchId = new Int32Array(size * size);
  const patchSize = [];
  const candidate = new Uint8Array(size * size);
  const roll = new Float32Array(size * size);
  const stack = [];

  // Patches are per level: the same XZ cell is a grass top at one level at
  // most, so one flat label map serves the whole grid, reset per level.
  for (let y = MIN_LEVEL; y < height; y++) {
    patchId.fill(-1);
    patchSize.length = 0;
    candidate.fill(0);

    // ---- 1. Label 4-connected patches of grass tops at this level ----
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        if (patchId[idx(x, z)] >= 0 || !isGrassTop(grid, x, y, z)) continue;
        const id = patchSize.length;
        patchSize.push(0);
        stack.push(x, z);
        patchId[idx(x, z)] = id;
        while (stack.length) {
          const cz = stack.pop(), cx = stack.pop();
          patchSize[id]++;
          for (const [dx, dz] of NEIGHBOURS_4) {
            const nx = cx + dx, nz = cz + dz;
            if (!grid.inBounds(nx, y, nz) || patchId[idx(nx, nz)] >= 0 || !isGrassTop(grid, nx, y, nz)) continue;
            patchId[idx(nx, nz)] = id;
            stack.push(nx, nz);
          }
        }
      }
    }
    if (patchSize.length === 0) continue;

    // ---- 2. Candidates: interior cells of big enough patches, headroom above ----
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const id = patchId[idx(x, z)];
        if (id < 0 || patchSize[id] < MIN_PATCH_CELLS) continue;
        let interior = true;
        for (let dz = -1; dz <= 1 && interior; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, nz = z + dz;
            if (!grid.inBounds(nx, y, nz) || patchId[idx(nx, nz)] !== id) { interior = false; break; }
          }
        }
        // A 2-tall tree reaches into the cell two above; an arch there would
        // poke through the canopy.
        if (!interior || grid.get(x, y + 2, z)) continue;
        candidate[idx(x, z)] = 1;
        roll[idx(x, z)] = cellHash(x + SALT_ROLL, y, z);
      }
    }

    // ---- 3. Keep candidates that win their neighbourhood ----
    // Per patch: whether it got a tree, and its best candidate as a fallback.
    const planted = new Uint8Array(patchSize.length);
    const fallback = new Array(patchSize.length).fill(null);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        if (!candidate[idx(x, z)]) continue;
        const id = patchId[idx(x, z)];
        const r = roll[idx(x, z)];
        if (!fallback[id] || r < fallback[id].roll) fallback[id] = { x, y, z, roll: r };
        if (r >= TREE_CHANCE) continue;
        let wins = true;
        for (let dz = -TREE_SPACING; dz <= TREE_SPACING && wins; dz++) {
          for (let dx = -TREE_SPACING; dx <= TREE_SPACING; dx++) {
            const nx = x + dx, nz = z + dz;
            if ((dx === 0 && dz === 0) || !grid.inBounds(nx, y, nz) || !candidate[idx(nx, nz)]) continue;
            if (roll[idx(nx, nz)] < r) { wins = false; break; }
          }
        }
        if (wins) {
          sites.push({ x, y, z, roll: r });
          planted[id] = 1;
        }
      }
    }

    // ---- 4. Every lawn with room for a tree gets at least one ----
    // The fallback is the patch's lowest roll, so it is as stable under
    // unrelated edits as the regular picks: it only moves if the patch's
    // candidate set changes.
    for (let id = 0; id < patchSize.length; id++) {
      if (!planted[id] && fallback[id]) sites.push(fallback[id]);
    }
  }
  return sites;
}

const lerpRange = ([lo, hi], t) => lo + (hi - lo) * t;

/** World height of the rendered lawn over cell (x, y, z): the Marching Cubes
 *  crossing between this cell and the empty one above, plus the grass lift. */
function lawnHeight(grid, x, y, z) {
  const below = cellFill(grid, x, y, z);
  const above = cellFill(grid, x, y + 1, z);
  return y + 0.5 + (ISO - below) / (above - below) + GRASS_LIFT;
}

const tmpCanopy = new THREE.Color();

/** All trees for `grid` merged into one geometry (position, normal, color). */
export function buildTreesGeometry(grid) {
  const parts = [];
  for (const { x, y, z } of findTreeSites(grid)) {
    // Independent per-cell draws for each dimension; salted so they do not
    // correlate with each other or with the placement roll.
    const draw = (k) => cellHash(x + SALT_SHAPE, y + k * 101, z);
    const height = lerpRange([TREE_MIN_HEIGHT, TREE_MAX_HEIGHT], draw(1));
    const trunkHeight = height * lerpRange(TRUNK_FRACTION, draw(2));
    const canopyRadius = canopyHalfHeight(height, trunkHeight) * lerpRange(CANOPY_ASPECT, draw(3));
    tmpCanopy.copy(CANOPY_A).lerp(CANOPY_B, draw(4)).multiplyScalar(1 + (draw(5) - 0.5) * 2 * CANOPY_SHADE);

    const tree = createTreeGeometry({
      height,
      trunkHeight,
      trunkRadius: lerpRange(TRUNK_RADIUS, draw(6)) * (height / 1.5),
      canopyRadius,
      canopyColor: tmpCanopy,
      trunkColor: TRUNK,
      seed: Math.floor(draw(7) * 1e6),
    });
    tree.translate(
      x + 0.5 + (draw(8) - 0.5) * 2 * CELL_JITTER,
      lawnHeight(grid, x, y, z),
      z + 0.5 + (draw(9) - 0.5) * 2 * CELL_JITTER
    );
    parts.push(tree);
  }
  return concat(parts);
}

/** Vertex-coloured, with the same softened facets as the terrain. */
export function createTreeMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  material.customProgramCacheKey = () => 'trees';
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>\n${SOFTEN_FACETS_GLSL}`
    );
  };
  return material;
}
