// Convert binary_little_endian / ascii PLY point clouds into a compact
// quantized format for the web viewer.
// Layout: magic "BPC1" | u32 count | f32 min[3] | f32 max[3] | then per point:
//   i16 x, i16 y, i16 z (0..65535 mapped over bbox), u8 r, g, b, a
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SRC = process.env.PLY_SRC || path.resolve(import.meta.dirname, "../models-src"); // PLY 源目录(可用 PLY_SRC 环境变量指定)
const OUT = path.resolve(import.meta.dirname, "../public/models");

function parseHeader(buf) {
  const text = buf.toString("latin1", 0, Math.min(buf.length, 4096));
  const end = text.indexOf("end_header") + "end_header".length + 1;
  const headerText = text.slice(0, end);
  const lines = headerText.split(/\r?\n/);
  const fmt = lines.find((l) => l.startsWith("format"));
  const n = Number(lines.find((l) => l.startsWith("element vertex")).split(" ")[2]);
  const props = [];
  let inVertex = false;
  for (const l of lines) {
    if (l.startsWith("element ")) {
      inVertex = l.split(" ")[1] === "vertex";
      continue;
    }
    if (inVertex && l.startsWith("property ")) {
      const [, type, name] = l.trim().split(/\s+/);
      props.push({ type, name });
    }
  }
  return {
    binary: fmt.includes("binary_little_endian"),
    count: n,
    props,
    dataOffset: Buffer.byteLength(headerText, "latin1"),
  };
}

const SIZES = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

function convert(file, outFile, stride = 1) {
  const buf = fs.readFileSync(file);
  const h = parseHeader(buf);
  const offsets = {};
  let off = 0;
  for (const p of h.props) {
    offsets[p.name] = { off, type: p.type };
    off += SIZES[p.type];
  }
  const rowSize = off;
  const get = (row, name) => {
    const o = offsets[name];
    const base = row * rowSize + o.off + h.dataOffset;
    switch (o.type) {
      case "float":
      case "double":
        return buf.readFloatLE(base);
      case "uchar":
        return buf.readUInt8(base);
      case "char":
        return buf.readInt8(base);
      case "ushort":
        return buf.readUInt16LE(base);
      case "short":
        return buf.readInt16LE(base);
      case "uint":
        return buf.readUInt32LE(base);
      default:
        return buf.readInt32LE(base);
    }
  };
  const has = (name) => !!offsets[name];

  const keep = [];
  for (let i = 0; i < h.count; i += stride) {
    const x = get(i, "x"), y = get(i, "y"), z = get(i, "z");
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    keep.push(i);
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const i of keep) {
    for (const [k, axis] of [["x", 0], ["y", 1], ["z", 2]]) {
      const v = get(i, k);
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  for (let a = 0; a < 3; a++) if (min[a] === Infinity) { min[a] = 0; max[a] = 0; }
  const span = [Math.max(1e-6, max[0] - min[0]), Math.max(1e-6, max[1] - min[1]), Math.max(1e-6, max[2] - min[2])];

  const out = Buffer.alloc(4 + 4 + 24 + keep.length * 10);
  let p = 0;
  out.write("BPC1", p, "latin1"); p += 4;
  out.writeUInt32LE(keep.length, p); p += 4;
  for (const v of min) { out.writeFloatLE(v, p); p += 4; }
  for (const v of max) { out.writeFloatLE(v, p); p += 4; }
  for (const i of keep) {
    for (const [k, a] of [["x", 0], ["y", 1], ["z", 2]]) {
      const q = Math.round(((get(i, k) - min[a]) / span[a]) * 65535);
      out.writeInt16LE(Math.max(0, Math.min(65535, q)) - 32768, p); p += 2;
    }
    out.writeUInt8(has("red") ? get(i, "red") : 255, p++);
    out.writeUInt8(has("green") ? get(i, "green") : 255, p++);
    out.writeUInt8(has("blue") ? get(i, "blue") : 255, p++);
    out.writeUInt8(has("alpha") ? get(i, "alpha") : 255, p++);
  }
  fs.writeFileSync(outFile, zlib.gzipSync(out, { level: 6 }));
  return { count: keep.length, raw: out.length, min, max };
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = {};
const args = process.argv.slice(2);
const stride = args.includes("--stride") ? Number(args[args.indexOf("--stride") + 1]) : 1;
for (const f of fs.readdirSync(SRC)) {
  if (!f.toLowerCase().endsWith(".ply")) continue;
  const name = path.basename(f, ".ply");
  const info = convert(path.join(SRC, f), path.join(OUT, name + ".bpc.gz"), stride);
  manifest[name] = info;
  console.log(`${name}: ${info.count} pts, ${(info.raw / 1e6).toFixed(1)} MB raw`);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("manifest written to", path.join(OUT, "manifest.json"));
