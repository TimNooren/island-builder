import * as THREE from 'three';

/**
 * One cartoon tree: a short trunk with a lumpy canopy on top, built as a
 * single BufferGeometry with per-vertex colours so any number of trees can
 * be merged into one mesh and one material.
 *
 * Everything about the shape is a parameter (see DEFAULTS). The model sits
 * on the origin: y = 0 is ground level, the trunk extends a little below it
 * so it can be planted on a surface that is not perfectly flat, and the
 * canopy's top is at exactly `height`.
 */

// Segments around the trunk / subdivision of the canopy sphere. 8 and 2 keep
// a slightly chunky silhouette at the low internal resolution without each
// face reading as its own tile. Higher mostly disappears into the pixel grid;
// the vertex count of a full island of trees adds up.
const TRUNK_SEGMENTS = 8;
const CANOPY_DETAIL = 2;
// How far the trunk continues below ground level, so the base is hidden even
// where the smoothed terrain dips a little under the nominal cell top.
const ROOT_DEPTH = 0.15;
// How much of the trunk's top end is buried inside the canopy. Hides the
// open cylinder end and keeps the canopy from looking balanced on a stick.
const CANOPY_SINK = 0.35;
// Radial jitter (fraction of radius) applied to canopy vertices so no two
// trees are the same blob. Past ~0.25 faces start to fold over each other.
const CANOPY_LUMPINESS = 0.16;
// The underside of the canopy is baked darker than the top: cheap ambient
// occlusion, and it separates the canopy from the grass below.
const CANOPY_SHADE_BOTTOM = 0.7;

export const DEFAULTS = {
  /** Ground to top of canopy. */
  height: 1.5,
  /** Ground to top of trunk (canopy overlaps the upper part of it). */
  trunkHeight: 0.5,
  trunkRadius: 0.1,
  /** Horizontal radius of the canopy; its vertical radius follows from height. */
  canopyRadius: 0.5,
  trunkColor: new THREE.Color(0x6b4a2e),
  canopyColor: new THREE.Color(0x4f9e3f),
  /** Any integer; drives the canopy lumps and the rotation. */
  seed: 0,
};

/** Vertical radius the canopy will get for these dimensions (it fills the
 *  space between the sunk trunk top and `height`). */
export function canopyHalfHeight(height, trunkHeight) {
  return Math.max(0.05, (height - trunkHeight * (1 - CANOPY_SINK)) / 2);
}

function hash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 1911520717) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function paint(geometry, color, shadeFn) {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const s = shadeFn ? shadeFn(pos.getY(i)) : 1;
    colors[i * 3] = color.r * s;
    colors[i * 3 + 1] = color.g * s;
    colors[i * 3 + 2] = color.b * s;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute('uv');
}

/**
 * Build one tree. Returns a BufferGeometry with position, normal and color.
 * @param {Partial<typeof DEFAULTS>} params
 */
export function createTreeGeometry(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const seed = Math.floor(p.seed);

  // ---- Trunk: slightly tapered, open at both ends (both are hidden) ----
  const trunkLength = p.trunkHeight + ROOT_DEPTH;
  // Non-indexed like the canopy (PolyhedronGeometry never is) so concat() below
  // can just append the buffers.
  const trunk = new THREE.CylinderGeometry(p.trunkRadius * 0.8, p.trunkRadius, trunkLength, TRUNK_SEGMENTS, 1, true)
    .toNonIndexed();
  trunk.translate(0, trunkLength / 2 - ROOT_DEPTH, 0);
  paint(trunk, p.trunkColor);

  // ---- Canopy: an ellipsoid from the canopy bottom to `height` ----
  const canopyBottom = p.trunkHeight * (1 - CANOPY_SINK);
  const ry = canopyHalfHeight(p.height, p.trunkHeight);
  const canopy = new THREE.IcosahedronGeometry(1, CANOPY_DETAIL);
  // The icosahedron is non-indexed, so a shared corner appears several times.
  // Hashing the jitter from the (quantised) unit-sphere position moves every
  // copy identically and the surface stays closed.
  const cpos = canopy.getAttribute('position');
  for (let i = 0; i < cpos.count; i++) {
    const x = cpos.getX(i), y = cpos.getY(i), z = cpos.getZ(i);
    const h = hash(Math.round(x * 1000), Math.round(y * 1000) + seed, Math.round(z * 1000));
    const r = 1 + (h - 0.5) * 2 * CANOPY_LUMPINESS;
    cpos.setXYZ(i, x * r * p.canopyRadius, y * r * ry, z * r * p.canopyRadius);
  }
  canopy.rotateY(hash(seed, 7, 3) * Math.PI * 2);
  canopy.translate(0, canopyBottom + ry, 0);
  canopy.computeVertexNormals();
  paint(canopy, p.canopyColor, (y) =>
    THREE.MathUtils.lerp(CANOPY_SHADE_BOTTOM, 1, THREE.MathUtils.clamp((y - canopyBottom) / (2 * ry), 0, 1))
  );

  // Both parts are non-indexed with the same attributes, so concatenation is
  // a straight copy; no need for BufferGeometryUtils here.
  return concat([trunk, canopy]);
}

/** Concatenate non-indexed geometries that share the attribute set of the first. */
export function concat(geometries) {
  const out = new THREE.BufferGeometry();
  if (geometries.length === 0) return out;
  for (const name of Object.keys(geometries[0].attributes)) {
    const itemSize = geometries[0].getAttribute(name).itemSize;
    let count = 0;
    for (const g of geometries) count += g.getAttribute(name).count;
    const array = new Float32Array(count * itemSize);
    let offset = 0;
    for (const g of geometries) {
      const attr = g.getAttribute(name);
      array.set(attr.array.subarray(0, attr.count * itemSize), offset);
      offset += attr.count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  for (const g of geometries) g.dispose();
  return out;
}
