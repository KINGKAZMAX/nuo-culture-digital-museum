// 上传模型 -> 点云 BufferGeometry
// 支持: .ply(binary_little_endian/ascii, 含颜色) / .glb / .gltf / .obj(表面采样)
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";

const SIZES = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

export function parsePLY(buffer, targetCount = 640000) {
  const buf = new Uint8Array(buffer);
  const headText = new TextDecoder("latin1").decode(buf.subarray(0, 8192));
  const endIdx = headText.indexOf("end_header");
  if (!headText.startsWith("ply") || endIdx < 0) throw new Error("不是有效的 PLY 文件");
  // dataStart 必须跳过 end_header 后的换行(CRLF 计 2 字节),否则二进制体整体错位
  let headerEnd = endIdx + 10;
  if (headText[headerEnd] === "\r") headerEnd += 1;
  if (headText[headerEnd] === "\n") headerEnd += 1;
  const header = headText.slice(0, headerEnd);
  const lines = header.split(/\r?\n/);
  const fmtLine = lines.find((l) => l.startsWith("format")) ?? "";
  const ascii = fmtLine.includes("ascii");
  const vertexLine = lines.find((l) => l.startsWith("element vertex"));
  const total = Number(vertexLine.split(" ")[2]);

  // 收集 vertex 元素的属性(到下一个 element/end_header)
  const props = [];
  let inVertex = false;
  for (const l of lines) {
    if (l.startsWith("element ")) { inVertex = l.split(" ")[1] === "vertex"; continue; }
    if (inVertex && l.startsWith("property ")) {
      const [, type, name] = l.trim().split(/\s+/);
      props.push({ type, name });
    }
  }
  let off = 0;
  const offsets = {};
  for (const p of props) { offsets[p.name] = { off, type: p.type }; off += SIZES[p.type] ?? 0; }
  const rowSize = off;
  const dataStart = header.length;
  const dv = new DataView(buffer);

  const readAt = (base, type) => {
    switch (type) {
      case "float": case "int": return dv.getFloat32(base, true);
      case "double": return dv.getFloat64(base, true);
      case "uchar": return dv.getUint8(base);
      case "char": return dv.getInt8(base);
      case "ushort": return dv.getUint16(base, true);
      case "short": return dv.getInt16(base, true);
      case "uint": return dv.getUint32(base, true);
      default: return dv.getInt32(base, true);
    }
  };

  // 步长采样到 targetCount
  const stride = Math.max(1, Math.ceil(total / targetCount));
  const keep = [];
  for (let i = 0; i < total; i += stride) keep.push(i);

  const positions = new Float32Array(keep.length * 3);
  const colors = new Float32Array(keep.length * 3);
  const seeds = new Float32Array(keep.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const raw = new Array(keep.length);

  if (ascii) {
    const text = new TextDecoder("latin1").decode(buf.subarray(dataStart));
    const toks = text.split(/\s+/).filter(Boolean);
    const cols = props.length;
    keep.forEach((row, k) => {
      raw[k] = props.map((p, c) => parseFloat(toks[row * cols + c]));
    });
  } else {
    keep.forEach((row, k) => {
      const base = dataStart + row * rowSize;
      raw[k] = props.map((p) => readAt(base + offsets[p.name].off, p.type));
    });
  }

  const ix = props.findIndex((p) => p.name === "x");
  const iy = props.findIndex((p) => p.name === "y");
  const iz = props.findIndex((p) => p.name === "z");
  const ir = props.findIndex((p) => p.name === "red");
  const ig = props.findIndex((p) => p.name === "green");
  const ib = props.findIndex((p) => p.name === "blue");

  for (const v of raw) {
    for (const [vi, ai] of [[ix, 0], [iy, 1], [iz, 2]]) {
      if (v[vi] < min[ai]) min[ai] = v[vi];
      if (v[vi] > max[ai]) max[ai] = v[vi];
    }
  }
  for (let a = 0; a < 3; a++) if (min[a] === Infinity) { min[a] = 0; max[a] = 1; }
  const span = [max[0] - min[0] || 1e-6, max[1] - min[1] || 1e-6, max[2] - min[2] || 1e-6];
  const scale = 1 / Math.max(span[0], span[1], span[2]);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;

  raw.forEach((v, k) => {
    positions[k * 3] = (v[ix] - cx) * scale;
    positions[k * 3 + 1] = (v[iy] - min[1]) * scale;
    positions[k * 3 + 2] = (v[iz] - cz) * scale;
    const r = ir >= 0 ? v[ir] / 255 : 0.85, g = ig >= 0 ? v[ig] / 255 : 0.7, b = ib >= 0 ? v[ib] / 255 : 0.5;
    colors[k * 3] = Math.pow(r, 2.2); colors[k * 3 + 1] = Math.pow(g, 2.2); colors[k * 3 + 2] = Math.pow(b, 2.2);
    seeds[k] = Math.random();
  });

  return buildGeo(positions, colors, seeds, keep.length);
}

export async function parseModelFile(file, targetCount = 300000) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".ply")) {
    return parsePLY(await file.arrayBuffer(), targetCount);
  }
  if (name.endsWith(".glb") || name.endsWith(".gltf")) {
    const loader = new GLTFLoader();
    const url = URL.createObjectURL(file);
    try {
      const gltf = await loader.loadAsync(url);
      return sampleToPoints(gltf.scene, targetCount);
    } finally { URL.revokeObjectURL(url); }
  }
  if (name.endsWith(".obj")) {
    const loader = new OBJLoader();
    const url = URL.createObjectURL(file);
    try {
      const obj = await loader.loadAsync(url);
      return sampleToPoints(obj, targetCount);
    } finally { URL.revokeObjectURL(url); }
  }
  throw new Error("不支持的格式: " + file.name);
}

// 遍历 mesh,按表面积比例分配采样点
function sampleToPoints(root, targetCount) {
  const items = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
      if (geo.getAttribute("position")) items.push({ geo, mesh: o });
    }
  });
  if (!items.length) throw new Error("模型里没有网格几何体");
  const boxes = items.map(({ geo }) => {
    geo.computeBoundingBox();
    return geo.boundingBox;
  });
  // 统一世界包围盒
  const worldBox = new THREE.Box3();
  for (const it of items) {
    const b = boxes[items.indexOf(it)].clone().applyMatrix4(it.mesh.matrixWorld);
    worldBox.union(b);
  }
  const size = worldBox.getSize(new THREE.Vector3());
  const scale = 1 / Math.max(size.x, size.y, size.z, 1e-6);
  const center = worldBox.getCenter(new THREE.Vector3());

  const per = Math.max(1000, Math.floor(targetCount / items.length));
  const totalPts = per * items.length;
  const positions = new Float32Array(totalPts * 3);
  const colors = new Float32Array(totalPts * 3);
  const seeds = new Float32Array(totalPts);
  let w = 0;
  items.forEach(({ geo, mesh }, idx) => {
    const sampler = new MeshSurfaceSampler(mesh).build();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const c = new THREE.Vector3();
    const hasColor = !!geo.getAttribute("color");
    const matColor = mesh.material?.color ?? new THREE.Color(0.9, 0.75, 0.45);
    for (let i = 0; i < per; i++) {
      sampler.sample(p, n, hasColor ? c : undefined);
      p.applyMatrix4(mesh.matrixWorld);
      positions[w * 3] = (p.x - center.x) * scale;
      positions[w * 3 + 1] = (p.y - worldBox.min.y) * scale;
      positions[w * 3 + 2] = (p.z - center.z) * scale;
      const src = hasColor ? c : matColor;
      colors[w * 3] = Math.pow(src.r, 2.2);
      colors[w * 3 + 1] = Math.pow(src.g, 2.2);
      colors[w * 3 + 2] = Math.pow(src.b, 2.2);
      seeds[w] = Math.random();
      w++;
    }
  });
  return buildGeo(positions, colors, seeds, w);
}

function buildGeo(positions, colors, seeds, count) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, count * 3), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors.subarray(0, count * 3), 3));
  geo.setAttribute("seed", new THREE.BufferAttribute(seeds.subarray(0, count), 1));
  geo.computeBoundingSphere();
  return geo;
}
