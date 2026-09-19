import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelGrid } from './voxels.js';
import { buildSmoothTerrainGeometry } from './terrainmesh.js';
import { createTerrainMaterial, createSubmergedOverlay } from './terrainmaterial.js';
import { createWater, WATER_LEVEL } from './water.js';
import { loadGrid, saveGrid, loadCamera, saveCamera } from './storage.js';
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

// Google-Earth-ish: left drag pans along the ground, right drag orbits, wheel zooms.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(SIZE / 2, WATER_LEVEL, SIZE / 2);
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
controls.screenSpacePanning = false;
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.minDistance = 4;
controls.maxDistance = SIZE * 4;
controls.maxPolarAngle = Math.PI / 2 - 0.05;
loadCamera(camera, controls);
// Panning only moves the target horizontally, so keeping it on the water
// plane (also for poses saved before the level changed) together with the
// polar limit guarantees the camera never dips under the surface.
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
loadGrid(grid);
const terrainMaterial = createTerrainMaterial();
let terrain = new THREE.Mesh(buildSmoothTerrainGeometry(grid), terrainMaterial);
terrain.castShadow = true;
terrain.receiveShadow = true;
scene.add(terrain);
// Second pass that shows the terrain just below the waterline through the
// opaque water (see terrainmaterial.js).
const terrainOverlay = createSubmergedOverlay(terrain);
scene.add(terrainOverlay);

function rebuildTerrain() {
  terrain.geometry.dispose();
  terrain.geometry = buildSmoothTerrainGeometry(grid);
  terrainOverlay.geometry = terrain.geometry;
  water.updateShore(grid);
  statsEl.textContent = `${grid.count()} blocks · ${SIZE}×${SIZE}×${HEIGHT}`;
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
const statsEl = document.getElementById('stats');
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

function updateGhost(clientX, clientY, rightButtonDown) {
  const { cell, target, normal, base } = pick(clientX, clientY);
  const showRemove = rightButtonDown && cell;
  if (!(showRemove || target)) {
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

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDown = { x: e.clientX, y: e.clientY, button: e.button };
});

renderer.domElement.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  updateGhost(e.clientX, e.clientY, (e.buttons & 2) !== 0);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDown || pointerDown.button !== e.button) {
    pointerDown = null;
    return;
  }
  const dx = e.clientX - pointerDown.x;
  const dy = e.clientY - pointerDown.y;
  pointerDown = null;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) return; // it was a drag, not a click

  const { cell, target } = pick(e.clientX, e.clientY);
  if (e.button === 0 && target) {
    grid.set(...target, true);
    rebuildTerrain();
    saveGrid(grid);
  } else if (e.button === 2 && cell) {
    grid.set(...cell, false);
    rebuildTerrain();
    saveGrid(grid);
  }
  updateGhost(e.clientX, e.clientY, false);
});

renderer.domElement.addEventListener('pointerleave', () => {
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
