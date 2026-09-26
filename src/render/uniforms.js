import * as THREE from 'three';

// Global uniforms shared by every custom material, so the sky / weather
// systems can drive terrain, water and vegetation from one place.
export const U = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector2(1, 0.3) }, // direction * strength
  uSunDir: { value: new THREE.Vector3(0, 1, 0) }, // direction of the dominant light (sun or moon)
  uSunColor: { value: new THREE.Color(1, 1, 1) }, // light colour * intensity / PI (Lambert-normalized)
  uAmbient: { value: new THREE.Color(0.3, 0.35, 0.45) },
  uSkyColor: { value: new THREE.Color(0.2, 0.4, 0.8) },
  uHorizonColor: { value: new THREE.Color(0.6, 0.7, 0.85) },
  uCloudCover: { value: 0.3 },
  uCloudOffset: { value: new THREE.Vector2() },
  uWetness: { value: 0 },
  uSnowCover: { value: 0 },
  uFreezeT: { value: 0.2 },
  uIceT: { value: 0.2 },
  uGrid: { value: 0 },
  uNight: { value: 0 },
};
