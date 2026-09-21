import * as THREE from 'three';

// Pastel palette for new cubes — picked at random on placement.
export const PASTEL_PALETTE = [
  0xf4a6a6, // coral
  0xf7c59f, // peach
  0xf9f4a6, // butter
  0xb8e0b8, // mint
  0xa6d4f4, // sky
  0xc4a6f4, // lavender
  0xf4a6e0, // pink
];

const MIN_DIM = 0.1;
const MAX_DIM = 16;
const DIM_STEP = 0.1;
// Nudge off the hit surface so the box doesn't z-fight with terrain/water.
const PLACE_EPS = 0.02;

/**
 * Editable axis-aligned boxes in world space. Each building occupies
 * [x, x+sx) × [y, y+sy) × [z, z+sz); the anchor corner stays fixed when
 * dimensions change. Positions and sizes are continuous (not grid-snapped).
 */
export class BuildingStore {
  constructor() {
    /** @type {Building[]} */
    this.buildings = [];
    this.nextId = 1;
    this.selectedId = null;
  }

  randomColor() {
    return PASTEL_PALETTE[Math.floor(Math.random() * PASTEL_PALETTE.length)];
  }

  /** @returns {Building | null} */
  get(id) {
    return this.buildings.find((b) => b.id === id) ?? null;
  }

  select(id) {
    this.selectedId = id;
  }

  clearSelection() {
    this.selectedId = null;
  }

  /** @returns {Building | null} */
  get selected() {
    return this.selectedId != null ? this.get(this.selectedId) : null;
  }

  /**
   * @param {{ x: number, y: number, z: number, sx?: number, sy?: number, sz?: number, color?: number }} opts
   * @returns {Building}
   */
  add(opts) {
    const id = opts.id ?? this.nextId++;
    if (id >= this.nextId) this.nextId = id + 1;
    const building = {
      id,
      x: opts.x,
      y: opts.y,
      z: opts.z,
      sx: opts.sx ?? 1,
      sy: opts.sy ?? 1,
      sz: opts.sz ?? 1,
      color: opts.color ?? this.randomColor(),
    };
    this.buildings.push(building);
    return building;
  }

  remove(id) {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const [removed] = this.buildings.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
    return removed;
  }

  setDimensions(id, sx, sy, sz) {
    const b = this.get(id);
    if (!b) return false;
    b.sx = clampDim(sx);
    b.sy = clampDim(sy);
    b.sz = clampDim(sz);
    return true;
  }

  /** Set anchor and size together (used after face extrusion). */
  setBox(id, box) {
    const b = this.get(id);
    if (!b) return false;
    b.x = box.x;
    b.y = box.y;
    b.z = box.z;
    b.sx = clampDim(box.sx);
    b.sy = clampDim(box.sy);
    b.sz = clampDim(box.sz);
    return true;
  }

  /** Replace all buildings from a saved snapshot (already validated). */
  restore(buildings, nextId = 1) {
    this.buildings = buildings.map((b) => ({ ...b }));
    this.nextId = nextId;
    this.selectedId = null;
  }

  clear() {
    this.buildings.length = 0;
    this.selectedId = null;
  }
}

function clampDim(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return MIN_DIM;
  const clamped = Math.max(MIN_DIM, Math.min(MAX_DIM, n));
  return Math.round(clamped / DIM_STEP) * DIM_STEP;
}

export function formatDim(v) {
  const s = clampDim(v).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Extrude one face outward by `delta` (displacement along the face normal).
 * Negative faces move the anchor corner so the opposite face stays put.
 */
export function applyExtrude(box, normal, delta) {
  const out = { x: box.x, y: box.y, z: box.z, sx: box.sx, sy: box.sy, sz: box.sz };
  const nx = normal.x;
  const ny = normal.y;
  const nz = normal.z;
  if (Math.abs(nx) > 0.5) {
    const old = out.sx;
    out.sx = clampDim(out.sx + delta);
    if (nx < 0) out.x = box.x - (out.sx - old);
  } else if (Math.abs(ny) > 0.5) {
    const old = out.sy;
    out.sy = clampDim(out.sy + delta);
    if (ny < 0) out.y = box.y - (out.sy - old);
  } else {
    const old = out.sz;
    out.sz = clampDim(out.sz + delta);
    if (nz < 0) out.z = box.z - (out.sz - old);
  }
  return out;
}

/** Centre of a building box in world space. */
export function buildingCenter(b) {
  return [b.x + b.sx * 0.5, b.y + b.sy * 0.5, b.z + b.sz * 0.5];
}

const _worldNormal = new THREE.Vector3();

/**
 * First hit against terrain and/or water for free-form placement.
 * @returns {{ point: THREE.Vector3, normal: THREE.Vector3 } | null}
 */
export function raycastPlacement(raycaster, surfaces) {
  const hits = raycaster.intersectObjects(surfaces, false);
  if (!hits.length) return null;
  const hit = hits[0];
  _worldNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
  return { point: hit.point.clone(), normal: _worldNormal.clone() };
}

/**
 * Min-corner anchor slightly off the picked surface. Up-facing hits centre the
 * footprint on the click point; other faces grow outward from the hit.
 */
export function anchorFromHit(point, normal, sx = 1, sy = 1, sz = 1) {
  if (normal.y > 0.7) {
    return {
      x: point.x - sx * 0.5,
      y: point.y + PLACE_EPS,
      z: point.z - sz * 0.5,
    };
  }
  return {
    x: point.x + normal.x * PLACE_EPS,
    y: point.y + normal.y * PLACE_EPS,
    z: point.z + normal.z * PLACE_EPS,
  };
}

/**
 * Scene group holding one mesh per building plus a selection outline.
 * Rebuilt wholesale after edits (cheap at toy scale).
 */
export function createBuildingsRoot(store) {
  const root = new THREE.Group();
  root.name = 'buildings';
  syncBuildingsMeshes(root, store, false);
  return root;
}

/** @param {boolean} showSelection outline + only when build mode is active and a cube is selected */
export function syncBuildingsMeshes(root, store, showSelection = false) {
  for (const child of [...root.children]) {
    if (child.userData.isSelectionOutline || child.userData.isExtrudeGizmo) continue;
    child.geometry?.dispose?.();
    child.material?.dispose?.();
    root.remove(child);
  }

  for (const b of store.buildings) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(b.sx, b.sy, b.sz),
      new THREE.MeshLambertMaterial({ color: b.color })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(...buildingCenter(b));
    mesh.userData.buildingId = b.id;
    root.add(mesh);
  }

  syncSelectionOutline(root, store, showSelection);
}

/** White edge outline — only while build mode is on and a cube is selected. */
export function syncSelectionOutline(root, store, showSelection) {
  let outline = root.children.find((c) => c.userData.isSelectionOutline);
  const sel = showSelection ? store.selected : null;
  if (!sel) {
    if (outline) {
      outline.geometry.dispose();
      outline.material.dispose();
      root.remove(outline);
    }
    return;
  }

  if (!outline) {
    outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false })
    );
    outline.userData.isSelectionOutline = true;
    outline.renderOrder = 998;
    root.add(outline);
  }

  outline.geometry.dispose();
  outline.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(sel.sx, sel.sy, sel.sz));
  outline.position.set(...buildingCenter(sel));
  outline.scale.set(1.02, 1.02, 1.02);
}

/** Raycast against building meshes; returns building id or null. */
export function pickBuilding(raycaster, root) {
  const meshes = root.children.filter((c) => c.userData.buildingId != null);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  return hits[0].object.userData.buildingId;
}

/** Ghost preview mesh for placement or selection feedback. */
export function createBuildGhost() {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
      depthWrite: false,
    })
  );
  mesh.renderOrder = 997;
  mesh.visible = false;
  return mesh;
}

export function showBuildGhost(mesh, x, y, z, sx, sy, sz, color) {
  mesh.visible = true;
  if (mesh.geometry.parameters.width !== sx || mesh.geometry.parameters.height !== sy || mesh.geometry.parameters.depth !== sz) {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BoxGeometry(sx, sy, sz);
  }
  mesh.material.color.setHex(color);
  mesh.position.set(x + sx * 0.5, y + sy * 0.5, z + sz * 0.5);
}

export function hideBuildGhost(mesh) {
  mesh.visible = false;
}

/** Serialize for storage. */
export function serializeBuildings(store) {
  return {
    buildings: store.buildings.map(({ id, x, y, z, sx, sy, sz, color }) => ({
      id,
      x,
      y,
      z,
      sx,
      sy,
      sz,
      color,
    })),
    nextId: store.nextId,
  };
}

/** Validate and load from storage payload. Returns false if invalid. */
export function validateBuildingsPayload(payload) {
  if (!payload || !Array.isArray(payload.buildings)) return null;
  const buildings = [];
  let maxId = 0;
  for (const b of payload.buildings) {
    if (
      !Number.isInteger(b.id) ||
      !Number.isFinite(b.x) ||
      !Number.isFinite(b.y) ||
      !Number.isFinite(b.z) ||
      !Number.isFinite(b.sx) ||
      !Number.isFinite(b.sy) ||
      !Number.isFinite(b.sz) ||
      b.sx < MIN_DIM ||
      b.sy < MIN_DIM ||
      b.sz < MIN_DIM ||
      b.sx > MAX_DIM ||
      b.sy > MAX_DIM ||
      b.sz > MAX_DIM ||
      !Number.isInteger(b.color)
    ) {
      return null;
    }
    buildings.push({
      id: b.id,
      x: b.x,
      y: b.y,
      z: b.z,
      sx: b.sx,
      sy: b.sy,
      sz: b.sz,
      color: b.color,
    });
    maxId = Math.max(maxId, b.id);
  }
  const nextId =
    Number.isInteger(payload.nextId) && payload.nextId > maxId ? payload.nextId : maxId + 1;
  return { buildings, nextId };
}

export { MIN_DIM, MAX_DIM, DIM_STEP };
