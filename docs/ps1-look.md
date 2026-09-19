# The PS1 look

Why the island is rendered the way it is (think Mega Man Legends), what each
part of the effect contributes, and what was deliberately left out.

## What the hardware actually did

The visual signature of the PlayStation comes from a handful of limitations:

- **Low resolution.** 320×240 (sometimes 256 or 512 wide), shown on a CRT.
- **Integer vertex positions.** The GTE produced screen coordinates as whole
  pixels, so vertices jump between pixels as things move: polygons wobble
  and edges crawl.
- **15-bit colour with ordered dithering.** The GPU shaded in 24 bits but the
  framebuffer stored 5 bits per channel; a 4×4 Bayer pattern hid the banding.
- **Affine texture mapping.** No perspective correction, so textures bend
  across large polygons.
- **No depth buffer, no shadows, no antialiasing.** Polygons were sorted per
  primitive; lighting was flat or Gouraud, per vertex; distance was hidden
  with fog and short draw distances.
- **Small textures**, often 32–64 px per tile, with 4- or 8-bit palettes.

Everything below maps one of these onto the existing renderer with as little
disturbance to the actual game as possible.

## What we do

All of it lives in `src/retro.js`, apart from the texel snapping and flat
shading in `src/terrainmaterial.js`.

**Low internal resolution.** The scene renders into a `WebGLRenderTarget`
about `TARGET_HEIGHT` (240) rows tall and is drawn to the window with nearest
filtering. The upscale factor is an integer (`floor(windowHeight / 240)`), so
every low-res pixel is the same size on screen; the target is allowed to be a
few rows taller than 240 rather than letterboxing. The camera aspect follows
the target, and since the target spans the same NDC range as the window, the
pointer → NDC mapping in `pick()` is unchanged.

The target is linear half-float, and the output pass converts to sRGB itself,
before quantising. Rendering straight into an 8-bit sRGB target would work
too, but a linear 8-bit one would band the darks before we get to dither them.

**Vertex snapping.** `snapVertices(material)` wraps a material's
`onBeforeCompile` and replaces three's `<project_vertex>` chunk with a version
that divides by `w`, rounds `xy` to the low-res pixel grid and multiplies `w`
back in. `snapScene()` applies it to every material in the scene once, after
setup; the shared `uSnapRes` uniform is updated from `setSize()`. `SNAP_PX`
sets the grid step in low-res pixels — 1 is what the hardware did.

Because the water plane is a 256×256 grid over 12× the island size, its
vertices are ~1.5 units apart and the snapping makes the whole surface shimmer
gently. That is a feature; the tightened fog keeps it from getting coarse in
the distance.

**15-bit colour + dither.** The output pass quantises each channel to
`COLOR_BITS` (5) with a 4×4 Bayer threshold, in sRGB space, indexed by
low-res pixel so the pattern is one texel wide.

**Flat shading.** `MeshStandardMaterial({ flatShading: true })` on the terrain.
The smoothed Marching Cubes mesh has one vertex per cell; with smooth normals
it reads as a rounded blob, with flat normals as a low-poly model. The grass
slope test in the fragment shader still uses the smooth per-vertex world
normal, otherwise the grass border would flip per facet.

**Texel-snapped procedural textures.** The terrain's grass noise and border
wobble are sampled at positions rounded to `TEXELS_PER_UNIT` (8) per world
unit, so they look like a small texture stretched over the polygons. Noise
frequencies were lowered to stay well under the texel rate; value noise
sampled at its own lattice spacing degenerates into white speckle.

**Supporting changes in `main.js`:** `antialias: false`, pixel ratio 1, shadow
maps off (`SHADOWS` constant), fog pulled in from `[3·SIZE, 8·SIZE]` to
`[1.5·SIZE, 5·SIZE]`.

## Left out, and why

- **Affine texture warping.** The distinctive bend needs textures with UVs;
  our surfaces are vertex-coloured and procedural. Could be faked by
  perturbing the texel lookup by `1/w`, but on terrain this size the polygons
  are too small for it to register.
- **Depth-sort popping / polygon flicker.** Emulating the lack of a depth
  buffer would fight the submerged-overlay trick in `terrainmaterial.js`.
- **CRT effects** (scanlines, bloom, colour bleed). The PS1 itself did none
  of this; it is what a TV did to it. Left out to keep the picture crisp and
  the pixel grid honest. Easy to add to the output pass if wanted.
- **Interlace / 480i shimmer.** Same reasoning.
- **Gouraud instead of per-pixel lighting.** three's Lambert and Standard
  materials both light per pixel now; at 240 rows the difference is
  invisible, and flat shading covers the "one value per polygon" look.

## Knobs

| Constant | File | Effect |
| --- | --- | --- |
| `TARGET_HEIGHT` | `retro.js` | Internal rows. 240 authentic; 180 chunkier. |
| `SNAP_PX` | `retro.js` | Vertex snapping grid step in low-res pixels. |
| `COLOR_BITS` | `retro.js` | Bits per channel; 5 is PS1, 4 shows the dither more. |
| `SHADOWS` | `main.js` | Re-enable shadow maps for a modern look. |
| `TEXELS_PER_UNIT` | `terrainmaterial.js` | Coarseness of the fake texture. |
| `flatShading` | `terrainmaterial.js` | Set false for the previous rounded look. |

To go back to the modern look entirely: `renderer.render(scene, camera)` in
the loop instead of `retro.render`, drop `snapScene(scene)`, and set
`SHADOWS = true`.
