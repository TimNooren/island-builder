import * as THREE from 'three';
import {
  applyExtrude,
  buildingCenter,
  buildingLocalDirToWorld,
  buildingLocalToWorld,
  wrapYaw,
} from './buildings.js';

// Six outward face normals for axis-aligned extrusion handles.
const FACES = [
  { normal: [1, 0, 0], color: 0xffa8a8 },
  { normal: [-1, 0, 0], color: 0xffa8a8 },
  { normal: [0, 1, 0], color: 0xa8ffa8 },
  { normal: [0, -1, 0], color: 0xa8ffa8 },
  { normal: [0, 0, 1], color: 0xa8c8ff },
  { normal: [0, 0, -1], color: 0xa8c8ff },
];

// Above the cursor (999) and the selection outline (998).
const GIZMO_RENDER_ORDER = 1001;

// Authored extrusion arrow, along local +Y, before the screen-space scale.
const SHAFT_LEN = 0.34;
const HEAD_LEN = 0.14;
const AUTHORED_ARROW_LEN = SHAFT_LEN + HEAD_LEN;
// Constant size in CSS pixels. World scale grows with camera distance so a
// zoomed-out handle stays this many pixels long instead of shrinking away.
const ARROW_PX = 56;
// Gap between a face and the base of its arrow, and between the roof and the
// yaw arc. In pixels, so the clearance doesn't collapse when you zoom out.
const FACE_GAP_PX = 8;
const ARC_LIFT_PX = 12;
// Grab thickness of the yaw arc. The visible stroke stays thinner.
const ARC_PICK_PX = 16;
// Visible tube radius at authored scale (scale 1). Grows with ARROW_PX.
const ARC_TUBE_RADIUS = 0.04;

const UP = new THREE.Vector3(0, 1, 0);
const _faceCenter = new THREE.Vector3();
const _localFace = new THREE.Vector3();
const _normal = new THREE.Vector3();

// Quarter-turn-plus arc in the corner between local +X and +Z, so it sits
// clear of the face arrows. The head is at the low-angle end and points
// along +yaw (decreasing angle); see syncRotateGizmo.
const ARC_START = 0.28;
const ARC_SPAN = 1.05;
const ARC_COLOR = 0xffd27a;
// Fraction of the footprint's corner distance. Below 1 the arc crosses the
// corner; it is drawn on top of the block, so it does not have to orbit outside.
const ARC_RADIUS_SCALE = 0.7;
// Extra reach past that scaled circle, in CSS pixels.
const ARC_GAP_PX = 4;

function localFaceCenter(b, nx, ny, nz, target) {
  return target.set(
    nx > 0 ? b.sx : nx < 0 ? 0 : b.sx * 0.5,
    ny > 0 ? b.sy : ny < 0 ? 0 : b.sy * 0.5,
    nz > 0 ? b.sz : nz < 0 ? 0 : b.sz * 0.5
  );
}

/** Horizontal arc of a given radius, centred on the building, used for the rotate handle. */
class YawArcCurve extends THREE.Curve {
  constructor(radius, a0, a1) {
    super();
    this.radius = radius;
    this.a0 = a0;
    this.a1 = a1;
  }

  getPoint(t, optionalTarget = new THREE.Vector3()) {
    const a = this.a0 + (this.a1 - this.a0) * t;
    return optionalTarget.set(Math.cos(a) * this.radius, 0, Math.sin(a) * this.radius);
  }
}

/** Small arrow mesh (+Y shaft) with an invisible pick volume at the tip. */
function createArrowHandle(color) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, SHAFT_LEN, 8), mat);
  shaft.position.y = SHAFT_LEN * 0.5;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, HEAD_LEN, 8), mat);
  head.position.y = SHAFT_LEN + HEAD_LEN * 0.5;
  const pick = new THREE.Mesh(
    new THREE.BoxGeometry(0.28, 0.28, 0.28),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  pick.position.y = SHAFT_LEN + HEAD_LEN * 0.5;
  pick.userData.isPick = true;
  // Drawn after the scene, water, and cursor so a handle behind a block
  // still shows. renderOrder is per mesh; the group value is ignored.
  shaft.renderOrder = GIZMO_RENDER_ORDER;
  head.renderOrder = GIZMO_RENDER_ORDER;
  group.add(shaft, head, pick);
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
    handle.userData.localNormal = _normal.clone();
    handle.userData.extrudeNormal = _normal.clone();
    root.add(handle);
  }
  return root;
}

/** Reposition handles on the selected building's faces. */
export function syncExtrudeGizmo(gizmo, building, show, camera, viewportHeight) {
  gizmo.visible = show && !!building;
  if (!gizmo.visible) return;

  const [bx, by, bz] = buildingCenter(building);
  const wupp = screenWorldPerPixel(camera, _faceCenter.set(bx, by, bz), viewportHeight);
  const scale = (ARROW_PX * wupp) / AUTHORED_ARROW_LEN;
  const gap = FACE_GAP_PX * wupp;

  for (let i = 0; i < FACES.length; i++) {
    const face = FACES[i];
    const handle = gizmo.children[i];
    const nx = face.normal[0];
    const ny = face.normal[1];
    const nz = face.normal[2];
    localFaceCenter(building, nx, ny, nz, _localFace);
    buildingLocalToWorld(building, _localFace.x, _localFace.y, _localFace.z, _faceCenter);
    buildingLocalDirToWorld(building, nx, ny, nz, _normal);
    handle.userData.extrudeNormal.copy(_normal);
    handle.quaternion.setFromUnitVectors(UP, _normal);
    handle.scale.setScalar(scale);
    handle.position.copy(_faceCenter).addScaledVector(_normal, gap);
  }
}

/** Curved arrow around the building's vertical axis. */
export function createRotateGizmo() {
  const root = new THREE.Group();
  root.name = 'rotate-gizmo';
  root.visible = false;
  const mat = new THREE.MeshBasicMaterial({
    color: ARC_COLOR,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const shaft = new THREE.Mesh(
    new THREE.TubeGeometry(new YawArcCurve(1, ARC_START, ARC_START + ARC_SPAN), 8, 0.02, 4, false),
    mat
  );
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, HEAD_LEN, 8), mat);
  const pick = new THREE.Mesh(
    new THREE.TubeGeometry(new YawArcCurve(1, ARC_START - 0.2, ARC_START + ARC_SPAN), 8, 0.12, 4, false),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  pick.userData.isPick = true;
  shaft.renderOrder = GIZMO_RENDER_ORDER;
  head.renderOrder = GIZMO_RENDER_ORDER;
  root.add(shaft, head, pick);
  return root;
}

/**
 * Park the arc just above the roof, turned with the building. The curve
 * follows the footprint; the stroke and head stay a constant pixel size.
 * Geometry is rebuilt only when that size changes — a yaw drag only needs
 * the group's rotation.
 */
export function syncRotateGizmo(gizmo, building, show, camera, viewportHeight) {
  gizmo.visible = show && !!building;
  if (!gizmo.visible) return;

  const [cx, cy, cz] = buildingCenter(building);
  const wupp = screenWorldPerPixel(camera, _faceCenter.set(cx, cy, cz), viewportHeight);
  const scale = (ARROW_PX * wupp) / AUTHORED_ARROW_LEN;
  const radius = 0.5 * Math.hypot(building.sx, building.sz) * ARC_RADIUS_SCALE + ARC_GAP_PX * wupp;
  gizmo.position.set(cx, building.y + building.sy + ARC_LIFT_PX * wupp, cz);
  gizmo.rotation.y = building.yaw || 0;

  const key = `${radius.toFixed(3)}|${scale.toFixed(3)}`;
  if (gizmo.userData.geomKey === key) return;
  gizmo.userData.geomKey = key;

  const shaft = gizmo.children[0];
  const head = gizmo.children[1];
  const pick = gizmo.children[2];
  const a0 = ARC_START;
  const a1 = ARC_START + ARC_SPAN;
  shaft.geometry.dispose();
  pick.geometry.dispose();
  shaft.geometry = new THREE.TubeGeometry(
    new YawArcCurve(radius, a0, a1),
    20,
    ARC_TUBE_RADIUS * scale,
    6,
    false
  );
  // The head hangs off the low-angle end, so the pick curve starts earlier.
  pick.geometry = new THREE.TubeGeometry(
    new YawArcCurve(radius, a0 - 0.22, a1),
    16,
    ARC_PICK_PX * wupp,
    6,
    false
  );

  // +yaw moves a local point toward decreasing angle: (sin a, 0, −cos a).
  const dir = new THREE.Vector3(Math.sin(a0), 0, -Math.cos(a0)).normalize();
  const at = new THREE.Vector3(Math.cos(a0) * radius, 0, Math.sin(a0) * radius);
  head.scale.setScalar(scale);
  head.position.copy(at).addScaledVector(dir, HEAD_LEN * scale * 0.5);
  head.quaternion.setFromUnitVectors(UP, dir);
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
    localNormal: handle.userData.localNormal.clone(),
    point: hits[0].point.clone(),
    distance: hits[0].distance,
  };
}

/** @returns {{ point: THREE.Vector3, distance: number } | null} */
export function pickRotateHandle(raycaster, gizmo) {
  if (!gizmo.visible) return null;
  const pickables = [];
  gizmo.traverse((c) => {
    if (c.userData.isPick) pickables.push(c);
  });
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) return null;
  return {
    point: hits[0].point.clone(),
    distance: hits[0].distance,
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
  return visibleHeight / Math.max(viewportHeight, 1);
}

// Snap to ~3% steps. A resting camera jitters by much less than that, and
// the yaw arc would otherwise rebuild its tube every frame.
function screenWorldPerPixel(camera, point, viewportHeight) {
  const raw = worldUnitsPerPixel(camera, point, viewportHeight);
  const step = Math.log(1.03);
  return Math.exp(Math.round(Math.log(raw) / step) * step);
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
    localNormal: handle.localNormal.clone(),
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
  return applyExtrude(drag.startBox, drag.localNormal, delta);
}

// Below this, a ray is too close to parallel with the ground plane and the
// hit runs away to infinity. Fall back to a screen-space tangent.
const PLANE_RAY_MIN_Y = 0.12;

/**
 * Angle of the view ray's hit on the horizontal plane through `planeY`,
 * measured around the pivot. Null when the plane is edge-on or behind.
 */
function planeYawAngle(raycaster, pivotX, pivotZ, planeY) {
  const origin = raycaster.ray.origin;
  const dir = raycaster.ray.direction;
  if (Math.abs(dir.y) < PLANE_RAY_MIN_Y) return null;
  const t = (planeY - origin.y) / dir.y;
  if (!(t >= 0)) return null;
  const x = origin.x + dir.x * t - pivotX;
  const z = origin.z + dir.z * t - pivotZ;
  const dist2 = x * x + z * z;
  if (dist2 < 1e-4 || dist2 > 200 * 200) return null;
  return Math.atan2(x, z);
}

/**
 * Begin a yaw drag. The mapping is fixed for the gesture: the angle of the
 * pointer around the pivot when the ground plane faces the camera, otherwise
 * the screen direction in which the grab point moves for +yaw.
 */
export function beginRotateDrag(clientX, clientY, raycaster, handlePoint, building, camera, viewport) {
  const [cx, , cz] = buildingCenter(building);
  const startAngle = planeYawAngle(raycaster, cx, cz, handlePoint.y);
  const ox = handlePoint.x - cx;
  const oz = handlePoint.z - cz;
  // d(world)/d(yaw) at the grab point. Its length is the radius, so the
  // screen projection is pixels per radian.
  const tangent = new THREE.Vector3(oz, 0, -ox);
  if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, -1);
  const axisPx = dragAxisPixels(camera, handlePoint, tangent, viewport);
  return {
    pivotX: cx,
    pivotZ: cz,
    planeY: handlePoint.y,
    startAngle,
    usePlane: startAngle != null,
    startYaw: building.yaw || 0,
    startX: clientX,
    startY: clientY,
    axisPxX: axisPx.x,
    axisPxY: axisPx.y,
  };
}

/**
 * Yaw for the current pointer. Null when the chosen mapping can't be
 * evaluated this frame — the caller keeps the last angle.
 */
export function yawFromDrag(drag, clientX, clientY, raycaster) {
  if (drag.usePlane) {
    const angle = planeYawAngle(raycaster, drag.pivotX, drag.pivotZ, drag.planeY);
    if (angle == null) return null;
    const delta = Math.atan2(Math.sin(angle - drag.startAngle), Math.cos(angle - drag.startAngle));
    return wrapYaw(drag.startYaw + delta);
  }
  const dx = clientX - drag.startX;
  const dy = clientY - drag.startY;
  const denom = drag.axisPxX * drag.axisPxX + drag.axisPxY * drag.axisPxY;
  if (denom < 1e-8) return drag.startYaw;
  const delta = (dx * drag.axisPxX + dy * drag.axisPxY) / denom;
  if (!Number.isFinite(delta)) return drag.startYaw;
  return wrapYaw(drag.startYaw + delta);
}

