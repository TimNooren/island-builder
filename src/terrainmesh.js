import * as THREE from 'three';
import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';
import { GRASS_EDGE_HEIGHT, GRASS_EDGE_SLOPE } from './terrainmaterial.js';
import { WATER_LEVEL } from './water.js';
import { ISO, cellFill } from './field.js';

/**
 * Smooth terrain extraction from a binary VoxelGrid.
 *
 * Pipeline:
 *   1. Sample the grid at cell centres (via field.js, which gives every cell
 *      a slightly wobbled fill value so blocks are not all the same size),
 *      padded with empty space on the sides and top, and with level 0 copied
 *      downwards so ground cells rise out of the water as columns instead of
 *      floating blobs.
 *   2. Marching Cubes on that field with vertices welded per grid edge, giving
 *      an indexed, watertight mesh. Crossings sit near the halfway point
 *      between cell centres, i.e. close to the real cell boundaries: flat-ish
 *      tops at about the right height, 45° ramps across stair-steps, no
 *      systematic size loss.
 *   3. Taubin smoothing (a shrink-free variant of Laplacian smoothing) with
 *      each vertex clamped near its original position so the mesh stays
 *      faithful to the voxels.
 *   4. Smooth normals, a small lift where grass will grow, and two vertex
 *      colours: the bare ground (sand / wet sand / rock by height and slope)
 *      and the grass patchwork. Where grass actually shows is decided per
 *      pixel in terrainmaterial.js, because one vertex per cell is too coarse
 *      for a crisp border.
 */

const PAD_XZ = 1;
const PAD_BELOW = 2;
const SMOOTH_PASSES = 3;
const TAUBIN_LAMBDA = 0.5;
const TAUBIN_MU = -0.53;
// How far smoothing may move a vertex from its MC position. This caps the
// rounding radius and, more importantly, stops one-cell features (a freshly
// placed block, a thin wall) from being smoothed away.
const MAX_DRIFT = 0.25;
const NOISE_AMPLITUDE = 0.04;

const SAND = new THREE.Color(0xd9c68e);
const WET_SAND = new THREE.Color(0x9c8a5a);
// Vertices this close to (or below) the waterline are wet. Level-0 walls have
// a ring of vertices exactly at WATER_LEVEL (the cell-centre sample height),
// which smoothing and jitter nudge by a few hundredths; the slack catches
// those so the wet band starts at the waterline and blends up to the dry rim.
const WET_SLACK = 0.1;
// Grass is not one flat green but a patchwork blended between these two.
// Keep them close: further apart reads as camouflage rather than meadow.
const GRASS_A = new THREE.Color(0x7bc45a); // warm / yellowish
const GRASS_B = new THREE.Color(0x5a9e3e); // cool / bluish
const ROCK = new THREE.Color(0x8d8378);
// Size of a grass patch in world units. Flat tops only carry one vertex per
// cell, so anything under ~3 degenerates into per-vertex speckle; larger
// values give calmer, broader clumps but fewer of them on a small island.
const PATCH_CELL = 3;
// Per-patch brightness swing. Under lit shading two close hues wash out;
// this is what actually makes neighbouring patches legible.
const PATCH_SHADE = 0.14;
// How far grass vertices are raised, in world units. This alone can't make a
// crisp step (the mesh has no vertices at the border), it just gives lawns a
// slight bulge; the rim shading in the material does the rest. Keep it well
// under MAX_DRIFT so the cursor's grid-derived placement stays believable.
const GRASS_LIFT = 0.08;
const tmpColor = new THREE.Color();
const tmpGrass = new THREE.Color();

// Paul Bourke's corner / edge numbering, as used by three's tables.
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGE_CORNERS = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
// For each edge: [lower corner, axis] so we can give every grid edge a unique id.
const EDGE_KEY = EDGE_CORNERS.map(([a, b]) => {
  const ca = CORNERS[a], cb = CORNERS[b];
  const axis = ca[0] !== cb[0] ? 0 : ca[1] !== cb[1] ? 1 : 2;
  return [ca[axis] < cb[axis] ? a : b, axis];
});

function hash(x, y, z) {
  let h = (Math.floor(x * 7) * 374761393 + Math.floor(y * 7) * 668265263 + Math.floor(z * 7) * 1911520717) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// hash() quantises to 1/7 units and is meant for per-position jitter. For
// lattice lookups it must be fed integer cell coordinates, which this wraps.
function cellHash(ix, iz, salt) {
  return hash(ix, iz, salt);
}

// Nearest-feature-point (Worley) lookup on the world XZ plane. Returns the
// per-patch parameters for the winning cell: a hue mix `t` and a `shade`
// offset, both in [0, 1]. Keyed by world XZ, not by height, so stacking a
// block on top of a patch keeps the same patch — and so a rebuild of the same
// grid produces the same colours. Only the cell id matters at our vertex
// density; the F2-F1 edge distance would be invisible under Gouraud shading.
const patch = { t: 0, shade: 0 };
function grassPatch(x, z) {
  const px = x / PATCH_CELL, pz = z / PATCH_CELL;
  const cx = Math.floor(px), cz = Math.floor(pz);
  let best = Infinity, bx = cx, bz = cz;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, iz = cz + dz;
      const fx = ix + cellHash(ix, iz, 1);
      const fz = iz + cellHash(ix, iz, 2);
      const d = (fx - px) * (fx - px) + (fz - pz) * (fz - pz);
      if (d < best) { best = d; bx = ix; bz = iz; }
    }
  }
  patch.t = cellHash(bx, bz, 3);
  patch.shade = cellHash(bx, bz, 4);
  return patch;
}

export function buildSmoothTerrainGeometry(grid) {
  const NX = grid.size + 2 * PAD_XZ;
  const NZ = grid.size + 2 * PAD_XZ;
  const NY = grid.height + PAD_BELOW + 1;
  const sampleIndex = (i, j, k) => (j * NZ + k) * NX + i;
  // World position of sample (i, j, k) is (i + ox, j + oy, k + oz).
  const ox = -PAD_XZ + 0.5;
  const oy = -PAD_BELOW + 0.5;
  const oz = -PAD_XZ + 0.5;

  // ---- 1. Field ----
  const field = new Float32Array(NX * NY * NZ);
  for (let j = 0; j < NY; j++) {
    const y = Math.max(0, j - PAD_BELOW);
    for (let k = 0; k < NZ; k++) {
      for (let i = 0; i < NX; i++) {
        field[sampleIndex(i, j, k)] = cellFill(grid, i - PAD_XZ, y, k - PAD_XZ);
      }
    }
  }

  // ---- 2. Marching cubes with per-edge vertex welding ----
  const edgeVertex = new Int32Array(NX * NY * NZ * 3).fill(-1);
  const positions = [];
  const indices = [];
  const corner = new Float32Array(8);
  const cellVerts = new Int32Array(12);

  for (let j = 0; j < NY - 1; j++) {
    for (let k = 0; k < NZ - 1; k++) {
      for (let i = 0; i < NX - 1; i++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNERS[c];
          corner[c] = field[sampleIndex(i + dx, j + dy, k + dz)];
          if (corner[c] < ISO) cubeIndex |= 1 << c;
        }
        const bits = edgeTable[cubeIndex];
        if (bits === 0) continue;

        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const [lower, axis] = EDGE_KEY[e];
          const [lx, ly, lz] = CORNERS[lower];
          const key = sampleIndex(i + lx, j + ly, k + lz) * 3 + axis;
          let v = edgeVertex[key];
          if (v < 0) {
            const [a, b] = EDGE_CORNERS[e];
            const va = corner[a], vb = corner[b];
            const t = (ISO - va) / (vb - va);
            const ca = CORNERS[a], cb = CORNERS[b];
            v = positions.length / 3;
            positions.push(
              i + ca[0] + (cb[0] - ca[0]) * t + ox,
              j + ca[1] + (cb[1] - ca[1]) * t + oy,
              k + ca[2] + (cb[2] - ca[2]) * t + oz
            );
            edgeVertex[key] = v;
          }
          cellVerts[e] = v;
        }

        const base = cubeIndex * 16;
        for (let t = 0; triTable[base + t] !== -1; t += 3) {
          indices.push(
            cellVerts[triTable[base + t]],
            cellVerts[triTable[base + t + 1]],
            cellVerts[triTable[base + t + 2]]
          );
        }
      }
    }
  }

  // ---- 3. Taubin smoothing, clamped near each vertex's original position ----
  const vertexCount = positions.length / 3;
  const original = new Float32Array(positions);
  const neighbors = Array.from({ length: vertexCount }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    neighbors[a].add(b).add(c);
    neighbors[b].add(a).add(c);
    neighbors[c].add(a).add(b);
  }

  let pos = new Float32Array(original);
  let next = new Float32Array(pos.length);
  const smoothPass = (weight) => {
    for (let v = 0; v < vertexCount; v++) {
      const nb = neighbors[v];
      let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (nb.size > 0) {
        let ax = 0, ay = 0, az = 0;
        for (const u of nb) { ax += pos[u * 3]; ay += pos[u * 3 + 1]; az += pos[u * 3 + 2]; }
        ax /= nb.size; ay /= nb.size; az /= nb.size;
        x += (ax - x) * weight;
        y += (ay - y) * weight;
        z += (az - z) * weight;
        const o0 = original[v * 3], o1 = original[v * 3 + 1], o2 = original[v * 3 + 2];
        x = Math.min(Math.max(x, o0 - MAX_DRIFT), o0 + MAX_DRIFT);
        y = Math.min(Math.max(y, o1 - MAX_DRIFT), o1 + MAX_DRIFT);
        z = Math.min(Math.max(z, o2 - MAX_DRIFT), o2 + MAX_DRIFT);
      }
      next[v * 3] = x; next[v * 3 + 1] = y; next[v * 3 + 2] = z;
    }
    [pos, next] = [next, pos];
  };
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    smoothPass(TAUBIN_LAMBDA);
    smoothPass(TAUBIN_MU);
  }

  // Subtle deterministic jitter so surfaces don't read as perfectly machined.
  for (let v = 0; v < vertexCount; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    pos[v * 3] += (hash(x, y, z) - 0.5) * NOISE_AMPLITUDE;
    pos[v * 3 + 1] += (hash(y, z, x) - 0.5) * NOISE_AMPLITUDE;
    pos[v * 3 + 2] += (hash(z, x, y) - 0.5) * NOISE_AMPLITUDE;
  }

  // ---- 4. Geometry, normals, grass lift, colours ----
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const normal = geo.getAttribute('normal');

  // Raise vertices that will (mostly) be grass, using a soft version of the
  // material's height/slope thresholds. Soft on purpose: a hard per-vertex
  // mask would put a one-cell-wide ramp somewhere near the pixel border.
  for (let v = 0; v < vertexCount; v++) {
    const y = pos[v * 3 + 1];
    const grassy = THREE.MathUtils.smoothstep(y, GRASS_EDGE_HEIGHT - 0.5, GRASS_EDGE_HEIGHT + 0.5)
      * THREE.MathUtils.smoothstep(normal.getY(v), GRASS_EDGE_SLOPE - 0.15, GRASS_EDGE_SLOPE + 0.15);
    pos[v * 3 + 1] = y + GRASS_LIFT * grassy;
  }
  geo.computeVertexNormals();

  const colors = new Float32Array(vertexCount * 3);
  const grassColors = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const steepness = THREE.MathUtils.smoothstep(1 - normal.getY(v), 0.35, 0.7);
    const speckle = 0.94 + 0.12 * hash(x, y, z);

    // Bare ground: what shows wherever the material decides there is no grass.
    tmpColor.copy(y < WATER_LEVEL + WET_SLACK ? WET_SAND : SAND).lerp(ROCK, steepness).multiplyScalar(speckle);
    colors[v * 3] = tmpColor.r; colors[v * 3 + 1] = tmpColor.g; colors[v * 3 + 2] = tmpColor.b;

    // Grass patchwork, baked everywhere so the border can fall anywhere.
    const { t, shade } = grassPatch(x, z);
    tmpGrass.copy(GRASS_A).lerp(GRASS_B, t).multiplyScalar((1 + (shade - 0.5) * 2 * PATCH_SHADE) * speckle);
    grassColors[v * 3] = tmpGrass.r; grassColors[v * 3 + 1] = tmpGrass.g; grassColors[v * 3 + 2] = tmpGrass.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('grassColor', new THREE.BufferAttribute(grassColors, 3));
  return geo;
}
