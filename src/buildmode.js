import * as THREE from 'three';
import {
  BuildingStore,
  createBuildingsRoot,
  syncBuildingsMeshes,
  syncSelectionOutline,
  pickBuilding,
  createBuildGhost,
  showBuildGhost,
  hideBuildGhost,
  serializeBuildings,
  validateBuildingsPayload,
  raycastPlacement,
  anchorFromHit,
} from './buildings.js';
import {
  createExtrudeGizmo,
  syncExtrudeGizmo,
  pickExtrudeHandle,
  beginExtrudeDrag,
  extrudeFromDrag,
  createRotateGizmo,
  syncRotateGizmo,
  pickRotateHandle,
  beginRotateDrag,
  yawFromDrag,
} from './buildgizmo.js';
import { loadBuildings, saveBuildings } from './storage.js';

// A short move still counts as a click. Matches the orbit-arm threshold in
// main.js so a pan that barely moves doesn't also place a cube.
const DEFAULT_DRAG_THRESHOLD_PX = 5;
const MAX_BUILDING_HISTORY = 32;
const DEFAULT_BUILD_DIMS = { sx: 1, sy: 1, sz: 1 };

/**
 * Build-mode interaction: placement, selection, face extrusion, yaw, and that
 * mode's own undo. Sculpting never imports this. main.js turns it on, forwards
 * pointer move/up and undo, and keeps camera orbit.
 *
 * The gizmo listener is registered here, in the capture phase, so it runs
 * before OrbitControls and can disable pan for that gesture. Tear-out
 * removes the listener via dispose().
 */
export function createBuildMode({
  scene,
  camera,
  domElement,
  controls,
  terrain,
  waterMesh,
  snapScene,
  dragThreshold = DEFAULT_DRAG_THRESHOLD_PX,
}) {
  const buildingStore = new BuildingStore();
  const buildingsRoot = createBuildingsRoot(buildingStore);
  scene.add(buildingsRoot);
  const buildGhost = createBuildGhost();
  scene.add(buildGhost);
  const extrudeGizmo = createExtrudeGizmo();
  extrudeGizmo.userData.isExtrudeGizmo = true;
  buildingsRoot.add(extrudeGizmo);
  snapScene(extrudeGizmo);
  const rotateGizmo = createRotateGizmo();
  rotateGizmo.userData.isRotateGizmo = true;
  buildingsRoot.add(rotateGizmo);
  snapScene(rotateGizmo);

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  /** @type {{ id: number, before: object, normal: THREE.Vector3, localNormal: THREE.Vector3, startX: number, startY: number, axisPxX: number, axisPxY: number, startBox: object } | null} */
  let extrudeDrag = null;
  /** @type {{ id: number, before: object, usePlane: boolean, startYaw: number, startX: number, startY: number } | null} */
  let rotateDrag = null;
  let active = false;
  // Preview colour for the next placement — stable until a cube is placed.
  let nextBuildColor = buildingStore.randomColor();
  /** @type {{ x: number, y: number } | null} */
  let lastHover = null;

  /** @type {{ undo: object[], redo: object[] }} */
  const history = { undo: [], redo: [] };

  const saved = loadBuildings();
  if (saved) {
    const validated = validateBuildingsPayload(saved);
    if (validated) buildingStore.restore(validated.buildings, validated.nextId);
    syncBuildingsMeshes(buildingsRoot, buildingStore, false);
    snapScene(buildingsRoot);
  }

  function persist() {
    saveBuildings(serializeBuildings(buildingStore));
  }

  function cloneBuilding(b) {
    return {
      id: b.id,
      x: b.x,
      y: b.y,
      z: b.z,
      sx: b.sx,
      sy: b.sy,
      sz: b.sz,
      yaw: b.yaw || 0,
      color: b.color,
    };
  }

  function yawNear(a, b) {
    return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-3;
  }

  function boxEqual(a, b) {
    return (
      a.x === b.x &&
      a.y === b.y &&
      a.z === b.z &&
      a.sx === b.sx &&
      a.sy === b.sy &&
      a.sz === b.sz &&
      yawNear(a.yaw || 0, b.yaw || 0)
    );
  }

  function aim(clientX, clientY) {
    pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
  }

  function syncGizmos(building) {
    const show = active && !!building;
    const viewportHeight = window.innerHeight;
    syncExtrudeGizmo(extrudeGizmo, building, show, camera, viewportHeight);
    syncRotateGizmo(rotateGizmo, building, show, camera, viewportHeight);
  }

  function syncChrome() {
    syncSelectionOutline(buildingsRoot, buildingStore, active);
    syncGizmos(active ? buildingStore.selected : null);
  }

  function rebuild() {
    syncBuildingsMeshes(buildingsRoot, buildingStore, active);
    syncGizmos(active ? buildingStore.selected : null);
    snapScene(buildingsRoot);
    persist();
    if (active && lastHover) updateHover(lastHover.x, lastHover.y);
  }

  function endGesture() {
    const drag = extrudeDrag || rotateDrag;
    if (!drag) return;
    controls.enabled = true;
    const b = buildingStore.get(drag.id);
    if (b) {
      const after = cloneBuilding(b);
      if (!boxEqual(drag.before, after)) {
        pushHistory({ type: 'box', id: b.id, before: drag.before, after });
        persist();
      }
    }
    extrudeDrag = null;
    rotateDrag = null;
  }

  function pushHistory(entry) {
    history.undo.push(entry);
    if (history.undo.length > MAX_BUILDING_HISTORY) history.undo.shift();
    history.redo.length = 0;
  }

  function applyHistory(entry, towardBefore) {
    if (entry.type === 'add') {
      if (towardBefore) buildingStore.remove(entry.building.id);
      else buildingStore.add({ ...entry.building, id: entry.building.id, color: entry.building.color });
    } else if (entry.type === 'remove') {
      if (towardBefore) buildingStore.add({ ...entry.building, id: entry.building.id, color: entry.building.color });
      else buildingStore.remove(entry.building.id);
    } else if (entry.type === 'box') {
      const b = buildingStore.get(entry.id);
      if (!b) return;
      buildingStore.setBox(entry.id, towardBefore ? entry.before : entry.after);
    } else if (entry.type === 'dims') {
      const b = buildingStore.get(entry.id);
      if (!b) return;
      const d = towardBefore ? entry.before : entry.after;
      buildingStore.setDimensions(entry.id, d.sx, d.sy, d.sz);
    }
    rebuild();
  }

  function placeBuilding(x, y, z) {
    const building = buildingStore.add({ x, y, z, color: nextBuildColor });
    pushHistory({ type: 'add', building: cloneBuilding(building) });
    nextBuildColor = buildingStore.randomColor();
    // Select before the mesh sync so the new cube shows its handles immediately.
    buildingStore.select(building.id);
    rebuild();
  }

  function deleteBuilding(id) {
    const b = buildingStore.get(id);
    if (!b) return;
    pushHistory({ type: 'remove', building: cloneBuilding(b) });
    buildingStore.remove(id);
    rebuild();
  }

  /** World-space min corner for a new cube on the raycast surface, or null. */
  function buildingPlacement(clientX, clientY) {
    aim(clientX, clientY);
    if (pickBuilding(raycaster, buildingsRoot) != null) return null;
    const hit = raycastPlacement(raycaster, [terrain, waterMesh]);
    if (!hit) return null;
    const { sx, sy, sz } = DEFAULT_BUILD_DIMS;
    return anchorFromHit(hit.point, hit.normal, sx, sy, sz);
  }

  function updateHover(clientX, clientY) {
    lastHover = { x: clientX, y: clientY };
    if (!active) {
      hideBuildGhost(buildGhost);
      return;
    }
    aim(clientX, clientY);
    if (
      pickBuilding(raycaster, buildingsRoot) != null ||
      pickExtrudeHandle(raycaster, extrudeGizmo) ||
      pickRotateHandle(raycaster, rotateGizmo)
    ) {
      hideBuildGhost(buildGhost);
      return;
    }
    const place = buildingPlacement(clientX, clientY);
    if (!place) {
      hideBuildGhost(buildGhost);
      return;
    }
    const { sx, sy, sz } = DEFAULT_BUILD_DIMS;
    showBuildGhost(buildGhost, place.x, place.y, place.z, sx, sy, sz, nextBuildColor);
  }

  function hideGhost() {
    hideBuildGhost(buildGhost);
  }

  // Capture phase: OrbitControls listens on bubble and would start a pan on
  // the same click. Disabling controls here, before that listener, keeps the
  // handle drag from also moving the camera. The gizmos are tested on their
  // own, so a block between the camera and an arrow doesn't steal the click.
  function onPointerDownCapture(e) {
    if (!active || e.button !== 0 || e.shiftKey || !buildingStore.selected) return;
    aim(e.clientX, e.clientY);
    const extrudeHit = pickExtrudeHandle(raycaster, extrudeGizmo);
    const rotateHit = pickRotateHandle(raycaster, rotateGizmo);
    const sel = buildingStore.selected;
    const rotate =
      rotateHit && (!extrudeHit || rotateHit.distance <= extrudeHit.distance);
    if (rotate) {
      const drag = beginRotateDrag(e.clientX, e.clientY, raycaster, rotateHit.point, sel, camera, window);
      rotateDrag = { id: sel.id, before: cloneBuilding(sel), ...drag };
    } else if (extrudeHit) {
      const drag = beginExtrudeDrag(e.clientX, e.clientY, extrudeHit, cloneBuilding(sel), camera, window);
      if (!drag) return;
      extrudeDrag = { id: sel.id, before: cloneBuilding(sel), ...drag };
    } else {
      return;
    }
    controls.enabled = false;
    try {
      domElement.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture unavailable in some environments.
    }
    e.preventDefault();
    e.stopPropagation();
  }

  domElement.addEventListener('pointerdown', onPointerDownCapture, { capture: true });

  function pointerMove(e) {
    if ((e.buttons & 1) === 0 || (!extrudeDrag && !rotateDrag)) return false;
    if (extrudeDrag) {
      const next = extrudeFromDrag(extrudeDrag, e.clientX, e.clientY);
      if (next) {
        buildingStore.setBox(extrudeDrag.id, next);
        syncBuildingsMeshes(buildingsRoot, buildingStore, true);
        syncGizmos(buildingStore.get(extrudeDrag.id));
        snapScene(buildingsRoot);
      }
    } else {
      aim(e.clientX, e.clientY);
      const yaw = yawFromDrag(rotateDrag, e.clientX, e.clientY, raycaster);
      if (yaw != null) {
        buildingStore.setYaw(rotateDrag.id, yaw);
        syncBuildingsMeshes(buildingsRoot, buildingStore, true);
        syncGizmos(buildingStore.get(rotateDrag.id));
        snapScene(buildingsRoot);
      }
    }
    hideGhost();
    return true;
  }

  /**
   * End an extrude or rotate or, on a click, place / select / delete.
   * Returns true when a gizmo gesture consumed the event so the caller
   * skips orbit cleanup. Clicks return false; orbit cleanup still runs.
   * @param {{ x: number, y: number } | null} pointerDown
   */
  function pointerUp(e, pointerDown) {
    if ((extrudeDrag || rotateDrag) && e.button === 0) {
      endGesture();
      return true;
    }
    if (!active || !pointerDown) return false;
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    const click = Math.hypot(dx, dy) <= dragThreshold;
    if (click && e.button === 0 && !e.shiftKey) {
      aim(e.clientX, e.clientY);
      const hitId = pickBuilding(raycaster, buildingsRoot);
      if (hitId != null) {
        buildingStore.select(hitId);
        syncChrome();
        snapScene(buildingsRoot);
      } else {
        buildingStore.clearSelection();
        syncChrome();
        const place = buildingPlacement(e.clientX, e.clientY);
        if (place) placeBuilding(place.x, place.y, place.z);
      }
    } else if (click && e.button === 2) {
      aim(e.clientX, e.clientY);
      const hitId = pickBuilding(raycaster, buildingsRoot);
      if (hitId != null) deleteBuilding(hitId);
      else if (buildingStore.selectedId != null) deleteBuilding(buildingStore.selectedId);
    }
    return false;
  }

  function undo() {
    const entry = history.undo.pop();
    if (!entry) return;
    history.redo.push(entry);
    applyHistory(entry, true);
  }

  function redo() {
    const entry = history.redo.pop();
    if (!entry) return;
    history.undo.push(entry);
    applyHistory(entry, false);
  }

  function setActive(on) {
    if (!on && (extrudeDrag || rotateDrag)) endGesture();
    active = on;
    syncChrome();
    if (!on) hideGhost();
  }

  function cancel() {
    endGesture();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    domElement.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
    cancel();
    hideGhost();
    scene.remove(buildingsRoot);
    scene.remove(buildGhost);
    disposeObject(buildingsRoot);
    disposeObject(buildGhost);
  }

  return {
    setActive,
    pointerMove,
    pointerUp,
    undo,
    redo,
    cancel,
    hideGhost,
    updateHover,
    isActive: () => active,
    isDragging: () => extrudeDrag != null || rotateDrag != null,
    // Camera distance changes the world size of the handles. Call each frame.
    updateFrame() {
      if (!active || !buildingStore.selected) return;
      syncGizmos(buildingStore.selected);
    },
    dispose,
  };
}

function disposeObject(object) {
  const seen = new Set();
  object.traverse((child) => {
    if (child.geometry && !seen.has(child.geometry)) {
      seen.add(child.geometry);
      child.geometry.dispose?.();
    }
    const materials = child.material == null ? [] : Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      material.dispose?.();
    }
  });
}
