// Convert background-particle dumps (/tmp raw f32 bins) into
// TDPC tdp.gz web assets under public/models/.
//
// Raw bin layout (dumped via toptoCHOP, see /tmp/rd_top.py protocol):
//   per TOP: w*h pixels, row-major (y rows, x cols), each pixel 4 x f32 LE = r,g,b,a
//   position TOP: rgb = xyz instance position, a = active mask
//   color TOP:    rgb = instance color
//
// Output TDPC format (matches existing nuo*.tdp.gz):
//   magic "TDPC" | u32 n (LE) | n x f32 LE (x,y,z,r,g,b), gzip level 6
//
// Meta (transform scales measured live on 2026-08-29):
//   bg-a: geo1 instancing pos1/col, SOP sphere1(rad 1) -> transform1 uniform scale 0.007
//   bg-b: geo4 instancing bgpos/bgcol, SOP box1 -> transform3 uniform scale 0.004,
//         geo4 material is actually a constant CHOP (no color pars)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.resolve(import.meta.dirname, "../public/models");
const META = JSON.parse(fs.readFileSync("/tmp/bg-meta.json", "utf8"));

const CLOUDS = ["bg-a", "bg-b"];
// constant2 is a constant CHOP, not a MAT: no color to export.
const CONSTANT2_COLOR = null;

function readTop(file, w, h) {
  const buf = fs.readFileSync(file);
  const expect = w * h * 4 * 4;
  if (buf.length !== expect) throw new Error(`${file}: ${buf.length}B != ${expect}B`);
  return buf;
}

function stats(n, floats) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = floats[i * 6 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    for (let c = 0; c < 3; c++) sum[c] += floats[i * 6 + 3 + c];
  }
  return { min, max, mean: sum.map((s) => s / n) };
}

const manifestPath = path.join(OUT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.background = manifest.background || {};

for (const name of CLOUDS) {
  const m = META[name];
  const pos = readTop(m.pos, m.w, m.h);
  const col = readTop(m.col, m.w, m.h);
  const npx = m.w * m.h;

  // active mask from position-TOP alpha; if none > 0.5, keep everything
  let active = 0;
  for (let i = 0; i < npx; i++) if (pos.readFloatLE(i * 16 + 12) > 0.5) active++;
  const filtered = active > 0;

  const out = Buffer.alloc(8 + (filtered ? active : npx) * 24);
  out.write("TDPC", 0, "latin1");
  out.writeUInt32LE(filtered ? active : npx, 4);
  let p = 8;
  const all = [];
  for (let i = 0; i < npx; i++) {
    if (filtered && pos.readFloatLE(i * 16 + 12) <= 0.5) continue;
    const o = i * 16, c = i * 16;
    const rec = [
      pos.readFloatLE(o), pos.readFloatLE(o + 4), pos.readFloatLE(o + 8),
      col.readFloatLE(c), col.readFloatLE(c + 4), col.readFloatLE(c + 8),
    ];
    for (const v of rec) { out.writeFloatLE(v, p); p += 4; }
    all.push(...rec);
  }

  const gz = zlib.gzipSync(out, { level: 6 });
  const outFile = path.join(OUT, `${name}.tdp.gz`);
  fs.writeFileSync(outFile, gz);

  // verify by reading the file back from disk
  const back = zlib.gunzipSync(fs.readFileSync(outFile));
  if (back.toString("latin1", 0, 4) !== "TDPC") throw new Error(`${name}: bad magic on readback`);
  const n = back.readUInt32LE(4);
  if (8 + n * 24 !== back.length) throw new Error(`${name}: size mismatch on readback`);
  const floats = new Float32Array(back.buffer, back.byteOffset + 8, n * 6);
  const st = stats(n, floats);

  manifest.background[name] = {
    count: n,
    [`${m.transform}.scale`]: m.scale,
    bounds: {
      min: st.min.map((v) => Math.round(v * 1e4) / 1e4),
      max: st.max.map((v) => Math.round(v * 1e4) / 1e4),
    },
    colorMean: st.mean.map((v) => Math.round(v * 1e4) / 1e4),
    activeFiltered: filtered,
    bytes: gz.length,
  };
  if (name === "bg-b") manifest.background[name]["constant2.color"] = CONSTANT2_COLOR;

  const r4 = (v) => v.map((x) => x.toFixed(3)).join(", ");
  console.log(`${name}: ${n} pts (px ${m.w}x${m.h}${filtered ? `, ${active} active` : ", no active filter"})`);
  console.log(`  xyz min [${r4(st.min)}]  max [${r4(st.max)}]`);
  console.log(`  rgb mean [${r4(st.mean)}]`);
  console.log(`  -> ${outFile} (${gz.length} B gz, ${out.length} B raw), ${m.transform}.scale=${m.scale}`);
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("manifest updated:", manifestPath);
