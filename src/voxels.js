/**
 * A 3D grid of solid/empty cells. `size` is the footprint (x and z),
 * `height` is the number of vertical levels. Level 0 sits on the water.
 */
export class VoxelGrid {
  constructor(size, height) {
    this.size = size;
    this.height = height;
    this.data = new Uint8Array(size * size * height);
  }

  index(x, y, z) {
    return (y * this.size + z) * this.size + x;
  }

  inBounds(x, y, z) {
    return x >= 0 && x < this.size && z >= 0 && z < this.size && y >= 0 && y < this.height;
  }

  get(x, y, z) {
    return this.inBounds(x, y, z) ? this.data[this.index(x, y, z)] : 0;
  }

  set(x, y, z, solid) {
    if (!this.inBounds(x, y, z)) return false;
    this.data[this.index(x, y, z)] = solid ? 1 : 0;
    return true;
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) n += this.data[i];
    return n;
  }

  /**
   * March a ray through the grid (Amanatides–Woo), treating every solid cell
   * as a full unit cube. This ignores the smoothed render mesh, so thin
   * features like a one-cell spire keep their full 1×1×1 hit box.
   *
   * Returns null if the ray misses the grid volume entirely, otherwise:
   *   cell   – first solid cell hit, or null if only empty cells were crossed
   *   prev   – the empty cell the ray was in just before `cell` (or before
   *            leaving the grid); null if the ray came straight in from outside
   *   normal – outward unit normal of the face crossed to reach `cell` (or the
   *            grid face the ray exited through). Zero if the ray started
   *            inside a solid cell.
   */
  raycast(ox, oy, oz, dx, dy, dz) {
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];
    const hi = [this.size, this.height, this.size];

    // Clip the ray to the grid's bounding box.
    let tEnter = 0;
    let tExit = Infinity;
    let enterAxis = -1;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < 0 || o[a] >= hi[a]) return null;
        continue;
      }
      let t0 = -o[a] / d[a];
      let t1 = (hi[a] - o[a]) / d[a];
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tEnter) { tEnter = t0; enterAxis = a; }
      if (t1 < tExit) tExit = t1;
      if (tEnter > tExit) return null;
    }

    // Starting cell, snapped onto the entry face to dodge float error.
    const c = [0, 1, 2].map((a) => Math.min(hi[a] - 1, Math.max(0, Math.floor(o[a] + d[a] * tEnter))));
    if (enterAxis >= 0) c[enterAxis] = d[enterAxis] > 0 ? 0 : hi[enterAxis] - 1;

    const step = d.map(Math.sign);
    const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v)));
    const tMax = [0, 1, 2].map((a) =>
      d[a] === 0 ? Infinity : ((step[a] > 0 ? c[a] + 1 : c[a]) - o[a]) / d[a]
    );

    let lastAxis = enterAxis;
    let prev = null;
    const maxSteps = this.size * 2 + this.height + 3;
    for (let i = 0; i < maxSteps; i++) {
      const normal = [0, 0, 0];
      if (lastAxis >= 0) normal[lastAxis] = -step[lastAxis];

      if (this.get(c[0], c[1], c[2])) return { cell: [...c], prev, normal };

      prev = [...c];
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
      c[a] += step[a];
      tMax[a] += tDelta[a];
      lastAxis = a;
      if (!this.inBounds(c[0], c[1], c[2])) {
        const exitNormal = [0, 0, 0];
        exitNormal[a] = -step[a];
        return { cell: null, prev, normal: exitNormal };
      }
    }
    return null;
  }
}
