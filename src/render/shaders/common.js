// GLSL helpers shared by terrain, water, sky and cloud shaders.
export const noiseGLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.875;
}
float fbm5(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.96875;
}
`;

export const cloudGLSL = /* glsl */ `
uniform float uCloudCover;
uniform vec2 uCloudOffset;
float cloudDensity(vec2 xz) {
  vec2 p = (xz + uCloudOffset) * 0.016;
  float n = fbm5(p);
  float cov = uCloudCover;
  return smoothstep(1.0 - cov * 0.95 - 0.12, 1.0 - cov * 0.95 + 0.22, n);
}
// Shadow cast by the cloud layer (height ~40) along the light direction.
float cloudShadow(vec3 wp, vec3 sunDir) {
  vec2 xz = wp.xz + sunDir.xz / max(sunDir.y, 0.2) * (40.0 - wp.y);
  return 1.0 - cloudDensity(xz) * 0.7;
}
`;
