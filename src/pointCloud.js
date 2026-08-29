// 量化二进制点云 (.bpc.gz) 加载 + 粒子着色器
// 格式见 tools/convert-ply.mjs 头部注释
import * as THREE from "three";

export async function loadBPC(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`load ${url}: ${resp.status}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  const raw = await maybeInflate(data);
  return parseBPC(raw);
}

// 部分环境会透明解压 gzip,按魔数判断
async function maybeInflate(u8) {
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return u8;
}

export function parseBPC(raw) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let p = 0;
  const magic = String.fromCharCode(raw[p++], raw[p++], raw[p++], raw[p++]);
  if (magic !== "BPC1") throw new Error("bad magic " + magic);
  const count = view.getUint32(p, true); p += 4;
  const min = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)]; p += 12;
  const max = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)]; p += 12;
  const span = [max[0] - min[0] || 1e-6, max[1] - min[1] || 1e-6, max[2] - min[2] || 1e-6];

  // 居中到原点、底部对齐 y=0，再整体缩放到 ~1 高度单位
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scale = 1 / Math.max(span[0], span[1], span[2]);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < count; i++) {
    const qx = view.getInt16(p, true) + 32768; p += 2;
    const qy = view.getInt16(p, true) + 32768; p += 2;
    const qz = view.getInt16(p, true) + 32768; p += 2;
    positions[i * 3 + 0] = (qx / 65535 * span[0] + min[0] - cx) * scale;
    positions[i * 3 + 1] = (qy / 65535 * span[1] + min[1]) * scale;
    positions[i * 3 + 2] = (qz / 65535 * span[2] + min[2] - cz) * scale;
    const r = raw[p++] / 255, g = raw[p++] / 255, b = raw[p++] / 255;
    // 颜色经过 sRGB 编码，转到 linear 让 bloom 观感更佳
    colors[i * 3 + 0] = Math.pow(r, 2.2);
    colors[i * 3 + 1] = Math.pow(g, 2.2);
    colors[i * 3 + 2] = Math.pow(b, 2.2);
    seeds[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
  geo.computeBoundingSphere();
  return { geometry: geo, count };
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uDisp;      // 0..~2 爆散强度（握拳）
uniform float uPointSize;
uniform float uPixelRatio;
attribute float seed;
attribute vec3 color;
varying vec3 vColor;
varying float vTwinkle;
varying float vFade;

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
    mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
            dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
        mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
            dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
    mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
            dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
        mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
            dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y), u.z);
}

void main() {
  vColor = color;
  vec3 pos = position;

  // 常态:极轻微呼吸噪声(环境呼吸噪声)
  float ambient = 0.012;
  // 爆散:流动噪声把粒子推成云雾(级联流动噪声)
  float d = uDisp;
  vec3 dir = normalize(position + vec3(0.0, 0.001, 0.0));
  float n1 = vnoise(position * 2.3 + vec3(0.0, -uTime * 0.22, uTime * 0.13));
  float n2 = vnoise(position * 5.1 + vec3(uTime * 0.17, uTime * 0.1, 0.0));
  vec3 flow = vec3(n1, 0.55 * n2, n2) * 1.4 + dir * (0.35 + 0.4 * seed);
  pos += flow * (ambient + d * (0.35 + 0.5 * seed));
  // 爆散时轻微上浮扩散
  pos.y += d * 0.12 * (0.5 + seed);

  // 闪烁(星尘感)——幅度克制,保住色彩层次
  float tw = sin(uTime * (1.5 + seed * 4.0) + seed * 640.0);
  vTwinkle = 0.85 + 0.15 * tw;
  // 零星高亮闪点(占极少数帧)
  float flash = pow(max(0.0, sin(uTime * (0.4 + seed) + seed * 200.0)), 24.0);
  vTwinkle += flash * 0.9;

  vFade = 1.0;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = uPointSize * (0.75 + 0.5 * seed) * (1.0 + flash * 2.2);
  // 透视校正: uPointSize ≈ 相机距离 5.5 处的像素直径
  gl_PointSize = max(1.0, size * uPixelRatio * (5.5 / -mv.z));
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uOpacity;
varying vec3 vColor;
varying float vTwinkle;
varying float vFade;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float soft = smoothstep(0.25, 0.02, r2);
  float a = soft * vTwinkle * uOpacity;
  // 亮度压到 ~0.55,让 PLY 真实顶点色在 bloom 阈值下保留层次(暗夜星尘观感)
  gl_FragColor = vec4(vColor * vTwinkle * 0.55, a);
}
`;

export function makePointsMaterial(opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uDisp: { value: 0 },
      uPointSize: { value: opts.pointSize ?? 1.6 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uOpacity: { value: opts.opacity ?? 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
