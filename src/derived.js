import * as THREE from 'three';
import { buildSmoothTerrainGeometry } from './terrainmesh.js';
import { createTerrainMaterial, createSubmergedOverlay } from './terrainmaterial.js';
import { buildTreesGeometry, createTreeMaterial } from './trees.js';

/**
 * Derived views of the VoxelGrid: terrain mesh, submerged overlay, trees, and
 * the water shore map. Rebuilt in full after every edit.
 *
 * This is the only place that lists what follows from the grid. Paint, undo,
 * and clear call `rebuild(grid)` and do not know the fan-out. To tear out a
 * derived feature (e.g. trees), remove it here — not at every edit site.
 *
 * `water` is passed in rather than created here: the shore map is derived,
 * but the mesh also drives waves, picking, and the camera floor.
 */
export function createDerivedViews({ grid, water }) {
  const terrain = new THREE.Mesh(buildSmoothTerrainGeometry(grid), createTerrainMaterial());
  terrain.castShadow = true;
  terrain.receiveShadow = true;

  // Second pass: terrain just below the waterline through the opaque water
  // (see terrainmaterial.js).
  const overlay = createSubmergedOverlay(terrain);

  const trees = new THREE.Mesh(buildTreesGeometry(grid), createTreeMaterial());
  trees.castShadow = true;
  trees.receiveShadow = true;

  water.updateShore(grid);

  function rebuild(nextGrid) {
    terrain.geometry.dispose();
    terrain.geometry = buildSmoothTerrainGeometry(nextGrid);
    overlay.geometry = terrain.geometry;
    trees.geometry.dispose();
    trees.geometry = buildTreesGeometry(nextGrid);
    water.updateShore(nextGrid);
  }

  return { terrain, overlay, trees, rebuild };
}
