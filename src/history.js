/**
 * Bounded undo/redo of voxel edits. An entry is either a single cell
 * `{x,y,z,before,after}` or a batch `{cells:[...]}` for one gesture (e.g. an
 * extrude drag). Either direction restores from the recorded before/after.
 * A fresh edit clears the redo branch (standard linear history).
 *
 * Depth is kept small so the stacks are cheap to persist in localStorage.
 */

export const MAX_HISTORY = 32;

export class UndoStack {
  constructor(max = MAX_HISTORY) {
    this.max = max;
    this.undo = [];
    this.redo = [];
  }

  get canUndo() {
    return this.undo.length > 0;
  }

  get canRedo() {
    return this.redo.length > 0;
  }

  /** Record a single-cell edit; drops any redo branch. */
  push(x, y, z, before, after) {
    this._pushEntry({
      x,
      y,
      z,
      before: before ? 1 : 0,
      after: after ? 1 : 0,
    });
  }

  /** Record several cell edits as one undo step (e.g. an extrude gesture). */
  pushBatch(cells) {
    if (!cells.length) return;
    this._pushEntry({
      cells: cells.map((c) => ({
        x: c.x,
        y: c.y,
        z: c.z,
        before: c.before ? 1 : 0,
        after: c.after ? 1 : 0,
      })),
    });
  }

  _pushEntry(entry) {
    this.undo.push(entry);
    if (this.undo.length > this.max) this.undo.shift();
    this.redo.length = 0;
  }

  popUndo() {
    const entry = this.undo.pop() ?? null;
    if (entry) {
      this.redo.push(entry);
      if (this.redo.length > this.max) this.redo.shift();
    }
    return entry;
  }

  popRedo() {
    const entry = this.redo.pop() ?? null;
    if (entry) {
      this.undo.push(entry);
      if (this.undo.length > this.max) this.undo.shift();
    }
    return entry;
  }

  /** Replace stacks from a previously saved snapshot (already validated). */
  restore(undo, redo) {
    this.undo = undo.slice(-this.max);
    this.redo = redo.slice(-this.max);
  }

  clear() {
    this.undo.length = 0;
    this.redo.length = 0;
  }
}
