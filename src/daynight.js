import * as THREE from 'three';

/**
 * Day / night look driven by a single 0..1 time-of-day knob.
 *
 *   0     midnight
 *   0.25  sunrise
 *   0.5   noon
 *   0.75  sunset
 *   1     midnight again
 *
 * Sky, fog, and hemisphere fill are lerped across keyframes. The sun and moon
 * sit opposite each other on one shared arc: by day the warm directional is
 * up; by night a cool moonlight takes over and a visible disc hangs in the
 * sky (fog-immune so the dense PS1 fog doesn't swallow it).
 */

// Orbit radius as a multiple of the island size. Far enough that the light
// direction is stable across the footprint; close enough to stay in view.
const LIGHT_DISTANCE = 1.4;
// Moon disc radius in world units. Sized to read as a clear disc at the
// low-res retro framebuffer without covering half the sky.
const MOON_RADIUS = 1.6;
// Soft halo around the disc; larger + dimmer so it reads as glow, not a second moon.
const MOON_GLOW_RADIUS = 3.2;
// Peak moonlight intensity (directional). Kept well below noon sun so night
// stays moody rather than a blue daytime.
const MOON_MAX_INTENSITY = 0.55;
const MOON_COLOR = 0xc8d6f0;

// Keyframes: sky / fill / sun only. Moonlight is derived from elevation so it
// rises and sets smoothly without needing its own stop table. Night sun
// intensity is 0 — the cool fill used to live on the sun light; that job now
// belongs to the moon.
const STOPS = [
  {
    t: 0,
    sky: 0x0b1e33,
    hemiSky: 0x1a3050,
    hemiGround: 0x1a2418,
    hemiIntensity: 0.22,
    sunColor: 0xfff4e0,
    sunIntensity: 0,
  },
  {
    t: 0.2,
    sky: 0x2a2848,
    hemiSky: 0x4a4068,
    hemiGround: 0x2a2820,
    hemiIntensity: 0.3,
    sunColor: 0xff7a55,
    sunIntensity: 0.15,
  },
  {
    t: 0.26,
    sky: 0xe8986a,
    hemiSky: 0xffc090,
    hemiGround: 0x5a4a38,
    hemiIntensity: 0.55,
    sunColor: 0xffb070,
    sunIntensity: 1.1,
  },
  {
    t: 0.4,
    sky: 0x9fd0f5,
    hemiSky: 0xdff3ff,
    hemiGround: 0x4a6b3a,
    hemiIntensity: 0.7,
    sunColor: 0xfff4e0,
    sunIntensity: 1.6,
  },
  {
    t: 0.5,
    sky: 0xb0d8f8,
    hemiSky: 0xffffff,
    hemiGround: 0x5a7b4a,
    hemiIntensity: 0.78,
    sunColor: 0xfffff0,
    sunIntensity: 1.85,
  },
  {
    t: 0.62,
    sky: 0x9fd0f5,
    hemiSky: 0xdff3ff,
    hemiGround: 0x4a6b3a,
    hemiIntensity: 0.7,
    sunColor: 0xfff0d0,
    sunIntensity: 1.55,
  },
  {
    t: 0.74,
    sky: 0xd87858,
    hemiSky: 0xffa070,
    hemiGround: 0x4a3828,
    hemiIntensity: 0.5,
    sunColor: 0xff9050,
    sunIntensity: 1.05,
  },
  {
    t: 0.82,
    sky: 0x3a2a50,
    hemiSky: 0x5a4070,
    hemiGround: 0x221c28,
    hemiIntensity: 0.28,
    sunColor: 0xff9050,
    sunIntensity: 0.1,
  },
  {
    t: 1,
    sky: 0x0b1e33,
    hemiSky: 0x1a3050,
    hemiGround: 0x1a2418,
    hemiIntensity: 0.22,
    sunColor: 0xfff4e0,
    sunIntensity: 0,
  },
];

// Scratch colours reused every sample so setTime can run every input event
// without allocating. Callers must copy out of these before the next sample.
const _sky = new THREE.Color();
const _hemiSky = new THREE.Color();
const _hemiGround = new THREE.Color();
const _sun = new THREE.Color();
const _skyB = new THREE.Color();
const _hemiSkyB = new THREE.Color();
const _hemiGroundB = new THREE.Color();
const _sunB = new THREE.Color();

function sample(t) {
  const u = ((t % 1) + 1) % 1;
  let i = 0;
  while (i < STOPS.length - 1 && STOPS[i + 1].t < u) i++;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const f = (u - a.t) / (b.t - a.t);

  _sky.set(a.sky).lerp(_skyB.set(b.sky), f);
  _hemiSky.set(a.hemiSky).lerp(_hemiSkyB.set(b.hemiSky), f);
  _hemiGround.set(a.hemiGround).lerp(_hemiGroundB.set(b.hemiGround), f);
  _sun.set(a.sunColor).lerp(_sunB.set(b.sunColor), f);

  return {
    sky: _sky,
    hemiSky: _hemiSky,
    hemiGround: _hemiGround,
    sun: _sun,
    hemiIntensity: THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, f),
    sunIntensity: THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, f),
  };
}

/** Smooth 0..1 factor for how high a body is above the horizon. */
function aboveHorizon(elev) {
  // Soft shoulder so rise/set doesn't pop the light or the disc on/off.
  // Starts at 0 so the moon never draws while still underground.
  return THREE.MathUtils.smoothstep(elev, 0, 0.22);
}

function placeOnArc(out, target, angle, radius) {
  const elev = Math.sin(angle);
  const azim = Math.cos(angle);
  out.set(
    target.x + azim * radius,
    target.y + elev * radius,
    target.z + 0.3 * radius
  );
  return elev;
}

/**
 * Wire hemisphere + sun lights, sky/fog, and a moon (mesh + moonlight) to a
 * time knob. Adds the moon objects to `scene`. Call `setTime` on slider input.
 *
 * @param {{ size: number, scene: THREE.Scene, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight }} opts
 */
export function createDayNight({ size, scene, hemi, sun }) {
  const radius = size * LIGHT_DISTANCE;
  const target = sun.target.position;

  const moonLight = new THREE.DirectionalLight(MOON_COLOR, 0);
  moonLight.target.position.copy(target);
  scene.add(moonLight, moonLight.target);

  // Unlit disc + glow: MeshBasic so they don't pick up their own moonlight,
  // fog off so the dense scene fog doesn't erase them at LIGHT_DISTANCE.
  const moonMat = new THREE.MeshBasicMaterial({
    color: 0xf0f4ff,
    fog: false,
    depthWrite: false,
  });
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xa8c0e8,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 16, 12), moonMat);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(MOON_GLOW_RADIUS, 16, 12), glowMat);
  moon.renderOrder = 10;
  glow.renderOrder = 9;
  moon.visible = false;
  glow.visible = false;
  scene.add(glow, moon);

  function setTime(t) {
    const look = sample(t);

    scene.background.copy(look.sky);
    if (scene.fog) scene.fog.color.copy(look.sky);

    hemi.color.copy(look.hemiSky);
    hemi.groundColor.copy(look.hemiGround);
    hemi.intensity = look.hemiIntensity;

    // Angle 0 at sunrise (t=0.25): sun on the +X horizon. Moon is opposite.
    const sunAngle = (t - 0.25) * Math.PI * 2;
    const moonAngle = sunAngle + Math.PI;

    const sunElev = placeOnArc(sun.position, target, sunAngle, radius);
    // Keep the light just above the plane when the body is set so the
    // directional doesn't flip through the ground; intensity is already 0 then.
    if (sunElev < 0.02) sun.position.y = target.y + 0.02 * radius;
    sun.color.copy(look.sun);
    sun.intensity = look.sunIntensity * aboveHorizon(sunElev);

    const moonElev = placeOnArc(moonLight.position, target, moonAngle, radius);
    const moonFactor = aboveHorizon(moonElev);
    if (moonElev < 0.02) moonLight.position.y = target.y + 0.02 * radius;
    moonLight.intensity = MOON_MAX_INTENSITY * moonFactor;

    const up = moonFactor > 0.01;
    moon.visible = up;
    glow.visible = up;
    if (up) {
      moon.position.copy(moonLight.position);
      glow.position.copy(moonLight.position);
      glowMat.opacity = 0.22 * moonFactor;
      moonMat.opacity = 1;
    }
  }

  return { setTime, moon, moonLight };
}

/** Default slider value: mid-morning, close to the previous fixed daylight. */
export const DEFAULT_TIME = 0.42;
