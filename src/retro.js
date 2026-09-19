import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * PlayStation-era presentation (think Mega Man Legends), in three parts:
 *
 *   1. The scene is rendered into a small offscreen target, roughly 240 rows
 *      tall, and blown up to the window with nearest-neighbour sampling so
 *      every low-res pixel is a crisp square. No antialiasing anywhere.
 *   2. Every material gets a vertex-shader patch that rounds the projected
 *      vertex to that low-res pixel grid, like the PS1's fixed-point geometry
 *      unit did. Polygons jitter and edges crawl as the camera moves.
 *   3. A final pass converts to display (sRGB) values, quantises them to
 *      5 bits per channel (the PS1's 15-bit framebuffer) and hides the
 *      banding with the console's characteristic 4×4 ordered dither.
 *
 * Nothing here knows about the island; main.js hands it a scene and a camera.
 * Picking is unaffected because it maps window pixels to NDC, and the
 * low-res target covers the same NDC range as the window.
 */

// Rows of the internal framebuffer. 240 is the PS1's standard NTSC height; the
// width follows the window's aspect ratio. Lower is chunkier, higher makes the
// dither and the vertex wobble harder to see.
const TARGET_HEIGHT = 240;
// Step of the vertex snapping grid, in low-res pixels. 1 is what the hardware
// did; 2 exaggerates the wobble for windows where 240 rows are stretched tall.
const SNAP_PX = 1;
// Colour bits per channel after quantisation. 5 gives the 32 levels of the
// PS1's 15-bit output; 4 is more obviously dithered, 6+ hides the effect.
const COLOR_BITS = 5;

// Shared by every snapped material so one setSize() updates them all.
const snapUniforms = {
  uSnapRes: { value: new THREE.Vector2(320, 240) },
};

// Replaces three's <project_vertex>: after projecting, round the vertex to
// the pixel grid in NDC and put the perspective divide back. Vertices behind
// the camera (w <= 0) are left alone so clipping still works.
const SNAP_VERTEX = /* glsl */ `
#include <project_vertex>
if (gl_Position.w > 0.0) {
  vec2 grid = uSnapRes / ${SNAP_PX.toFixed(1)};
  vec2 ndc = gl_Position.xy / gl_Position.w;
  ndc = (floor((ndc * 0.5 + 0.5) * grid) + 0.5) / grid * 2.0 - 1.0;
  gl_Position.xy = ndc * gl_Position.w;
}
`;

/**
 * Patch a material so its vertices snap to the low-res pixel grid. Chains
 * onto any onBeforeCompile the material already has (terrain, water).
 */
export function snapVertices(material) {
  if (material.userData.retroSnapped) return material;
  material.userData.retroSnapped = true;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    Object.assign(shader.uniforms, snapUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uSnapRes;')
      .replace('#include <project_vertex>', SNAP_VERTEX);
  };
  // The default key is onBeforeCompile.toString(), which would now be the
  // same wrapper for every material; keep the underlying key distinct.
  material.customProgramCacheKey = function () {
    return previousKey.call(this) + '|retro-snap';
  };
  return material;
}

/** snapVertices() for everything currently in `root`. */
export function snapScene(root) {
  root.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(snapVertices);
  });
}

// 4×4 Bayer matrix, the ordered-dither pattern the PS1 GPU applied when it
// wrote 24-bit shading results into its 15-bit framebuffer.
const OUTPUT_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
varying vec2 vUv;

const float LEVELS = ${(2 ** COLOR_BITS - 1).toFixed(1)};
const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

vec3 linearToSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec3 c = linearToSRGB(texture2D(tDiffuse, vUv).rgb);
  ivec2 px = ivec2(floor(vUv * uResolution));
  float threshold = (float(BAYER[(px.y & 3) * 4 + (px.x & 3)]) + 0.5) / 16.0;
  c = floor(c * LEVELS + threshold) / LEVELS;
  gl_FragColor = vec4(c, 1.0);
}
`;

const OUTPUT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/**
 * Wraps a WebGLRenderer. Call setSize() on resize (it also fixes the camera
 * aspect) and render() instead of renderer.render().
 */
export function createRetroRenderer(renderer) {
  // Linear half-float target: the scene renders in linear light as usual and
  // the output pass does the sRGB conversion itself, after which it quantises.
  // (Rendering straight into an 8-bit target would band the darks before we
  // get to dither them.)
  const target = new THREE.WebGLRenderTarget(320, TARGET_HEIGHT, {
    type: THREE.HalfFloatType,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    depthBuffer: true,
  });

  const outputMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: target.texture },
      uResolution: { value: new THREE.Vector2(320, TARGET_HEIGHT) },
    },
    vertexShader: OUTPUT_VERTEX,
    fragmentShader: OUTPUT_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(outputMaterial);

  function setSize(width, height, camera) {
    // Integer upscale so every low-res pixel is the same size on screen; the
    // target may end up a few rows over TARGET_HEIGHT rather than letterbox.
    const scale = Math.max(1, Math.floor(height / TARGET_HEIGHT));
    const w = Math.ceil(width / scale);
    const h = Math.ceil(height / scale);
    target.setSize(w, h);
    outputMaterial.uniforms.uResolution.value.set(w, h);
    snapUniforms.uSnapRes.value.set(w, h);
    renderer.setSize(width, height);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function render(scene, camera) {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    quad.render(renderer);
  }

  return { setSize, render };
}
