import * as THREE from 'three';
import { applyExtrude, buildingCenter } from './buildings.js';

// Six outward face normals for axis-aligned extrusion handles.
const FACES = [
  { normal: [1, 0, 0], color: 0xffa8a8 },
  { normal: [-1, 0, 0], color: 0xffa8a8 },
  { normal: [0, 1, 0], color: 0xa8ffa8 },
  { normal: [0, -1, 0], color: 0xa8ffa8 },
  { normal: [0, 0, 1], color: 0xa8c8ff },
  { normal: [0, 0, -1], color: 0xa8c8ff },
];

const UP = new THREE.Vector3(0, 1, 0);
const _faceCenter = new THREE.Vector3();
const _normal = new THREE.Vector3();

function faceCenter(b, nx, ny, nz) {
  const cx = b.x + b.sx * 0.5;
  const cy = b.y + b.sy * 0.5;
  const cz = b.z + b.sz * 0.5;
  return _faceCenter.set(
    nx > 0 ? b.x + b.sx : nx < 0 ? b.x : cx,
    ny > 0 ? b.y + b.sy : ny < 0 ? b.y : cy,
    nz > 0 ? b.z + b.sz : nz < 0 ? b.z : cz
  );
}

/** Small arrow mesh (+Y shaft) with an invisible pick volume at the tip. */
function createArrowHandle(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: false });
  const shaftLen = 0.34;
  const headLen = 0.14;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, shaftLen, 8), mat);
  shaft.position.y = shaftLen * 0.5;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.085, headLen, 8), mat);
  head.position.y = shaftLen + headLen * 0.5;
  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(0.26, 0.26, 0.26),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  pick.position.y = shaftLen + headLen * 0.5;
  pick.userData.isPick = true;
  group.add(shaft, head, pick);
  group.renderOrder = 1000;
  return group;
}

/** Parent group for the six face extrusion handles. */
export function createExtrudeGizmo() {
  const root = new THREE.Group();
  root.name = 'extrude-gizmo';
  root.visible = false;
  for (const face of FACES) {
    const handle = createArrowHandle(face.color);
    _normal.set(face.normal[0], face.normal[1], face.normal[2]);
    handle.quaternion.setFromUnitVectors(UP, _normal);
    handle.userData.extrudeNormal = _normal.clone();
    root.add(handle);
  }
  return root;
}

/** Reposition handles on the selected building's faces. */
export function syncExtrudeGizmo(gizmo, building, show) {
  gizmo.visible = show && !!building;
  if (!gizmo.visible) return;

  const minDim = Math.min(building.sx, building.sy, building.sz);
  const scale = THREE.MathUtils.clamp(minDim * 0.38, 0.22, 0.55);

  for (let i = 0; i < FACES.length; i++) {
    const face = FACES[i];
    const handle = gizmo.children[i];
    const nx = face.normal[0];
    const ny = face.normal[1];
    const nz = face.normal[2];
    faceCenter(building, nx, ny, nz);
    handle.scale.setScalar(scale);
    handle.position.copy(_faceCenter).addScaledVector(handle.userData.extrudeNormal, scale * 0.55);
  }
}

/** @returns {{ normal: THREE.Vector3, point: THREE.Vector3 } | null} */
export function pickExtrudeHandle(raycaster, gizmo) {
  if (!gizmo.visible) return null;
  const pickables = [];
  gizmo.traverse((c) => {
    if (c.userData.isPick) pickables.push(c);
  });
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) return null;
  const handle = hits[0].object.parent;
  return {
    normal: handle.userData.extrudeNormal.clone(),
    point: hits[0].point.clone(),
  };
}

const _ndcA = new THREE.Vector3();
const _ndcB = new THREE.Vector3();
const _viewAxis = new THREE.Vector3();

// One world unit along a steeply foreshortened arrow can cover only a pixel
// or two. Tracking that 1:1 turns a tiny nudge into a size clamp (the face
// "jumps to zero"). Never move faster than this many pixels per world unit.
const MIN_PX_PER_UNIT = 8;
// Shorter than this, the arrow is a dot — looking down its shaft — and the
// projected direction is noise. Use screen-up instead.
const SPECK_PX = 1;

/** Pixels covered by one world unit along `axis` through `origin`. */
function axisScreenPerUnit(camera, origin, axis, viewport) {
  _ndcA.copy(origin).project(camera);
  _ndcB.copy(origin).add(axis).project(camera);
  return {
    x: (_ndcB.x - _ndcA.x) * 0.5 * viewport.innerWidth,
    y: -(_ndcB.y - _ndcA.y) * 0.5 * viewport.innerHeight,
  };
}

/** World size of one pixel on a camera-facing surface at `point`. */
function worldUnitsPerPixel(camera, point, viewportHeight) {
  const dist = Math.max(camera.position.distanceTo(point), 1e-3);
  const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * dist;
  return visibleHeight / viewportHeight;
}

/**
 * Screen direction of the extrusion, in pixels per world unit.
 * Fixed for the whole gesture so the sign can't flip as the pointer moves.
 */
function dragAxisPixels(camera, origin, axis, viewport) {
  camera.updateMatrixWorld();
  const per = axisScreenPerUnit(camera, origin, axis, viewport);
  const len = Math.hypot(per.x, per.y);
  const pxPerUnit = 1 / worldUnitsPerPixel(camera, origin, viewport.innerHeight);
  // Cap amplification from foreshortening, but keep the full on-screen
  // length when the arrow is already easy to see.
  const floor = Math.max(MIN_PX_PER_UNIT, pxPerUnit * 0.35);

  if (len >= floor) return per;

  if (len < SPECK_PX) {
    // +Z in view space points back at the camera. Dragging up extrudes
    // outward when the arrow points toward the viewer.
    _viewAxis.copy(axis).transformDirection(camera.matrixWorldInverse);
    return { x: 0, y: _viewAxis.z >= 0 ? -pxPerUnit : pxPerUnit };
  }

  const s = floor / len;
  return { x: per.x * s, y: per.y * s };
}

/**
 * Begin an extrusion drag: returns state to track until pointerup.
 * The pointer delta is projected onto the arrow's screen direction. A drag
 * plane that contains the view ray is edge-on, so the hit flies to infinity
 * and the size clamps to the minimum mid-gesture.
 * @param {{ x: number, y: number, z: number, sx: number, sy: number, sz: number }} startBox
 */
export function beginExtrudeDrag(clientX, clientY, handle, startBox, camera, viewport) {
  const axisPx = dragAxisPixels(camera, handle.point, handle.normal, viewport);
  return {
    normal: handle.normal.clone(),
    startX: clientX,
    startY: clientY,
    axisPxX: axisPx.x,
    axisPxY: axisPx.y,
    startBox: { ...startBox },
  };
}

/** Apply drag delta to the start box; returns the new box state. */
export function extrudeFromDrag(drag, clientX, clientY) {
  const dx = clientX - drag.startX;
  const dy = clientY - drag.startY;
  const denom = drag.axisPxX * drag.axisPxX + drag.axisPxY * drag.axisPxY;
  if (denom < 1e-8) return null;
  const delta = (dx * drag.axisPxX + dy * drag.axisPxY) / denom;
  if (!Number.isFinite(delta)) return null;
  return applyExtrude(drag.startBox, drag.normal, delta);
}

