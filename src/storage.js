/**
 * Persist the voxel grid, edit history, and camera pose in localStorage so an
 * island (and the view of it) survives a page refresh.
 *
 * Cells are stored run-length encoded as alternating empty/solid run lengths.
 * A 32×32×24 grid is ~25k cells but mostly empty (and what isn't is clumpy),
 * so runs are a few hundred numbers instead of a 25k-char string, which keeps
 * the write after every click negligible. Undo/redo is a short list of
 * single-cell before/after records saved alongside.
 */

const STORAGE_KEY = 'island-builder:grid';
const CAMERA_KEY = 'island-builder:camera';
const HISTORY_KEY = 'island-builder:history';
const FORMAT_VERSION = 1;

function encodeRuns(data) {
  const runs = [];
  let value = 0;
  let run = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ? 1 : 0;
    if (v === value) {
      run++;
    } else {
      runs.push(run);
      value = v;
      run = 1;
    }
  }
  runs.push(run);
  return runs;
}

function decodeRuns(runs, out) {
  let i = 0;
  let value = 0;
  for (const run of runs) {
    if (!Number.isInteger(run) || run < 0 || i + run > out.length) return false;
    if (value) out.fill(1, i, i + run);
    i += run;
    value ^= 1;
  }
  return i === out.length;
}

export function saveGrid(grid) {
  try {
    const payload = {
      v: FORMAT_VERSION,
      size: grid.size,
      height: grid.height,
      runs: encodeRuns(grid.data),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private mode / quota exceeded / storage disabled: the toy still works,
    // it just won't remember this session.
  }
}

/**
 * Fill `grid` from storage. Returns true if something was restored. Anything
 * unreadable or of a different grid size is ignored so the app always starts.
 */
export function loadGrid(grid) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (
      !payload ||
      payload.v !== FORMAT_VERSION ||
      payload.size !== grid.size ||
      payload.height !== grid.height ||
      !Array.isArray(payload.runs)
    ) {
      return false;
    }
    const cells = new Uint8Array(grid.data.length);
    if (!decodeRuns(payload.runs, cells)) return false;
    grid.data.set(cells);
    return true;
  } catch {
    return false;
  }
}

function isHistoryEntry(e, grid) {
  return (
    e &&
    Number.isInteger(e.x) &&
    Number.isInteger(e.y) &&
    Number.isInteger(e.z) &&
    grid.inBounds(e.x, e.y, e.z) &&
    (e.before === 0 || e.before === 1) &&
    (e.after === 0 || e.after === 1)
  );
}

/** Persist undo/redo stacks alongside the grid. */
export function saveHistory(stack) {
  try {
    const payload = {
      v: FORMAT_VERSION,
      undo: stack.undo,
      redo: stack.redo,
    };
    localStorage.setItem(HISTORY_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable; see saveGrid.
  }
}

/**
 * Restore undo/redo into `stack`. Returns true if applied. Invalid or
 * out-of-bounds entries are rejected as a whole so we never half-restore.
 */
export function loadHistory(stack, grid) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (
      !payload ||
      payload.v !== FORMAT_VERSION ||
      !Array.isArray(payload.undo) ||
      !Array.isArray(payload.redo)
    ) {
      return false;
    }
    if (
      !payload.undo.every((e) => isHistoryEntry(e, grid)) ||
      !payload.redo.every((e) => isHistoryEntry(e, grid))
    ) {
      return false;
    }
    stack.restore(payload.undo, payload.redo);
    return true;
  } catch {
    return false;
  }
}

/** Drop persisted history (e.g. when the grid itself couldn't be restored). */
export function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage unavailable; see saveGrid.
  }
}

/** Save the camera position and the orbit target it looks at. */
export function saveCamera(camera, controls) {
  try {
    const payload = {
      v: FORMAT_VERSION,
      position: camera.position.toArray(),
      target: controls.target.toArray(),
    };
    localStorage.setItem(CAMERA_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable; see saveGrid.
  }
}

/**
 * Restore camera position and orbit target. Returns true if applied. The
 * caller should `controls.update()` afterwards so distance/angle limits are
 * re-clamped against the restored pose.
 */
export function loadCamera(camera, controls) {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if (!payload || payload.v !== FORMAT_VERSION || !isVec3(payload.position) || !isVec3(payload.target)) {
      return false;
    }
    camera.position.fromArray(payload.position);
    controls.target.fromArray(payload.target);
    return true;
  } catch {
    return false;
  }
}
