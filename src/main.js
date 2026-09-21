import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelGrid } from './voxels.js';
import { createWater, WATER_LEVEL } from './water.js';
import { createDerivedViews } from './derived.js';
import {
  loadGrid,
  saveGrid,
  loadCamera,
  saveCamera,
  loadHistory,
  saveHistory,
  clearHistory,
  loadControlMode,
  saveControlMode,
} from './storage.js';
import { createBuildMode } from './buildmode.js';
import { UndoStack } from './history.js';
import { createRetroRenderer, snapScene } from './retro.js';
import { createDayNight, DEFAULT_TIME } from './daynight.js';

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

// Two control schemes (toggle in the HUD; preference is persisted):
//
// Earth (Google-Earth-ish camera, modifier paint):
//   left / right drag          pan
//   shift + left drag          orbit around the raycast hit (off-centre ok)
//   cmd/ctrl + left drag       paint add (cell-change; no pan)
//   cmd/ctrl + shift + left    paint erase (cell-change; no pan)
// OrbitControls must not rotate: with LEFT mapped to PAN it treats any
// modifier+left as ROTATE around the look-at target — the wrong pivot. That
// swap is also what blocks pan while cmd/ctrl is held (rotate is disabled).
//
// 1-2-3 (DCC-style nav, free paint) — same camera feel as Earth:
//   left drag / click          paint add
//   right drag / click         paint erase
//   1 + drag                   pan   (same as Earth drag)
//   2 + drag                   zoom  (pointer drag only — no wheel/trackpad)
//   3 + drag                   orbit (same cursor-pivot as Earth ⇧ drag)
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(SIZE / 2, WATER_LEVEL, SIZE / 2);
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 4;
controls.maxDistance = SIZE * 4;
controls.maxPolarAngle = Math.PI / 2 - 0.05;

/** @type {'earth' | 'tools' | 'build'} */
let controlMode = loadControlMode('earth');
// Which 1/2/3 nav key is held in tools mode. Only one action is active;
// priority is orbit > zoom > pan if several are down.
const toolKeys = { pan: false, zoom: false, orbit: false };
// Shared with the pointer handlers below; declared early so mode switches can
// avoid remapping OrbitControls mid-gesture.
let pointerDown = null; // { x, y } — orbit arm position for the drag threshold

function toolNavAction() {
  if (toolKeys.orbit) return THREE.MOUSE.ROTATE;
  if (toolKeys.zoom) return THREE.MOUSE.DOLLY;
  if (toolKeys.pan) return THREE.MOUSE.PAN;
  return null;
}

function applyControlMode() {
  if (controlMode === 'earth' || controlMode === 'build') {
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
  } else {
    // Sync LEFT to the current nav keys. OrbitControls latches its action on
    // pointerdown, so a mid-drag remap only affects the next gesture — and we
    // must still clear DOLLY/PAN on keyup even if the pointer left the canvas
    // (otherwise LEFT stays bound and "zoom mode" never releases).
    const action = toolNavAction();
    controls.mouseButtons = {
      LEFT: action === THREE.MOUSE.ROTATE ? null : action,
      MIDDLE: null,
      RIGHT: null,
    };
  }
  // Rotate is always custom (cursor-pivot); never hand it to OrbitControls.
  controls.enableRotate = false;
  const earth = controlMode === 'earth';
  const tools = controlMode === 'tools';
  const building = controlMode === 'build';
  document.getElementById('mode-earth-btn').setAttribute('aria-pressed', String(earth));
  document.getElementById('mode-tools-btn').setAttribute('aria-pressed', String(tools));
  document.getElementById('mode-build-btn').setAttribute('aria-pressed', String(building));
  document.getElementById('hud-keys-earth').hidden = !earth;
  document.getElementById('hud-keys-tools').hidden = !tools;
  document.getElementById('hud-keys-build').hidden = !building;
  buildMode.setActive(building);
}

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

// ---------- Lights / day–night ----------
// Colours and intensities are owned by daynight.js; these are just the nodes
// it drives. Starting values match the old fixed daylight until setTime runs.
const hemi = new THREE.HemisphereLight(0xdff3ff, 0x4a6b3a, 0.7);
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
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
scene.add(hemi, sun, sun.target);
const dayNight = createDayNight({ size: SIZE, scene, hemi, sun });
dayNight.setTime(DEFAULT_TIME);

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

// ---------- Grid + derived views ----------
const grid = new VoxelGrid(SIZE, HEIGHT);
const undoStack = new UndoStack();
if (loadGrid(grid)) loadHistory(undoStack, grid);
else clearHistory();
// Terrain, submerged overlay, trees, shore map — see derived.js.
const derived = createDerivedViews({ grid, water });
const { terrain } = derived;
scene.add(derived.terrain, derived.overlay, derived.trees);

// Placement, selection, extrusion, and building undo. Orbit stays here.
const buildMode = createBuildMode({
  scene,
  camera,
  domElement: renderer.domElement,
  controls,
  terrain,
  waterMesh: water.mesh,
  snapScene,
  dragThreshold: DRAG_THRESHOLD_PX,
});

applyControlMode();

function persist() {
  saveGrid(grid);
  saveHistory(undoStack);
}

/** Apply an undo/redo entry. `towardBefore` true = undo, false = redo. */
function applyHistory(entry, towardBefore) {
  const cells = entry.cells ?? [entry];
  for (const c of cells) {
    grid.set(c.x, c.y, c.z, towardBefore ? c.before : c.after);
  }
  derived.rebuild(grid);
  persist();
  updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
}

function undo() {
  const entry = undoStack.popUndo();
  if (!entry) return;
  applyHistory(entry, true);
}

function redo() {
  const entry = undoStack.popRedo();
  if (!entry) return;
  applyHistory(entry, false);
}

/** Wipe every solid cell as one undoable step. */
function clearIsland() {
  if (paintStroke) endPaint();
  const cells = [];
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.size; z++) {
      for (let x = 0; x < grid.size; x++) {
        if (!grid.get(x, y, z)) continue;
        cells.push({ x, y, z, before: 1, after: 0 });
        grid.set(x, y, z, false);
      }
    }
  }
  if (!cells.length) return;
  undoStack.pushBatch(cells);
  derived.rebuild(grid);
  persist();
  updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
}

// ---------- Cursor: translucent disc on the picked face ----------
// Drawn without depth testing so it never sinks into the smoothed terrain and
// stays readable when the picked face is partly hidden behind a slope.
const CURSOR_ADD = new THREE.Color(0xffffff);
const CURSOR_REMOVE = new THREE.Color(0xff5a4d);

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

// Disc lies in the face plane (local XZ), facing along the local +Y normal.
const cursorDisc = new THREE.Mesh(new THREE.CircleGeometry(0.44, 48), cursorMaterial(0.3));
cursorDisc.rotation.x = -Math.PI / 2;
const cursorRing = new THREE.Mesh(new THREE.RingGeometry(0.41, 0.44, 48), cursorMaterial(0.85));
cursorRing.rotation.x = -Math.PI / 2;

cursor.add(cursorDisc, cursorRing);
for (const child of [cursorDisc, cursorRing]) child.renderOrder = 999;
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

function setCursor(base, normal, remove) {
  cursor.visible = true;
  cursor.position.set(base[0], base[1], base[2]);
  tmpNormal.set(normal[0], normal[1], normal[2]);
  cursor.quaternion.setFromUnitVectors(UP, tmpNormal);
  const col = remove ? CURSOR_REMOVE : CURSOR_ADD;
  for (const m of cursorMaterials) m.color.copy(col);
}

function updateGhost(clientX, clientY, { paint = false, remove = false } = {}) {
  if (controlMode === 'build') {
    cursor.visible = false;
    buildMode.updateHover(clientX, clientY);
    return;
  }
  buildMode.hideGhost();
  const { cell, target, normal, base } = pick(clientX, clientY);
  const showRemove = remove && cell;
  const showAdd = paint && !remove && target;
  if (!(showRemove || showAdd)) {
    cursor.visible = false;
    return;
  }
  setCursor(base, normal, showRemove);
}

// ---------- Paint: cmd/ctrl (+ shift to erase), one cell per distinct pick ----------
// Holding still does nothing after the first edit. Stacking/carving straight
// along the last face normal (spire or tunnel toward the camera) is ignored
// until the pick moves. Whole stroke = one undo.
let paintStroke = null; // { erase, cells, lx,ly,lz, lnx,lny,lnz }

function tryPaintAt(clientX, clientY) {
  if (!paintStroke) return;
  const { cell, target, normal } = pick(clientX, clientY);
  if (!normal) return;

  const { erase, lx, ly, lz, lnx, lny, lnz } = paintStroke;

  if (erase) {
    if (!cell) return;
    const [cx, cy, cz] = cell;
    const [nx, ny, nz] = normal;
    if (lx === cx && ly === cy && lz === cz) return;
    // Next solid straight inward — would tunnel without moving.
    if (
      lx !== null &&
      cx === lx - lnx &&
      cy === ly - lny &&
      cz === lz - lnz
    ) {
      return;
    }
    if (!grid.get(cx, cy, cz)) return;

    grid.set(cx, cy, cz, false);
    paintStroke.cells.push({ x: cx, y: cy, z: cz, before: 1, after: 0 });
    paintStroke.lx = cx;
    paintStroke.ly = cy;
    paintStroke.lz = cz;
    paintStroke.lnx = nx;
    paintStroke.lny = ny;
    paintStroke.lnz = nz;
  } else {
    if (!target) return;
    const [tx, ty, tz] = target;
    const [nx, ny, nz] = normal;
    if (lx === tx && ly === ty && lz === tz) return;
    // Next cell straight along the last paint normal — would spire without moving.
    if (
      lx !== null &&
      tx === lx + lnx &&
      ty === ly + lny &&
      tz === lz + lnz
    ) {
      return;
    }
    if (grid.get(tx, ty, tz)) return;

    grid.set(tx, ty, tz, true);
    paintStroke.cells.push({ x: tx, y: ty, z: tz, before: 0, after: 1 });
    paintStroke.lx = tx;
    paintStroke.ly = ty;
    paintStroke.lz = tz;
    paintStroke.lnx = nx;
    paintStroke.lny = ny;
    paintStroke.lnz = nz;
  }

  derived.rebuild(grid);
  saveGrid(grid);
}

function beginPaint(clientX, clientY, erase) {
  paintStroke = {
    erase,
    cells: [],
    lx: null,
    ly: null,
    lz: null,
    lnx: 0,
    lny: 0,
    lnz: 0,
  };
  tryPaintAt(clientX, clientY);
}

function endPaint() {
  if (!paintStroke) return;
  if (paintStroke.cells.length) undoStack.pushBatch(paintStroke.cells);
  paintStroke = null;
  saveHistory(undoStack);
}

// ---------- Input ----------
let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
// Latest modifier state from key/pointer events (keyup clears meta/ctrl reliably).
let mods = { shift: false, paintAdd: false, paintErase: false };

function syncMods(e) {
  const cmd = e.metaKey || e.ctrlKey;
  mods.shift = e.shiftKey;
  // Earth: cmd = paint add; cmd+shift = paint erase. Shift alone is orbit.
  // Tools: left/right clicks paint freely; modifiers are unused for paint.
  mods.paintAdd = controlMode === 'earth' && cmd && !e.shiftKey;
  mods.paintErase = controlMode === 'earth' && cmd && e.shiftKey;
}

function ghostOpts() {
  if (controlMode === 'build') return {};
  if (paintStroke) {
    return { paint: !paintStroke.erase, remove: paintStroke.erase };
  }
  if (controlMode === 'tools') {
    // Always preview add while navigating is idle; erase has no hover preview.
    if (toolNavAction() !== null) return {};
    return { paint: true, remove: false };
  }
  return {
    paint: mods.paintAdd,
    remove: mods.paintErase,
  };
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

/** World point under the pointer to pivot around; falls back to the water plane, then the current look-at. */
function pickOrbitPivot(clientX, clientY, out) {
  const { base } = pick(clientX, clientY);
  if (base) {
    out.set(base[0], base[1], base[2]);
  } else {
    pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
    const { origin: o, direction: d } = raycaster.ray;
    if (d.y < 0) {
      const t = (WATER_LEVEL - o.y) / d.y;
      if (t > 0) out.set(o.x + d.x * t, WATER_LEVEL, o.z + d.z * t);
      else out.copy(controls.target);
    } else {
      out.copy(controls.target);
    }
  }
  // A glance at distant water would otherwise put the pivot kilometres away and
  // make small mouse moves whip the camera. Keep it over the editable footprint.
  out.x = THREE.MathUtils.clamp(out.x, 0, SIZE);
  out.z = THREE.MathUtils.clamp(out.z, 0, SIZE);
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

// In 1-2-3 mode zoom is 2+drag only; swallow wheel/trackpad so OrbitControls
// (and the page) don't dolly. Capture so we win over OC's own listener.
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (controlMode !== 'tools') return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  { passive: false, capture: true }
);

renderer.domElement.addEventListener('pointerdown', (e) => {
  syncMods(e);
  pointerDown = { x: e.clientX, y: e.clientY };

  if (controlMode === 'build') {
    if (e.button === 0 && e.shiftKey) {
      pickOrbitPivot(e.clientX, e.clientY, orbitPivot);
      orbitArmed = true;
      orbitDragging = false;
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
    }
    return;
  }

  if (controlMode === 'tools') {
    if (toolKeys.orbit) {
      // 3 + left-drag: same cursor-pivot orbit as Earth shift-drag.
      if (e.button !== 0) return;
      pickOrbitPivot(e.clientX, e.clientY, orbitPivot);
      orbitArmed = true;
      orbitDragging = false;
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
      return;
    }
    // 1/2 + drag: OrbitControls owns the gesture (mouseButtons already set).
    if (toolNavAction() !== null) return;
    if (e.button === 0) {
      beginPaint(e.clientX, e.clientY, false);
      updateGhost(e.clientX, e.clientY, ghostOpts());
    } else if (e.button === 2) {
      beginPaint(e.clientX, e.clientY, true);
      updateGhost(e.clientX, e.clientY, ghostOpts());
    }
    return;
  }

  if (e.button === 0 && (mods.paintAdd || mods.paintErase)) {
    // Cmd/ctrl(+shift): paint stroke. Takes priority over shift-orbit.
    // OC's modifier swap would try rotate (disabled), so no pan while painting.
    beginPaint(e.clientX, e.clientY, mods.paintErase);
    updateGhost(e.clientX, e.clientY, ghostOpts());
  } else if (e.button === 0 && e.shiftKey) {
    // Shift+left (no cmd): cursor-pivot orbit.
    pickOrbitPivot(e.clientX, e.clientY, orbitPivot);
    orbitArmed = true;
    orbitDragging = false;
    orbitLastX = e.clientX;
    orbitLastY = e.clientY;
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  syncMods(e);
  lastPointer = { x: e.clientX, y: e.clientY };
  if (buildMode.pointerMove(e)) return;
  if (paintStroke) {
    const held = paintStroke.erase ? 2 : 1; // right vs left button bit
    if ((e.buttons & held) !== 0) {
      tryPaintAt(e.clientX, e.clientY);
      updateGhost(e.clientX, e.clientY, ghostOpts());
      return;
    }
  }
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
  updateGhost(e.clientX, e.clientY, ghostOpts());
});

renderer.domElement.addEventListener('pointerup', (e) => {
  syncMods(e);
  if (paintStroke && ((paintStroke.erase && e.button === 2) || (!paintStroke.erase && e.button === 0))) {
    endPaint();
  }
  if (buildMode.pointerUp(e, pointerDown)) {
    pointerDown = null;
    updateGhost(e.clientX, e.clientY, ghostOpts());
    return;
  }
  if (orbitArmed && e.button === 0) {
    orbitArmed = false;
    orbitDragging = false;
  }
  pointerDown = null;
  if (controlMode === 'tools') applyControlMode();
  updateGhost(e.clientX, e.clientY, ghostOpts());
});

// pointerleave alone is unreliable while OrbitControls has pointer capture
// (2-drag zoom): button-up outside the window may never hit the canvas
// listener, leaving LEFT stuck on DOLLY. Window-level up/cancel always ends us.
function endNavPointer() {
  const hadGesture = pointerDown || paintStroke || orbitArmed || buildMode.isDragging();
  if (paintStroke) endPaint();
  buildMode.cancel();
  orbitArmed = false;
  orbitDragging = false;
  if (!hadGesture) return;
  pointerDown = null;
  // Drop a stuck OrbitControls dolly/pan if its own pointerup was missed.
  controls.state = -1; // OrbitControls._STATE.NONE
  if (controlMode === 'tools') applyControlMode();
}

window.addEventListener('pointerup', endNavPointer);
window.addEventListener('pointercancel', endNavPointer);
renderer.domElement.addEventListener('lostpointercapture', endNavPointer);

renderer.domElement.addEventListener('pointerleave', () => {
  // Don't clear pointerDown — a captured drag still owns the gesture until
  // pointerup. Only hide the placement previews while the cursor is off the canvas.
  buildMode.hideGhost();
  cursor.visible = false;
});

function setToolKey(code, down) {
  if (code === 'Digit1' || code === 'Numpad1') toolKeys.pan = down;
  else if (code === 'Digit2' || code === 'Numpad2') toolKeys.zoom = down;
  else if (code === 'Digit3' || code === 'Numpad3') toolKeys.orbit = down;
  else return false;
  return true;
}

window.addEventListener('keydown', (e) => {
  syncMods(e);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.altKey) {
    e.preventDefault();
    if (paintStroke) return; // don't undo mid-stroke
    if (controlMode === 'build') {
      if (e.shiftKey) buildMode.redo();
      else buildMode.undo();
    } else if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (controlMode === 'tools' && !e.metaKey && !e.ctrlKey && !e.altKey && setToolKey(e.code, true)) {
    if (!e.repeat) applyControlMode();
    updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
    return;
  }
  updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
});

window.addEventListener('keyup', (e) => {
  syncMods(e);
  if (controlMode === 'tools' && setToolKey(e.code, false)) {
    applyControlMode();
  }
  updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
});

window.addEventListener('blur', () => {
  if (paintStroke) endPaint();
  mods.shift = false;
  mods.paintAdd = false;
  mods.paintErase = false;
  toolKeys.pan = false;
  toolKeys.zoom = false;
  toolKeys.orbit = false;
  orbitArmed = false;
  orbitDragging = false;
  pointerDown = null;
  buildMode.cancel();
  if (controlMode === 'tools') applyControlMode();
  buildMode.hideGhost();
  cursor.visible = false;
});

window.addEventListener('resize', () => {
  retro.setSize(window.innerWidth, window.innerHeight, camera);
});

// ---------- HUD ----------
// Labels use ⌘ on Apple platforms and Ctrl elsewhere (same as the paint/undo
// shortcuts). Stop pointer events so OrbitControls don't pan through the panel.
const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const mod = isApple ? '⌘' : 'Ctrl';
for (const el of document.querySelectorAll('[data-mod]')) el.textContent = `${mod} drag`;
for (const el of document.querySelectorAll('[data-mod-shift]')) el.textContent = `${mod}⇧ drag`;
for (const el of document.querySelectorAll('[data-mod-z]')) el.textContent = `${mod}Z`;

function setControlMode(mode) {
  if (mode !== 'earth' && mode !== 'tools' && mode !== 'build') return;
  if (paintStroke) endPaint();
  orbitArmed = false;
  orbitDragging = false;
  toolKeys.pan = false;
  toolKeys.zoom = false;
  toolKeys.orbit = false;
  controlMode = mode;
  pointerDown = null;
  applyControlMode();
  saveControlMode(mode);
  updateGhost(lastPointer.x, lastPointer.y, ghostOpts());
}

document.getElementById('mode-earth-btn').addEventListener('click', () => setControlMode('earth'));
document.getElementById('mode-tools-btn').addEventListener('click', () => setControlMode('tools'));
document.getElementById('mode-build-btn').addEventListener('click', () => setControlMode('build'));

document.getElementById('grid-btn').addEventListener('click', (e) => {
  gridHelper.visible = !gridHelper.visible;
  e.currentTarget.setAttribute('aria-pressed', String(gridHelper.visible));
});
document.getElementById('clear-btn').addEventListener('click', () => clearIsland());

const timeSlider = document.getElementById('time-slider');
timeSlider.value = String(DEFAULT_TIME);
timeSlider.addEventListener('input', () => dayNight.setTime(Number(timeSlider.value)));

// ---------- Loop ----------
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
