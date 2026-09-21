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

const _camDir = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _hit = new THREE.Vector3();

/**
 * Begin an extrusion drag: returns state to track until pointerup, or null.
 * @param {{ x: number, y: number, z: number, sx: number, sy: number, sz: number }} startBox
 */
export function beginExtrudeDrag(clientX, clientY, handle, startBox, camera, raycaster, pointerNdc, window) {
  const normal = handle.normal;
  camera.getWorldDirection(_camDir);
  _planeNormal.crossVectors(normal, _camDir);
  if (_planeNormal.lengthSq() < 1e-8) _planeNormal.crossVectors(normal, camera.up);
  _planeNormal.normalize();

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(_planeNormal, handle.point);
  pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(plane, _hit)) return null;

  return {
    normal: normal.clone(),
    plane,
    startAlong: _hit.dot(normal),
    startBox: { ...startBox },
  };
}

/** Apply drag delta to the start box; returns the new box state. */
export function extrudeFromDrag(drag, clientX, clientY, camera, raycaster, pointerNdc, window) {
  pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(drag.plane, _hit)) return null;
  const delta = _hit.dot(drag.normal) - drag.startAlong;
  return applyExtrude(drag.startBox, drag.normal, delta);
}

