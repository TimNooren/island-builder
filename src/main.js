import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelGrid } from './voxels.js';
import { buildSmoothTerrainGeometry } from './terrainmesh.js';
import { createTerrainMaterial, createSubmergedOverlay } from './terrainmaterial.js';
import { createWater, WATER_LEVEL } from './water.js';
import { buildTreesGeometry, createTreeMaterial } from './trees.js';
import { loadGrid, saveGrid, loadCamera, saveCamera, loadHistory, saveHistory, clearHistory } from './storage.js';
import { UndoStack } from './history.js';
import { createRetroRenderer, snapScene } from './retro.js';

const SIZE = 32;
const HEIGHT = 24;
const DRAG_THRESHOLD_PX = 5;
// Camera saves are debounced: OrbitControls fires `change` every frame while
// damping settles, and one write shortly after the view stops is enough.
const CAMERA_SAVE_DELAY_MS = 300;
// Shadow maps are a post-PS1 luxury; the low-res, dithered look reads better
// without them (see retro.js). Flip on for a softer, modern rendering.
const SHADOWS = false;
// Right-drag orbit keeps the camera at least this far above the water. The
// pitch limit alone doesn't guarantee it when pivoting around a raised point.
const ORBIT_MIN_CAMERA_Y = WATER_LEVEL + 0.05;
// Keep the view axis off the exact vertical so lookAt stays well defined
// (same margin as THREE.Spherical.makeSafe).
const POLAR_EPS = 1e-6;

// ---------- Renderer / scene ----------
// No antialiasing and pixel ratio 1: retro.js renders at a fraction of the
// window size and upscales with nearest filtering, so hardware AA and HiDPI
// would only be smoothed away again.
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = SHADOWS;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const retro = createRetroRenderer(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd0f5);
// Dense, close fog: PS1 games hid their short draw distance behind it, and
// it also fades the water's snapped vertices before they get too coarse.
scene.fog = new THREE.Fog(0x9fd0f5, SIZE * 1.5, SIZE * 5);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, SIZE * 20);
camera.position.set(SIZE * 1.1, SIZE * 0.9, SIZE * 1.1);
retro.setSize(window.innerWidth, window.innerHeight, camera);

// Google-Earth-ish camera, Townscaper-ish edit:
//   left drag            pan
//   right drag           pan
//   shift + left drag    orbit around the raycast hit (off-centre ok)
//   cmd/ctrl held        extrude mode (placement ghost + click to add)
//   right click          remove
// OrbitControls must not rotate: with LEFT mapped to PAN it treats any
// modifier+left as ROTATE around the look-at target — the wrong pivot.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(SIZE / 2, WATER_LEVEL, SIZE / 2);
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.enableRotate = false;
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 4;
controls.maxDistance = SIZE * 4;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
loadCamera(camera, controls);
// Poses saved before cursor-pivot orbit may have a raised target; snap back
// to the water plane on load. Pan stays horizontal (screenSpacePanning off);
// the polar limit plus a floor in orbitAroundCursor keep the camera above water.
controls.target.y = WATER_LEVEL;
controls.update();

let cameraSaveTimer = 0;
controls.addEventListener('change', () => {
  clearTimeout(cameraSaveTimer);
  cameraSaveTimer = setTimeout(() => saveCamera(camera, controls), CAMERA_SAVE_DELAY_MS);
});
// Refreshing mid-damping would otherwise lose the last few hundred ms of motion.
window.addEventListener('pagehide', () => saveCamera(camera, controls));

// ---------- Lights ----------
scene.add(new THREE.HemisphereLight(0xdff3ff, 0x4a6b3a, 0.7));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(SIZE * 0.8, SIZE * 1.4, SIZE * 0.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = SIZE * 4;
sun.shadow.camera.left = -SIZE;
sun.shadow.camera.right = SIZE;
sun.shadow.camera.top = SIZE;
sun.shadow.camera.bottom = -SIZE;
sun.shadow.bias = -0.0005;
sun.target.position.set(SIZE / 2, 0, SIZE / 2);
scene.add(sun, sun.target);

// ---------- Water ----------
const WATER_EXTENT = SIZE * 12;
const water = createWater({ size: SIZE, extent: WATER_EXTENT });
scene.add(water.mesh);

// Faint grid showing the editable footprint, floating just above the swell.
const gridHelper = new THREE.GridHelper(SIZE, SIZE, 0x8fc1ee, 0x5e9fd9);
gridHelper.position.set(SIZE / 2, water.top + 0.02, SIZE / 2);
gridHelper.material.transparent = true;
gridHelper.material.opacity = 0.35;
scene.add(gridHelper);

// ---------- Terrain ----------
const grid = new VoxelGrid(SIZE, HEIGHT);
const undoStack = new UndoStack();
if (loadGrid(grid)) loadHistory(undoStack, grid);
else clearHistory();
const terrainMaterial = createTerrainMaterial();
let terrain = new THREE.Mesh(buildSmoothTerrainGeometry(grid), terrainMaterial);
terrain.castShadow = true;
terrain.receiveShadow = true;
scene.add(terrain);
// Second pass that shows the terrain just below the waterline through the
// opaque water (see terrainmaterial.js).
const terrainOverlay = createSubmergedOverlay(terrain);
scene.add(terrainOverlay);
// Trees are derived from the grid too (see trees.js) and rebuilt with it.
const trees = new THREE.Mesh(buildTreesGeometry(grid), createTreeMaterial());
trees.castShadow = true;
trees.receiveShadow = true;
scene.add(trees);

function rebuildTerrain() {
  terrain.geometry.dispose();
  terrain.geometry = buildSmoothTerrainGeometry(grid);
  terrainOverlay.geometry = terrain.geometry;
  trees.geometry.dispose();
  trees.geometry = buildTreesGeometry(grid);
  water.updateShore(grid);
}

function persist() {
  saveGrid(grid);
  saveHistory(undoStack);
}

/** Apply a cell edit, record it for undo, and refresh derived state. */
function editCell(x, y, z, solid) {
  const prev = grid.get(x, y, z);
  if (!!prev === !!solid) return;
  undoStack.push(x, y, z, prev, solid);
  grid.set(x, y, z, solid);
  rebuildTerrain();
  persist();
}

function applyHistory(entry, solid) {
  grid.set(entry.x, entry.y, entry.z, solid);
  rebuildTerrain();
  persist();
  updateGhost(lastPointer.x, lastPointer.y, ghostOptsFromKeys());
}

function undo() {
  const entry = undoStack.popUndo();
  if (!entry) return;
  applyHistory(entry, entry.before);
}

function redo() {
  const entry = undoStack.popRedo();
  if (!entry) return;
  applyHistory(entry, entry.after);
}

// ---------- Cursor: arrow on the picked face, translucent disc at its base ----------
// Drawn without depth testing so it never sinks into the smoothed terrain and
// stays readable when the picked face is partly hidden behind a slope.
const CURSOR_ADD = new THREE.Color(0xffffff);
const CURSOR_REMOVE = new THREE.Color(0xff5a4d);
const ARROW_SHAFT_LEN = 0.55;
const ARROW_HEAD_LEN = 0.3;
const ARROW_LEN = ARROW_SHAFT_LEN + ARROW_HEAD_LEN;

const cursorMaterials = [];
function cursorMaterial(opacity) {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  cursorMaterials.push(m);
  return m;
}

const cursor = new THREE.Group();
cursor.renderOrder = 999;
cursor.visible = false;

// Base disc lies in the face plane (local XZ), facing along the local +Y normal.
const cursorDisc = new THREE.Mesh(new THREE.CircleGeometry(0.44, 48), cursorMaterial(0.3));
cursorDisc.rotation.x = -Math.PI / 2;
const cursorRing = new THREE.Mesh(new THREE.RingGeometry(0.41, 0.44, 48), cursorMaterial(0.85));
cursorRing.rotation.x = -Math.PI / 2;

// Arrow along local +Y: shaft from the disc, cone on top.
const cursorArrow = new THREE.Group();
const cursorShaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.06, 0.06, ARROW_SHAFT_LEN, 16),
  cursorMaterial(0.9)
);
cursorShaft.position.y = ARROW_SHAFT_LEN / 2;
const cursorHead = new THREE.Mesh(new THREE.ConeGeometry(0.18, ARROW_HEAD_LEN, 24), cursorMaterial(0.9));
cursorHead.position.y = ARROW_SHAFT_LEN + ARROW_HEAD_LEN / 2;
cursorArrow.add(cursorShaft, cursorHead);

cursor.add(cursorDisc, cursorRing, cursorArrow);
for (const child of [cursorDisc, cursorRing, cursorShaft, cursorHead]) child.renderOrder = 999;
scene.add(cursor);

const UP = new THREE.Vector3(0, 1, 0);
const tmpNormal = new THREE.Vector3();

// ---------- Picking ----------
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const NO_PICK = { cell: null, target: null, normal: null, base: null };

/**
 * Returns what's under the pointer, using the voxel cubes as hit boxes rather
 * than the smoothed render mesh:
 *   cell   – solid block under the pointer (for removal), or null
 *   target – empty cell that would be filled (for adding), or null
 *   normal – [nx,ny,nz] of the face between them
 *   base   – world-space centre of that face (where the cursor sits)
 */
function pick(clientX, clientY) {
  pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const { origin: o, direction: d } = raycaster.ray;
  const hit = grid.raycast(o.x, o.y, o.z, d.x, d.y, d.z);
  if (!hit) return NO_PICK;

  const [nx, ny, nz] = hit.normal;
  if (hit.cell) {
    const [x, y, z] = hit.cell;
    const isFace = nx !== 0 || ny !== 0 || nz !== 0;
    return {
      cell: hit.cell,
      target: hit.prev,
      normal: isFace ? hit.normal : [0, 1, 0],
      base: [x + 0.5 + nx * 0.5, y + 0.5 + ny * 0.5, z + 0.5 + nz * 0.5],
    };
  }

  // Crossed only empty cells: the pointer is on open water. Place on the
  // ground-level tile under the point where the ray meets the still surface.
  // (The grid floor is half a cell below the surface, so where the ray exits
  // the grid is not where the user sees it hit the water.)
  if (d.y >= 0) return NO_PICK;
  const t = (water.level - o.y) / d.y;
  const x = Math.floor(o.x + d.x * t);
  const z = Math.floor(o.z + d.z * t);
  if (t > 0 && grid.inBounds(x, 0, z) && !grid.get(x, 0, z)) {
    return {
      cell: null,
      target: [x, 0, z],
      normal: [0, 1, 0],
      base: [x + 0.5, water.top + 0.03, z + 0.5],
    };
  }
  return NO_PICK;
}

function updateGhost(clientX, clientY, { extrude = false, remove = false } = {}) {
  const { cell, target, normal, base } = pick(clientX, clientY);
  const showRemove = remove && cell;
  const showAdd = extrude && !remove && target;
  if (!(showRemove || showAdd)) {
    cursor.visible = false;
    return;
  }
  cursor.visible = true;
  cursor.position.set(base[0], base[1], base[2]);
  tmpNormal.set(normal[0], normal[1], normal[2]);
  cursor.quaternion.setFromUnitVectors(UP, tmpNormal);

  // Add: arrow grows out of the face. Remove: arrow hangs above the face,
  // pointing back into the block.
  if (showRemove) {
    cursorArrow.scale.y = -1;
    cursorArrow.position.y = ARROW_LEN;
  } else {
    cursorArrow.scale.y = 1;
    cursorArrow.position.y = 0;
  }
  const col = showRemove ? CURSOR_REMOVE : CURSOR_ADD;
  for (const m of cursorMaterials) m.color.copy(col);
}

// ---------- Input: distinguish click from drag ----------
let pointerDown = null; // { x, y, button }
let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
// Latest modifier state from key/pointer events (keyup clears meta/ctrl reliably).
let mods = { shift: false, extrude: false };

function syncMods(e) {
  mods.shift = e.shiftKey;
  // Cmd on macOS, Ctrl on Windows/Linux — extrude mode. Shift is orbit-only.
  mods.extrude = (e.metaKey || e.ctrlKey) && !e.shiftKey;
}

function ghostOpts(remove = false) {
  return { extrude: mods.extrude, remove };
}

function ghostOptsFromKeys() {
  return { extrude: mods.extrude, remove: false };
}

// Cursor-pivot orbit (Google Earth): shift + left-drag rotates the camera and
// look-at rigidly about the raycast hit so it stays fixed on screen.
const orbitPivot = new THREE.Vector3();
const orbitAxis = new THREE.Vector3();
const orbitOffset = new THREE.Vector3();
const orbitSpherical = new THREE.Spherical();
let orbitArmed = false;
let orbitDragging = false;
let orbitLastX = 0;
let orbitLastY = 0;

// OrbitControls.STATE.PAN — used to force-pan under cmd/ctrl (see pointerdown).
const OC_STATE_PAN = 2;

/** World point under the pointer to pivot around; falls back to the water plane, then the current look-at. */
function pickOrbitPivot(clientX, clientY, out) {
  const { base } = pick(clientX, clientY);
  if (base) {
    out.set(base[0], base[1], base[2]);
    return;
  }
  pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
  const { origin: o, direction: d } = raycaster.ray;
  if (d.y < 0) {
    const t = (WATER_LEVEL - o.y) / d.y;
    if (t > 0) {
      out.set(o.x + d.x * t, WATER_LEVEL, o.z + d.z * t);
      return;
    }
  }
  out.copy(controls.target);
}

/**
 * Largest rotation towards `angle` about the horizontal unit `axis` through
 * the origin that keeps `p` (the pivot-relative camera position) at or above
 * `minY`. Bisects rather than solving the cosine analytically: the wrap-around
 * and tangency cases of the closed form are fiddlier than 24 cheap iterations.
 */
function limitPitchToFloor(p, axis, angle, minY) {
  // Height after rotating by t is a·cos t + b·sin t (axis.y is 0).
  const a = p.y;
  const b = axis.z * p.x - axis.x * p.z;
  const yAt = (t) => a * Math.cos(t) + b * Math.sin(t);
  if (yAt(angle) >= minY) return angle;
  if (a < minY) return yAt(angle) > a ? angle : 0; // already under: only allow climbing
  let lo = 0;
  let hi = angle;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (yAt(mid) >= minY) lo = mid;
    else hi = mid;
  }
  return lo;
}

function orbitAroundCursor(dx, dy) {
  // Same sensitivity mapping as OrbitControls._handleMouseMoveRotate.
  const h = renderer.domElement.clientHeight;
  const angleH = (2 * Math.PI * dx * controls.rotateSpeed) / h;
  const angleV = (2 * Math.PI * dy * controls.rotateSpeed) / h;
  if (angleH === 0 && angleV === 0) return;

  const cam = camera.position;
  const target = controls.target;
  cam.sub(orbitPivot);
  target.sub(orbitPivot);

  if (angleV !== 0) {
    // Pitch about the camera's own right axis. It is horizontal (the camera
    // never rolls), so the rigidly rotated view has no roll either and the
    // lookAt below reproduces it exactly. Any other horizontal axis — e.g. the
    // one perpendicular to camera→pivot — introduces roll that lookAt then
    // removes, and that correction is what slides the pivot on screen.
    orbitAxis.set(1, 0, 0).applyQuaternion(camera.quaternion);
    // The pitch is the polar angle of the view axis, so OrbitControls' limits
    // (and the water floor) are applied to the angle up front. Correcting the
    // camera around the target afterwards would move the pivot too.
    orbitSpherical.setFromVector3(orbitOffset.subVectors(cam, target));
    const phi = THREE.MathUtils.clamp(
      orbitSpherical.phi - angleV,
      Math.max(controls.minPolarAngle, POLAR_EPS),
      Math.min(controls.maxPolarAngle, Math.PI - POLAR_EPS)
    );
    const rot = limitPitchToFloor(cam, orbitAxis, phi - orbitSpherical.phi, ORBIT_MIN_CAMERA_Y - orbitPivot.y);
    cam.applyAxisAngle(orbitAxis, rot);
    target.applyAxisAngle(orbitAxis, rot);
  }

  if (angleH !== 0) {
    cam.applyAxisAngle(UP, -angleH);
    target.applyAxisAngle(UP, -angleH);
  }

  cam.add(orbitPivot);
  target.add(orbitPivot);
  camera.lookAt(target);

  // Pan and zoom-to-cursor treat the target as a point on the water plane, so
  // slide it back there along the view axis. The camera doesn't move, so the
  // pivot stays fixed; the distance is kept within OrbitControls' limits so
  // its update() has nothing left to correct.
  orbitAxis.set(0, 0, -1).applyQuaternion(camera.quaternion);
  let dist = cam.distanceTo(target);
  if (orbitAxis.y < 0) dist = (WATER_LEVEL - cam.y) / orbitAxis.y;
  dist = THREE.MathUtils.clamp(dist, controls.minDistance, controls.maxDistance);
  target.copy(cam).addScaledVector(orbitAxis, dist);

  controls.dispatchEvent({ type: 'change' });
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

renderer.domElement.addEventListener('pointerdown', (e) => {
  syncMods(e);
  pointerDown = { x: e.clientX, y: e.clientY, button: e.button };

  if (e.button === 0 && e.shiftKey) {
    // Shift+left: our cursor-pivot orbit (OC rotate is disabled).
    pickOrbitPivot(e.clientX, e.clientY, orbitPivot);
    orbitArmed = true;
    orbitDragging = false;
    orbitLastX = e.clientX;
    orbitLastY = e.clientY;
  } else if (e.button === 0 && mods.extrude) {
    // Cmd/ctrl+left: OC would no-op (modifier swaps pan→rotate, rotate off).
    // Force its pan path so extrude mode can still drag-pan.
    controls._handleMouseDownPan(e);
    controls.state = OC_STATE_PAN;
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  syncMods(e);
  lastPointer = { x: e.clientX, y: e.clientY };
  if (orbitArmed && (e.buttons & 1) !== 0) {
    if (!orbitDragging) {
      const dx = e.clientX - pointerDown.x;
      const dy = e.clientY - pointerDown.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        orbitDragging = true;
        orbitLastX = e.clientX;
        orbitLastY = e.clientY;
      }
    }
    if (orbitDragging) {
      orbitAroundCursor(e.clientX - orbitLastX, e.clientY - orbitLastY);
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
      cursor.visible = false;
      return;
    }
  }
  updateGhost(e.clientX, e.clientY, ghostOpts((e.buttons & 2) !== 0));
});

renderer.domElement.addEventListener('pointerup', (e) => {
  syncMods(e);
  const wasOrbitDrag = orbitArmed && e.button === 0 && orbitDragging;
  const wasOrbitGesture = orbitArmed && e.button === 0;
  if (wasOrbitGesture) {
    orbitArmed = false;
    orbitDragging = false;
  }
  if (!pointerDown || pointerDown.button !== e.button) {
    pointerDown = null;
    updateGhost(e.clientX, e.clientY, ghostOpts());
    return;
  }
  const dx = e.clientX - pointerDown.x;
  const dy = e.clientY - pointerDown.y;
  pointerDown = null;
  if (wasOrbitDrag || wasOrbitGesture || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
    updateGhost(e.clientX, e.clientY, ghostOpts());
    return;
  }

  const { cell, target } = pick(e.clientX, e.clientY);
  if (e.button === 0 && mods.extrude && target) {
    editCell(...target, true);
  } else if (e.button === 2 && cell) {
    editCell(...cell, false);
  }
  updateGhost(e.clientX, e.clientY, ghostOpts());
});

renderer.domElement.addEventListener('pointerleave', () => {
  orbitArmed = false;
  orbitDragging = false;
  cursor.visible = false;
});

window.addEventListener('keydown', (e) => {
  syncMods(e);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.altKey) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  updateGhost(lastPointer.x, lastPointer.y, ghostOptsFromKeys());
});

window.addEventListener('keyup', (e) => {
  syncMods(e);
  updateGhost(lastPointer.x, lastPointer.y, ghostOptsFromKeys());
});

window.addEventListener('blur', () => {
  mods.shift = false;
  mods.extrude = false;
  cursor.visible = false;
});

window.addEventListener('resize', () => {
  retro.setSize(window.innerWidth, window.innerHeight, camera);
});

// ---------- Loop ----------
rebuildTerrain();
// Everything is in the scene now; give every material the PS1 vertex wobble.
snapScene(scene);
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  water.update(clock.getElapsedTime());
  retro.render(scene, camera);
}
animate();
