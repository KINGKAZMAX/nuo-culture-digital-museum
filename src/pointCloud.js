// 精确点云: TDPC 格式(位置 + 颜色全精度导出)
// 渲染配方: 球体精灵直径0.01, 双点光源, alpha 混合, 反馈光晕
import * as THREE from "three";

export async function loadBPC(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`load ${url}: ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  let raw = data;
  // 部分环境会透明解压 gzip,按魔数判断
  if (data[0] === 0x1f && data[1] === 0x8b) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic === "TDPC") return parseTDPC(dv, raw);
  if (magic === "BPC1") return parseBPC(dv, raw);
  throw new Error("bad magic " + magic);
}

// 导出格式: "TDPC" u32 n, 然后 n × f32(xyz rgb)
function parseTDPC(dv, raw) {
  const n = dv.getUint32(4, true);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 8 + i * 24;
    positions[i * 3] = dv.getFloat32(o, true);
    positions[i * 3 + 1] = dv.getFloat32(o + 4, true);
    positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
    // sRGB 输入: 转 linear
    colors[i * 3 + 0] = Math.pow(Math.max(0, Math.min(1, dv.getFloat32(o + 12, true))), 2.2);
    colors[i * 3 + 1] = Math.pow(Math.max(0, Math.min(1, dv.getFloat32(o + 16, true))), 2.2);
    colors[i * 3 + 2] = Math.pow(Math.max(0, Math.min(1, dv.getFloat32(o + 20, true))), 2.2);
    seeds[i] = Math.random();
  }
  return buildGeo(positions, colors, seeds, n);
}

// 旧量化格式(用户新增模型等): "BPC1" u32 n f32 min[3] max[3] n×(i16 xyz u8 rgba)
function parseBPC(view, raw) {
  let p = 4;
  const count = view.getUint32(p, true); p += 4;
  const min = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)]; p += 12;
  const max = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)]; p += 12;
  const span = [max[0] - min[0] || 1e-6, max[1] - min[1] || 1e-6, max[2] - min[2] || 1e-6];
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scale = 2.6 / Math.max(span[0], span[1], span[2]); // 面具统一尺度
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < count; i++) {
    const qx = view.getInt16(p, true) + 32768; p += 2;
    const qy = view.getInt16(p, true) + 32768; p += 2;
    const qz = view.getInt16(p, true) + 32768; p += 2;
    positions[i * 3 + 0] = (qx / 65535 * span[0] + min[0] - cx) * scale;
    positions[i * 3 + 1] = (qy / 65535 * span[1] + min[1] - cy) * scale;
    positions[i * 3 + 2] = (qz / 65535 * span[2] + min[2] - cz) * scale;
    const r = raw[p++] / 255, g = raw[p++] / 255, b = raw[p++] / 255;
    colors[i * 3 + 0] = Math.pow(r, 2.2);
    colors[i * 3 + 1] = Math.pow(g, 2.2);
    colors[i * 3 + 2] = Math.pow(b, 2.2);
    seeds[i] = Math.random();
  }
  return buildGeo(positions, colors, seeds, count);
}

function buildGeo(positions, colors, seeds, count) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
  geo.computeBoundingSphere();
  return { geometry: geo, count };
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uDisp;       // 握拳爆散 0..2
uniform float uGhost;      // 0=主层, 1..4=反馈光晕层
uniform float uPointSize;  // 世界直径 0.01 的倍率
uniform float uPixelRatio;
uniform float uViewH;      // 视口高(物理像素)
uniform float uTanHalfFov;
attribute float seed;
attribute vec3 color;
varying vec3 vColor;

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dot(hash3(i), f), dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
        mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)), dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
    mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)), dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
        mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)), dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}

void main() {
  vColor = color;
  vec3 pos = position;

  // 反馈光晕: 历史帧漂移
  if (uGhost > 0.5) {
    float g = uGhost;
    float amp = 0.012 + 0.022 * (g - 1.0);
    vec3 flow = vec3(
      vnoise(position * 2.0 + vec3(0.0, -uTime * 0.05 * g, uTime * 0.03 * g)),
      vnoise(position * 2.2 + vec3(uTime * 0.04 * g, 0.0, -uTime * 0.05 * g)) * 0.6 + 0.18,
      vnoise(position * 2.4 - vec3(uTime * 0.05 * g, uTime * 0.04 * g, 0.0)));
    pos += flow * amp;
  }

  // 握拳幅度 0..2 的发散
  float d = uDisp;
  if (d > 0.001) {
    vec3 dir = normalize(position + vec3(0.0, 0.001, 0.0));
    vec3 flow2 = vec3(
      vnoise(position * 2.3 + vec3(0.0, -uTime * 0.22, uTime * 0.13)),
      vnoise(position * 5.1 + vec3(uTime * 0.17, uTime * 0.1, 0.0)),
      vnoise(position * 3.1 + vec3(uTime * 0.1, 0.0, uTime * 0.2)));
    pos += (flow2 * 0.5 + dir * (0.3 + 0.5 * seed)) * d * (0.3 + 0.4 * seed);
    pos.y += d * 0.08 * seed;
  }

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  // 球直径 0.01 世界单位
  float worldD = 0.01 * uPointSize;
  float px = worldD * uViewH / (2.0 * (-mv.z) * uTanHalfFov);
  gl_PointSize = clamp(px * uPixelRatio, 1.0, 28.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uOpacity;
uniform float uInk;
uniform float uExposure;       // 主题曝光: 黑色空间展厅 1.18 提亮点云
varying vec3 vColor;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  // 球体伪法线 → 双点光源漫反射
  // 双点光源: (2.68,-1.20,2.74) 0.995 / (-3.06,-.88,3.21) 2.0, 相机(0,0,5)
  vec3 n = vec3(uv * 2.0, sqrt(max(0.0, 1.0 - 4.0 * r2)));
  vec3 vl1 = normalize(vec3(0.51, -0.23, -0.83));
  vec3 vl2 = normalize(vec3(-0.57, -0.17, -0.80));
  float diff = max(0.0, dot(n, vl1)) * 0.995 + max(0.0, dot(n, vl2)) * 2.0;
  float shade = min(0.58 + diff * 0.88, 0.94); // 白底高光点 clamp,防纯白点融进背景
  // Blinn-Phong 微高光: 立体感/精细感(强度克制, 不抢色彩)
  float spec = pow(max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0), 32.0) * 0.16;
  float edge = smoothstep(0.25, 0.16, r2);
  vec3 base = vColor;
  if (uInk > 0.5) {
    // 水墨:亮度映射到淡墨(亮部)~浓墨(暗部),暖灰阶避免冷蓝
    float lum = dot(vColor, vec3(0.299, 0.587, 0.114));
    float inkv = mix(0.20, 0.58, lum);
    base = vec3(inkv) * vec3(1.04, 1.0, 0.92);
  }
  gl_FragColor = vec4(base * min(shade + spec, 0.96) * uExposure, edge * uOpacity);
}
`;

export function makePointsMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uExposure: { value: 1.0 },
      uDisp: { value: 0 },
      uGhost: { value: opts.ghost ?? 0 },
      uPointSize: { value: opts.pointSize ?? 1 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2.5) },
      uOpacity: { value: opts.opacity ?? 1 },
      uInk: { value: opts.ink ? 1 : 0 },
      uViewH: { value: window.innerHeight * Math.min(window.devicePixelRatio, 2.5) },
      uTanHalfFov: { value: Math.tan(((opts.fov ?? 45) / 2) * Math.PI / 180) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: true, // EDL 深度着色需要真实深度
    blending: THREE.NormalBlending,
  });
}
