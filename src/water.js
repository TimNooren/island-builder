import * as THREE from 'three';
import { ISO, cellFill } from './field.js';

/**
 * Cartoon water: a flat, matte, solid-blue surface that gently swells up and
 * down, with a lighter shallow tint and a few broken ripple rings where the
 * water meets land.
 *
 * Built on MeshLambertMaterial (no specular term, so it stays matte, and we
 * keep three's shadow + fog handling) with two shader injections:
 *   - vertex: sum-of-sines height displacement + matching normal so the
 *     swells pick up a little diffuse shading;
 *   - fragment: tint / ripples driven by a "distance to shore" texture
 *     that is rebuilt from the voxel grid whenever the terrain changes.
 */

// Height of the still water surface. Level-0 cells span y ∈ [0, 1), so 0.5
// leaves them half submerged: the waterline cuts their walls and a little of
// the terrain shows through the surface before it fades into the deep.
export const WATER_LEVEL = 0.5;
// Render order of the surface: after the (opaque) terrain, before the
// terrain's submerged overlay pass. See createWater for why this matters.
const SURFACE_RENDER_ORDER = 1;

// Shore map: covers the footprint plus a margin, at SHORE_RES texels per unit.
// Distances are encoded 0..SHORE_MAX_DIST into a single byte.
const SHORE_RES = 8;
const SHORE_MARGIN = 4;
const SHORE_MAX_DIST = 4;

const DEEP = new THREE.Color(0x2f7fd0);
const SHALLOW = new THREE.Color(0x5cb0ea);
const FOAM = new THREE.Color(0xf0f8ff);
// Albedo of submerged terrain: the water's own blue, a few tints darker. The
// terrain material lights it with the same up-facing normal as the flat
// surface, so on screen it is exactly "the water, this much darker", in sun
// and in shadow alike.
export const SUBMERGED_TINT = DEEP.clone().multiplyScalar(0.75);

// The swell, shared with the terrain material so it can tell how far below
// the *moving* surface a pixel is. Both shaders take the same uniform objects,
// so one update per frame drives both.
export const WAVE_UNIFORMS = {
  uTime: { value: 0 },
  uWaveAmp: { value: 0.06 },
};
export const WAVE_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uWaveAmp;

  // Height of the surface above WATER_LEVEL at world position (x, z).
  float waveHeight(vec2 p) {
    float t = uTime;
    float h = 0.0;
    h += sin(p.x * 0.35 + t * 0.9) * 0.5;
    h += sin((p.x * 0.6 + p.y * 0.8) * 0.5 - t * 0.7) * 0.35;
    h += sin(p.y * 0.45 - p.x * 0.2 + t * 1.1) * 0.25;
    h += sin(t * 0.5) * 0.3; // slow whole-surface breathing
    return h * uWaveAmp;
  }
`;

export function createWater({ size, extent, segments = 256 }) {
  const uniforms = {
    ...WAVE_UNIFORMS,
    uShoreMap: { value: null },
    // xy = world origin of the shore map, z = 1 / world width (uv scale).
    uShoreBounds: { value: new THREE.Vector3() },
    uShoreMaxDist: { value: SHORE_MAX_DIST },
    uShallowColor: { value: SHALLOW },
    uFoamColor: { value: FOAM },
  };

  // ---- Shore distance texture ----
  const shoreOrigin = -SHORE_MARGIN;
  const shoreWorldSize = size + 2 * SHORE_MARGIN;
  const shorePx = shoreWorldSize * SHORE_RES;
  const shoreData = new Uint8Array(shorePx * shorePx).fill(255);
  const shoreMap = new THREE.DataTexture(shoreData, shorePx, shorePx, THREE.RedFormat, THREE.UnsignedByteType);
  shoreMap.magFilter = THREE.LinearFilter;
  shoreMap.minFilter = THREE.LinearFilter;
  shoreMap.wrapS = THREE.ClampToEdgeWrapping;
  shoreMap.wrapT = THREE.ClampToEdgeWrapping;
  shoreMap.needsUpdate = true;
  uniforms.uShoreMap.value = shoreMap;
  uniforms.uShoreBounds.value.set(shoreOrigin, shoreOrigin, 1 / shoreWorldSize);

  /**
   * Recompute the signed distance to the waterline for every texel.
   *
   * The terrain mesh comes from marching cubes on the field in field.js, so at
   * the water plane it crosses between cell centres at a spot set by the two
   * cells' fill values: straight runs sit near cell boundaries, an isolated
   * cell is a diamond and corners are 45° chamfers. We trace that same
   * marching-squares contour of level 0, with the same interpolation, and
   * measure distance to it (negative inside land), so the ripples follow the
   * actual mesh outline rather than the cell boxes.
   */
  function updateShore(grid) {
    // ---- 1. Marching-squares contour of level 0, bucketed per sample-quad ----
    // Quad (i, k) spans the cell centres (i+0.5, k+0.5) .. (i+1.5, k+1.5).
    const lo = shoreOrigin - 1;
    const hi = size + SHORE_MARGIN;
    const quadW = hi - lo + 1;
    const quadSegs = new Map(); // quadIndex -> flat [x0, z0, x1, z1, ...]
    const quadIndex = (i, k) => (k - lo) * quadW + (i - lo);
    const fill = (i, k) => cellFill(grid, i, 0, k);
    // Where the contour crosses the edge from sample value p to q, as a
    // fraction of the edge. Only meaningful when p and q straddle ISO.
    const crossing = (p, q) => (ISO - p) / (q - p);

    for (let k = lo; k <= hi; k++) {
      for (let i = lo; i <= hi; i++) {
        const fa = fill(i, k), fb = fill(i + 1, k), fc = fill(i + 1, k + 1), fd = fill(i, k + 1);
        const a = fa >= ISO ? 1 : 0, b = fb >= ISO ? 1 : 0, c = fc >= ISO ? 1 : 0, d = fd >= ISO ? 1 : 0;
        const caseId = a | (b << 1) | (c << 2) | (d << 3);
        if (caseId === 0 || caseId === 15) continue;
        // Corner (cell centre) positions and contour crossings on the edges
        // between them (garbage on edges without a crossing, never used).
        const A = [i + 0.5, k + 0.5], B = [i + 1.5, k + 0.5], C = [i + 1.5, k + 1.5], D = [i + 0.5, k + 1.5];
        const ab = [i + 0.5 + crossing(fa, fb), k + 0.5];
        const bc = [i + 1.5, k + 0.5 + crossing(fb, fc)];
        const cd = [i + 0.5 + crossing(fd, fc), k + 1.5];
        const da = [i + 0.5, k + 0.5 + crossing(fa, fd)];
        const segs = [];
        // Store each segment oriented so the given solid corner is on its left;
        // the sign test below relies on that.
        const seg = (p, q, solidCorner) => {
          const cross = (q[0] - p[0]) * (solidCorner[1] - p[1]) - (q[1] - p[1]) * (solidCorner[0] - p[0]);
          if (cross < 0) [p, q] = [q, p];
          segs.push(p[0], p[1], q[0], q[1]);
        };
        switch (caseId) {
          case 1: seg(da, ab, A); break;
          case 14: seg(da, ab, B); break;
          case 2: seg(ab, bc, B); break;
          case 13: seg(ab, bc, A); break;
          case 3: seg(da, bc, A); break;
          case 12: seg(da, bc, C); break;
          case 4: seg(bc, cd, C); break;
          case 11: seg(bc, cd, A); break;
          case 5: seg(da, ab, A); seg(bc, cd, C); break; // saddle: keep diagonals apart
          case 6: seg(ab, cd, B); break;
          case 9: seg(ab, cd, A); break;
          case 7: seg(cd, da, A); break;
          case 8: seg(cd, da, D); break;
          case 10: seg(ab, bc, B); seg(cd, da, D); break; // saddle
        }
        quadSegs.set(quadIndex(i, k), segs);
      }
    }

    // ---- 2. Per texel: nearest contour segment, signed by the containing cell ----
    const reach = Math.ceil(SHORE_MAX_DIST) + 1;
    for (let tz = 0; tz < shorePx; tz++) {
      const wz = shoreOrigin + (tz + 0.5) / SHORE_RES;
      const k0 = Math.floor(wz - 0.5);
      for (let tx = 0; tx < shorePx; tx++) {
        const wx = shoreOrigin + (tx + 0.5) / SHORE_RES;
        const i0 = Math.floor(wx - 0.5);
        let best = Infinity;
        for (let k = k0 - reach; k <= k0 + reach; k++) {
          for (let i = i0 - reach; i <= i0 + reach; i++) {
            if (i < lo || i > hi || k < lo || k > hi) continue;
            const segs = quadSegs.get(quadIndex(i, k));
            if (!segs) continue;
            for (let s = 0; s < segs.length; s += 4) {
              const x0 = segs[s], z0 = segs[s + 1];
              const ex = segs[s + 2] - x0, ez = segs[s + 3] - z0;
              const t = Math.min(1, Math.max(0, ((wx - x0) * ex + (wz - z0) * ez) / (ex * ex + ez * ez)));
              const dist = Math.hypot(wx - x0 - ex * t, wz - z0 - ez * t);
              if (dist < best) best = dist;
            }
          }
        }
        // Inside land iff the texel lies on the solid (left) side of a contour
        // segment in its own quad. Quads without a contour are uniform, so any
        // of their cells tells us the answer.
        const own = quadSegs.get(quadIndex(i0, k0));
        let inside = false;
        if (own) {
          for (let s = 0; s < own.length && !inside; s += 4) {
            const ex = own[s + 2] - own[s], ez = own[s + 3] - own[s + 1];
            inside = ex * (wz - own[s + 1]) - ez * (wx - own[s]) > 0;
          }
        } else {
          inside = fill(Math.floor(wx), Math.floor(wz)) >= ISO;
        }
        let d = best === Infinity ? (inside ? -1 : SHORE_MAX_DIST) : inside ? -best : best;
        d = Math.min(SHORE_MAX_DIST, Math.max(-1, d));
        shoreData[tz * shorePx + tx] = Math.round(((d + 1) / (SHORE_MAX_DIST + 1)) * 255);
      }
    }
    shoreMap.needsUpdate = true;
  }

  // ---- Material ----
  // Opaque, but it does not write depth: the terrain draws its submerged part
  // a second time afterwards (see terrainmaterial.js), and that pass has to
  // depth-test against the terrain itself, not against the surface covering
  // it. Rendering after the terrain keeps the surface on top regardless.
  const material = new THREE.MeshLambertMaterial({ color: DEEP, depthWrite: false });
  material.customProgramCacheKey = () => 'cartoon-water';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${WAVE_GLSL}
        varying vec3 vWorldPos;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        // The plane is rotated so object +Z is world +Y and object +Y is
        // world -Z; sample the swell in world XZ and map slopes back.
        vec2 waveXZ = (modelMatrix * vec4(position, 1.0)).xz;
        float waveH = waveHeight(waveXZ);
        {
          const float eps = 0.5;
          float hx = waveHeight(waveXZ + vec2(eps, 0.0));
          float hz = waveHeight(waveXZ + vec2(0.0, eps));
          // Slopes exaggerated a little so the swells read in matte shading.
          objectNormal = normalize(vec3(-(hx - waveH) / eps * 2.5, (hz - waveH) / eps * 2.5, 1.0));
        }`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.z += waveH;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform sampler2D uShoreMap;
        uniform vec3 uShoreBounds;
        uniform float uShoreMaxDist;
        uniform vec3 uShallowColor;
        uniform vec3 uFoamColor;
        varying vec3 vWorldPos;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        // Smooth 2D value noise in [0, 1], feature size ~1 unit of input.
        float valueNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 suv = (vWorldPos.xz - uShoreBounds.xy) * uShoreBounds.z;
          // Signed distance to the waterline, negative inside land.
          float d = texture2D(uShoreMap, suv).r * (uShoreMaxDist + 1.0) - 1.0;

          // Lighter, "shallow" water near land.
          float shallow = 1.0 - smoothstep(0.0, 2.5, d);
          diffuseColor.rgb = mix(diffuseColor.rgb, uShallowColor, shallow * 0.6);

          // Wobble the distance so rings aren't perfectly parallel to the coast.
          float wobble = sin(vWorldPos.x * 2.3 + uTime * 0.6) * sin(vWorldPos.z * 1.9 - uTime * 0.45);
          float dw = d + wobble * 0.08;

          // Thin ripple rings that lap in toward the shore and back out again,
          // fading with distance.
          float lap = sin(uTime * 0.6);
          float phase = dw * 11.0 + lap * 2.4;
          float ring = sin(phase);
          float rings = smoothstep(0.80, 0.92, ring) * (1.0 - smoothstep(0.3, 1.9, d));
          // Slight brightness pulse tied to the lapping motion.
          rings *= 0.65 + 0.35 * sin(uTime * 0.6 + dw * 2.0);

          // Break each ring into short, irregular dashes by gating it with a
          // world-space noise. Each ring samples the noise at its own offset so
          // the gaps of neighbouring rings are staggered rather than aligned.
          {
            float ringIndex = floor((phase - PI * 0.5) / PI2 + 0.5);
            vec2 np = vWorldPos.xz * 1.6 + ringIndex * vec2(3.7, 5.3) + uTime * 0.05;
            float n = valueNoise(np);
            rings *= smoothstep(0.46, 0.6, n);
          }

          diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, rings * 0.7);
        }`
      );
  };

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(extent, extent, segments, segments), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(size / 2, WATER_LEVEL, size / 2);
  mesh.receiveShadow = true;
  mesh.renderOrder = SURFACE_RENDER_ORDER;

  return {
    mesh,
    /** Height of the still surface. */
    level: WATER_LEVEL,
    /** Highest the swell can lift the surface (for placing things on top). */
    top: WATER_LEVEL + uniforms.uWaveAmp.value * 1.4,
    update(elapsedSeconds) {
      uniforms.uTime.value = elapsedSeconds;
    },
    updateShore,
  };
}
