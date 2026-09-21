import * as THREE from 'three';
import { WATER_LEVEL, SUBMERGED_TINT, WAVE_GLSL, WAVE_UNIFORMS } from './water.js';

/**
 * Terrain material: MeshStandardMaterial with a small shader injection that
 * decides *where grass is* per pixel.
 *
 * The bake in terrainmesh.js only knows one vertex per cell on flat ground,
 * so anything it encodes in vertex colours is smeared across a whole cell by
 * interpolation. That is fine for the ground underneath (sand → rock), which
 * should be soft anyway, but grass wants a crisp, slightly wobbly border and
 * texture finer than a cell. So the geometry carries two colours per vertex:
 *
 *   color       what the ground looks like without grass (sand / wet sand / rock)
 *   grassColor  the patchwork green from the Worley bake
 *
 * and the fragment shader picks between them from world height and world
 * normal, with a noise-perturbed threshold, antialiased with fwidth(). A dark
 * band just outside the border and a light lip just inside fake the thickness
 * of a turf layer without any extra geometry.
 *
 * Underwater: the sea surface is opaque, so to show a hint of what is just
 * below it the terrain is drawn twice. Anything under the (moving) surface is
 * painted one flat colour, SUBMERGED_TINT, and lit with an up-facing normal
 * so it shades like the water surface itself rather than like a wall. The
 * normal pass does this too, but is covered by the water; a second pass with
 * `submergedOverlay: true` renders only the submerged part again, after the
 * surface, with alpha fading out over the first third of a unit of depth.
 * The surface does not write depth, so this overlay depth-tests against the
 * terrain's own first pass: it is hidden by terrain in front of it, never by
 * the water. Result: a band of slightly darker water where a wall goes under,
 * without a depth pre-pass or a translucent sea. Ground colour and lighting
 * are deliberately not involved: blending a lit warm colour into blue passes
 * through muddy greys, which read as a dark rim.
 */

// World height at which beach turns into grass, and how far the border is
// allowed to wander up/down. Wobble larger than ~0.5 starts to bite into the
// tops of level-1 cells and looks like leprosy rather than a coastline.
export const GRASS_EDGE_HEIGHT = 1.6;
const GRASS_EDGE_WOBBLE = 0.3;
// Minimum normal.y (cosine of slope) that still holds grass, and its wobble.
// 0.55 keeps the 45° Marching Cubes bevels (0.71) grassy while the rounded
// tops of taller walls flip to rock partway round the curve.
export const GRASS_EDGE_SLOPE = 0.55;
const GRASS_SLOPE_WOBBLE = 0.12;
// Converts the slope term into roughly world units so one rim width serves
// both kinds of border.
const SLOPE_TO_WORLD = 2.0;
// Border wobble wavelength ≈ 1 / EDGE_NOISE_FREQ world units.
const EDGE_NOISE_FREQ = 0.7;
// The procedural grass texture and the border wobble are sampled on a grid of
// this many texels per world unit, so they look like a small hand-painted
// texture stretched over the polygons (PS1 textures were 32–64 px across a
// tile) rather than smooth per-pixel noise. Higher is finer and eventually
// indistinguishable from smooth; 4 is visibly blocky at the default zoom.
const TEXELS_PER_UNIT = 8;
// How far lighting follows the smoothed vertex normal instead of the
// triangle's flat normal. 0 is a hard shade per facet (the low-poly read);
// 1 lets the light follow the rounded mesh. The silhouette is unchanged.
// Trees use the same mix via SOFTEN_FACETS_GLSL.
const FACET_SOFTNESS = 0.75;
// Grass texture: brightness swing of the noise, in fraction of colour. The
// texel look needs a bit more contrast than smooth noise did to register.
const GRASS_TEX_STRENGTH = 0.34;
// Fake turf thickness: width of the rim in world units, how much the ground
// just outside darkens, how much the grass just inside lightens.
const RIM_WIDTH = 0.18;
const RIM_DARK = 0.35;
const LIP_LIGHT = 0.14;
// Depth below the surface at which submerged ground has fully faded into the
// water. Level-0 walls are 0.5 deep, so this must stay below that or their
// bottom edge would show; much under ~0.3 shrinks the band to an outline.
const UNDERWATER_VISIBILITY = 0.35;
// The overlay is drawn after the water surface (renderOrder 1 in water.js).
const OVERLAY_RENDER_ORDER = 2;

const glslConst = (name, value) => `const float ${name} = ${value.toFixed(4)};`;
const glslColor = (name, c) => `const vec3 ${name} = vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)});`;

const VERTEX_PARS = /* glsl */ `
attribute vec3 grassColor;
varying vec3 vGrassColor;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
`;

const VERTEX_BODY = /* glsl */ `
vGrassColor = grassColor;
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vGrassColor;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
${glslConst('GRASS_EDGE_HEIGHT', GRASS_EDGE_HEIGHT)}
${glslConst('GRASS_EDGE_WOBBLE', GRASS_EDGE_WOBBLE)}
${glslConst('GRASS_EDGE_SLOPE', GRASS_EDGE_SLOPE)}
${glslConst('GRASS_SLOPE_WOBBLE', GRASS_SLOPE_WOBBLE)}
${glslConst('SLOPE_TO_WORLD', SLOPE_TO_WORLD)}
${glslConst('EDGE_NOISE_FREQ', EDGE_NOISE_FREQ)}
${glslConst('TEXELS_PER_UNIT', TEXELS_PER_UNIT)}
${glslConst('GRASS_TEX_STRENGTH', GRASS_TEX_STRENGTH)}
${glslConst('RIM_WIDTH', RIM_WIDTH)}
${glslConst('RIM_DARK', RIM_DARK)}
${glslConst('LIP_LIGHT', LIP_LIGHT)}
${glslConst('WATER_LEVEL', WATER_LEVEL)}
${glslConst('UNDERWATER_VISIBILITY', UNDERWATER_VISIBILITY)}
${glslColor('SUBMERGED_TINT', SUBMERGED_TINT)}
${WAVE_GLSL}
// 1 below the water surface, 0 above; set in the colour block, read when
// lighting. Plain float, not a varying, despite the name convention.
float gSubmerged = 0.0;

float tHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float tNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x),
    mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}
`;

const FRAGMENT_BODY = /* glsl */ `
{
  vec2 pxz = vWorldPos.xz;
  // Texture lookups use the texel-snapped position; anything that has to
  // line up with geometry or the water keeps the exact one.
  vec2 txz = (floor(pxz * TEXELS_PER_UNIT) + 0.5) / TEXELS_PER_UNIT;

  // Signed "distance" to the grass border, positive inside grass. Height and
  // slope each give one; the border is wherever the nearer one crosses zero.
  float wobble = tNoise(txz * EDGE_NOISE_FREQ) - 0.5;
  float dHeight = vWorldPos.y - (GRASS_EDGE_HEIGHT + wobble * 2.0 * GRASS_EDGE_WOBBLE);
  float dSlope = (vWorldNormal.y - (GRASS_EDGE_SLOPE + wobble * 2.0 * GRASS_SLOPE_WOBBLE)) * SLOPE_TO_WORLD;
  float d = min(dHeight, dSlope);
  float aa = fwidth(d);
  float grassMask = smoothstep(-aa, aa, d);

  // Grass texture: a coarse clumpy octave, a fine one, and a faint streaky
  // octave so flat lawns read as blades rather than sandpaper. Frequencies
  // stay under TEXELS_PER_UNIT / 2 so each noise cell spans several texels;
  // at the texel rate itself the value noise degenerates into white speckle.
  float tex = tNoise(txz * 2.0) * 0.5
            + tNoise(txz * 4.0) * 0.3
            + tNoise(vec2(txz.x * 4.0, txz.y * 1.5)) * 0.2
            - 0.5;
  vec3 grass = vGrassColor * (1.0 + tex * GRASS_TEX_STRENGTH);

  // Fake turf thickness: ground just outside the border sits in its shadow,
  // grass just inside is the lit top edge of the lip.
  float outside = (1.0 - smoothstep(0.0, RIM_WIDTH, -d)) * (1.0 - grassMask);
  float inside = (1.0 - smoothstep(0.0, RIM_WIDTH * 0.6, d)) * grassMask;
  vec3 ground = vColor * (1.0 - RIM_DARK * outside);
  grass *= 1.0 + LIP_LIGHT * inside;

  diffuseColor.rgb *= mix(ground, grass, grassMask);

  // Below the moving surface: one flat colour, switched as a hard step (the
  // water edge itself hides the transition, so no antialiasing is needed and
  // a soft step would only leak a faint line onto the sand above it). The
  // overlay pass additionally fades out with depth.
  float depth = WATER_LEVEL + waveHeight(pxz) - vWorldPos.y;
  gSubmerged = step(0.0, depth);
  diffuseColor.rgb = mix(diffuseColor.rgb, SUBMERGED_TINT, gSubmerged);
#ifdef SUBMERGED_OVERLAY
  if (depth <= 0.0) discard;
  diffuseColor.a = 1.0 - smoothstep(0.0, UNDERWATER_VISIBILITY, depth);
#endif
}
`;

// Blend the flat face normal toward the interpolated one. The derivative
// normal can come out flipped relative to the vertex normal on some windings;
// the dot product puts them in the same hemisphere before the mix.
export const SOFTEN_FACETS_GLSL = /* glsl */ `
{
  vec3 facetNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  if (dot(facetNormal, normal) < 0.0) facetNormal = -facetNormal;
  normal = normalize(mix(facetNormal, normal, ${FACET_SOFTNESS.toFixed(4)}));
}
`;

// Submerged pixels are lit as if they faced straight up, like the surface.
// Runs after three has derived the view-space normal, before lighting.
const FRAGMENT_NORMAL = /* glsl */ `
#include <normal_fragment_begin>
${SOFTEN_FACETS_GLSL}
normal = mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), gSubmerged);
`;

/**
 * @param {{ submergedOverlay?: boolean }} [options]
 *   submergedOverlay – build the see-through-the-water pass described above
 *   instead of the normal opaque terrain material.
 */
export function createTerrainMaterial({ submergedOverlay = false } = {}) {
  // Smooth vertex normals (flatShading stays off) so SOFTEN_FACETS_GLSL can
  // mix them with the per-triangle normal. The grass slope test uses the
  // smooth object normal from the vertex shader, not this lighting normal.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  if (submergedOverlay) {
    material.transparent = true;
    material.depthWrite = false;
    material.defines = { SUBMERGED_OVERLAY: '' };
  }
  material.customProgramCacheKey = () => (submergedOverlay ? 'terrain-overlay' : 'terrain');
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WAVE_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', FRAGMENT_BODY)
      .replace('#include <normal_fragment_begin>', FRAGMENT_NORMAL);
  };
  return material;
}

/**
 * The second, submerged-only draw of a terrain mesh. Shares the geometry, so
 * the caller only has to keep `geometry` in sync after rebuilds.
 */
export function createSubmergedOverlay(terrain) {
  const overlay = new THREE.Mesh(terrain.geometry, createTerrainMaterial({ submergedOverlay: true }));
  overlay.renderOrder = OVERLAY_RENDER_ORDER;
  overlay.receiveShadow = true; // same lighting as the first pass
  return overlay;
}
