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
} from './buildgizmo.js';
import { loadBuildings, saveBuildings } from './storage.js';

// A short move still counts as a click. Matches the orbit-arm threshold in
// main.js so a pan that barely moves doesn't also place a cube.
const DEFAULT_DRAG_THRESHOLD_PX = 5;
const MAX_BUILDING_HISTORY = 32;
const DEFAULT_BUILD_DIMS = { sx: 1, sy: 1, sz: 1 };

/**
 * Build-mode interaction: placement, selection, face extrusion, and that
 * mode's own undo. Sculpting never imports this. main.js turns it on, forwards
 * pointer move/up and undo, and keeps camera orbit.
 *
 * The extrude handle listener is registered here, in the capture phase, so it
 * runs before OrbitControls and can disable pan for that gesture. Tear-out
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

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();

  /** @type {{ id: number, before: object, normal: THREE.Vector3, startX: number, startY: number, axisPxX: number, axisPxY: number, startBox: object } | null} */
  let extrudeDrag = null;
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
    return { id: b.id, x: b.x, y: b.y, z: b.z, sx: b.sx, sy: b.sy, sz: b.sz, color: b.color };
  }

  function boxEqual(a, b) {
    return (
      a.x === b.x &&
      a.y === b.y &&
      a.z === b.z &&
      a.sx === b.sx &&
      a.sy === b.sy &&
      a.sz === b.sz
    );
  }

  function aim(clientX, clientY) {
    pointerNdc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointerNdc, camera);
  }

  function syncChrome() {
    syncSelectionOutline(buildingsRoot, buildingStore, active);
    syncExtrudeGizmo(extrudeGizmo, active ? buildingStore.selected : null, active);
  }

  function rebuild() {
    syncBuildingsMeshes(buildingsRoot, buildingStore, active);
    syncExtrudeGizmo(extrudeGizmo, active ? buildingStore.selected : null, active);
    snapScene(buildingsRoot);
    persist();
    if (active && lastHover) updateHover(lastHover.x, lastHover.y);
  }

  function endExtrudeDrag() {
    if (!extrudeDrag) return;
    controls.enabled = true;
    const b = buildingStore.get(extrudeDrag.id);
    if (b) {
      const after = cloneBuilding(b);
      if (!boxEqual(extrudeDrag.before, after)) {
        pushHistory({ type: 'box', id: b.id, before: extrudeDrag.before, after });
        persist();
      }
    }
    extrudeDrag = null;
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
    if (pickBuilding(raycaster, buildingsRoot) != null) {
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
  // handle drag from also moving the camera.
  function onPointerDownCapture(e) {
    if (!active || e.button !== 0 || e.shiftKey || !buildingStore.selected) return;
    aim(e.clientX, e.clientY);
    const handle = pickExtrudeHandle(raycaster, extrudeGizmo);
    if (!handle) return;
    const sel = buildingStore.selected;
    const drag = beginExtrudeDrag(e.clientX, e.clientY, handle, cloneBuilding(sel), camera, window);
    if (!drag) return;
    extrudeDrag = { id: sel.id, before: cloneBuilding(sel), ...drag };
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
    if (!extrudeDrag || (e.buttons & 1) === 0) return false;
    const next = extrudeFromDrag(extrudeDrag, e.clientX, e.clientY);
    if (next) {
      buildingStore.setBox(extrudeDrag.id, next);
      syncBuildingsMeshes(buildingsRoot, buildingStore, true);
      syncExtrudeGizmo(extrudeGizmo, buildingStore.get(extrudeDrag.id), true);
      snapScene(buildingsRoot);
    }
    hideGhost();
    return true;
  }

  /**
   * End an extrude or, on a click, place / select / delete.
   * Returns true when the extrude gesture consumed the event so the caller
   * skips orbit cleanup. Clicks return false; orbit cleanup still runs.
   * @param {{ x: number, y: number } | null} pointerDown
   */
  function pointerUp(e, pointerDown) {
    if (extrudeDrag && e.button === 0) {
      endExtrudeDrag();
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
    if (!on && extrudeDrag) endExtrudeDrag();
    active = on;
    syncChrome();
    if (!on) hideGhost();
  }

  function cancel() {
    endExtrudeDrag();
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
    isDragging: () => extrudeDrag != null,
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
