// 傩文化数字博物馆 Nuo Culture Digital Museum — 手势交互点云数字展馆
// 结构: Stage(Three.js 渲染) + HandControl(MediaPipe 手势) + ModelStore + 文案层
import { Stage } from "./scene.js";
import { HandControl, HAND_CONNECTIONS } from "./handControl.js";
import { ModelStore } from "./modelStore.js";
import { parseModelFile } from "./modelConvert.js";
import { loadBPC } from "./pointCloud.js";

const $ = (id) => document.getElementById(id);

// ---------- 持久化配置 ----------
const LS_KEY = "nuo-mask-cfg-v1";
const defaultCfg = {
  title: "贵傩戏-傩文化数字博物馆",
  sideEn: "NUO CULTURE DIGITAL MUSEUM",
  sideZh: "民俗 · 仪式 · 戏面",
  font: "Ma Shan Zheng",
  titleSize: 220,
  color: "#d9b06c",
  textVisible: true,
  spinSpeed: 6,
  rotSens: 1,
  smooth: 1,
  dispPower: 2,
  pointSize: 1.6,
};
function loadCfg() {
  try { return { ...defaultCfg, ...JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") }; }
  catch { return { ...defaultCfg }; }
}
function saveCfg() {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}
const cfg = loadCfg();

// ---------- 字体注入 ----------
function injectFontCss(font) {
  const map = {
    "Ma Shan Zheng": "./fonts/ma-shan-zheng/index.css",
    "ZCOOL XiaoWei": "./fonts/zcool-xiaowei/index.css",
    "Noto Serif SC": "./fonts/noto-serif-sc/400.css",
  };
  const href = map[font];
  if (!href) return;
  if (!document.querySelector(`link[href="${href}"]`)) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  }
}

function applyCfg() {
  const title = $("titleText");
  title.textContent = cfg.title;
  title.style.fontFamily = `'${cfg.font}', 'Kaiti SC', 'STKaiti', serif`;
  title.style.fontSize = `calc(${cfg.titleSize} / 12.5 * 1vmin)`;
  const gold = cfg.color;
  title.style.color = gold;
  title.style.textShadow = `0 0 2.2vmin ${hexA(gold, .45)}, 0 0 6vmin ${hexA(gold, .18)}`;
  document.querySelector(".side-en").textContent = cfg.sideEn.replace(/\s+/g, "\n");
  document.querySelector(".side-zh").textContent = cfg.sideZh;
  document.documentElement.style.setProperty("--gold", gold);
  $("textLayer").classList.toggle("hidden", !cfg.textVisible);
  injectFontCss(cfg.font);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------- 启动 ----------
const introStatus = $("introStatus");
const stage = new Stage($("stage"));
window.__stage = stage; // 调试/截图钩子
let store;
let hand;
let defs = [];
let currentModelIndex = 0;
const geoCache = new Map(); // key -> geometry

async function fetchRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`load ${url}: ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      window.__fetchFail = { url, err: String(e), at: Date.now() };
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  applyCfg();
  window.__step = "manifest";
  introStatus.textContent = "加载点云模型…";
  const manifest = await (await fetchRetry("./models/manifest.json")).json();
  store = new ModelStore(manifest);
  await store.init();
  defs = store.defs;

  // 首个模型
  window.__step = "first-model:" + defs[0].key;
  await ensureGeometry(defs[0]);
  stage.showModel(defs[0], geoCache.get(defs[0].key));
  $("hudModel").textContent = `模型 ${defs[0].name} / ${defs.length}`;

  // 预载下一个模型
  ensureGeometry(defs[1 % defs.length]).catch(() => {});

  // 手势
  hand = new HandControl({
    video: null,
    handCanvas: $("handCanvas"),
    hudGesture: (name, score) => {
      $("hudGesture").textContent = `手势：${name === "--" ? "--" : name + " " + (score).toFixed(2)}`;
    },
  });
  hand._onMaskSwitch = (idx) => switchTo(idx);
  hand.modLength = defs.length;

  bindUI();
  bindEditableText();

  introStatus.textContent = "初始化手势引擎…";
  await hand.init((s) => (introStatus.textContent = s));

  introStatus.textContent = "就绪";
  $("startBtn").disabled = false;
  // ?view=1 直达观赏模式(展陈/无头截图用)
  if (new URLSearchParams(location.search).get("view") === "1") {
    $("intro").classList.add("hide");
  }
}

async function ensureGeometry(def) {
  if (geoCache.has(def.key)) return geoCache.get(def.key);
  let geo;
  if (def.blob) {
    const { parsePLY } = await import("./modelConvert.js");
    // user 模型存的是原始 PLY Blob
    geo = parsePLY(await def.blob.arrayBuffer());
  } else {
    ({ geometry: geo } = await loadBPC(def.url));
  }
  geoCache.set(def.key, geo);
  // 缓存上限 8 个
  if (geoCache.size > 8) {
    const first = geoCache.keys().next().value;
    if (first !== def.key && first !== defs[currentModelIndex]?.key) geoCache.delete(first);
  }
  return geo;
}

async function switchTo(idx) {
  idx = ((idx % defs.length) + defs.length) % defs.length;
  if (idx === currentModelIndex && stage.current) return;
  currentModelIndex = idx;
  const def = defs[idx];
  $("hudModel").textContent = `模型 ${def.name} / ${defs.length}`;
  await stage.transitionTo(ensureGeometry, defs, idx, 1000);
  // 预载邻近
  ensureGeometry(defs[(idx + 1) % defs.length]).catch(() => {});
}

// ---------- 手部骨架小视图 ----------
function drawHandView() {
  const cv = $("handCanvas");
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  const lm = hand?.state.landmarks;
  if (lm) {
    const X = (p) => (1 - p.x) * cv.width;
    const Y = (p) => p.y * cv.height;
    ctx.strokeStyle = "rgba(217,176,108,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(X(lm[a]), Y(lm[a]));
      ctx.lineTo(X(lm[b]), Y(lm[b]));
    }
    ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(X(p), Y(p), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- 主循环 ----------
let lastT = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (hand) {
    stage.setDisp(hand.getDisp());
    stage.update(dt, hand.getRotation());
  } else {
    // 无手状态也保持自转
    stage.update(dt, { rx: 0, ry: (performance.now() / 1000) * THREE_D2R * (cfg.spinSpeed ?? 21) });
  }
  drawHandView();
  requestAnimationFrame(tick);
}
const THREE_D2R = Math.PI / 180;

// ---------- UI ----------
function bindUI() {
  $("startBtn").addEventListener("click", async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      hand.video = video;
      await hand.start(video);
    } catch (e) {
      introStatus.textContent = "摄像头启动失败: " + e.message + "（可改用观赏模式）";
      return;
    }
    $("intro").classList.add("hide");
  });
  $("startNoCam").addEventListener("click", () => {
    $("intro").classList.add("hide");
  });

  // 设置面板
  $("gearBtn").addEventListener("click", () => $("panel").classList.toggle("open"));
  $("panelClose").addEventListener("click", () => $("panel").classList.remove("open"));

  const bind = (id, key, isNum = false, cb) => {
    const el = $(id);
    el.value = cfg[key];
    const label = $(id + "V");
    if (label) label.textContent = isNum ? Number(cfg[key]).toFixed(isNum === 2 ? 2 : 1) : cfg[key];
    el.addEventListener("input", () => {
      cfg[key] = isNum ? Number(el.value) : el.value;
      if (label) label.textContent = isNum ? Number(el.value).toFixed(isNum === 2 ? 2 : 1) : el.value;
      saveCfg();
      applyCfg();
      cb?.(cfg[key]);
    });
    cb?.(cfg[key]);
  };
  bind("spinSpeed", "spinSpeed", 1, (v) => { if (hand) hand.cfg.spinSpeed = v; });
  bind("rotSens", "rotSens", 2, (v) => { if (hand) hand.cfg.rotSens = v; });
  bind("smooth", "smooth", 1, (v) => { if (hand) hand.cfg.smoothTau = v * 0.5; });
  bind("dispPower", "dispPower", 2, (v) => { stage.params.dispPower = v; });
  bind("pointSize", "pointSize", 2, (v) => {
    stage.params.pointSize = v;
    for (const m of [stage.current, stage.incoming]) if (m) m.points.material.uniforms.uPointSize.value = v;
  });
  bind("cfgTitle", "title");
  bind("cfgSideEn", "sideEn");
  bind("cfgSideZh", "sideZh");
  bind("cfgFont", "font");
  bind("cfgTitleSize", "titleSize", 1);
  bind("cfgColor", "color");
  $("cfgTextVisible").checked = cfg.textVisible;
  $("cfgTextVisible").addEventListener("change", (e) => {
    cfg.textVisible = e.target.checked;
    saveCfg();
    applyCfg();
  });

  // 模型上传
  $("addModelBtn").addEventListener("click", () => $("addModelFile").click());
  $("addModelFile").addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      introStatusFn(`转换 ${file.name}…`);
      try {
        const geo = await parseModelFile(file, 400000);
        const def = await store.addUserModel(file.name.replace(/\.[^.]+$/, ""), file, geo.getAttribute("position").count);
        defs = store.defs;
        // 缓存已有几何,直接可用
        geoCache.set(def.key, geo);
        $("hudModel").textContent = `已添加 ${def.name}（捏合切换到它）`;
        renderModelList();
      } catch (err) {
        alert("模型导入失败: " + err.message);
      }
    }
    e.target.value = "";
  });

  store.onChange((d) => {
    defs = d;
    if (hand) hand.modLength = defs.length;
    renderModelList();
  });
  renderModelList();

  // 点击面具直接切换(无摄像头时的替代操作)
  $("stage").addEventListener("click", () => {
    if (!hand?.state.handPresent) switchTo(currentModelIndex + 1);
  });
}

function introStatusFn(s) { $("hudModel").textContent = s; }

function renderModelList() {
  const ul = $("modelList");
  ul.innerHTML = "";
  defs.forEach((d, i) => {
    const li = document.createElement("li");
    if (i === currentModelIndex) li.classList.add("current");
    const name = document.createElement("span");
    name.className = "m-name";
    name.textContent = d.name + (d.type === "user" ? " （自定义）" : "");
    const info = document.createElement("span");
    info.className = "m-info";
    info.textContent = d.count >= 1000 ? (d.count / 1000).toFixed(0) + "k" : d.count;
    li.append(name, info);
    const show = document.createElement("button");
    show.textContent = "查看";
    show.onclick = () => switchTo(i);
    if (d.type === "user") {
      const del = document.createElement("button");
      del.textContent = "删除";
      del.onclick = async () => {
        await store.removeUserModel(d.key);
        defs = store.defs;
        if (currentModelIndex >= defs.length) currentModelIndex = 0;
        await switchTo(currentModelIndex);
        renderModelList();
        $("hudModel").textContent = `模型 ${defs[currentModelIndex]?.name ?? "--"} / ${defs.length}`;
      };
      li.append(del);
    }
    li.append(show);
    ul.appendChild(li);
  });
}

// ---------- 双击直接编辑文案 ----------
function bindEditableText() {
  const title = $("titleText");
  const en = document.querySelector(".side-en");
  const zh = document.querySelector(".side-zh");
  for (const [el, key] of [[title, "title"], [en, "sideEn"], [zh, "sideZh"]]) {
    el.contentEditable = "true";
    el.addEventListener("blur", () => {
      cfg[key] = key === "sideEn" ? el.textContent.replace(/\n/g, " ") : el.textContent.trim();
      saveCfg();
      $("cfgTitle").value = cfg.title;
      $("cfgSideEn").value = cfg.sideEn;
      $("cfgSideZh").value = cfg.sideZh;
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && key !== "sideEn") { e.preventDefault(); el.blur(); }
    });
  }
}

main()
  .then(() => tick())
  .catch((e) => {
    introStatus.textContent = "启动失败: " + e.message + " @ " + (e.stack ?? "").split("\n")[1];
    console.error(e);
  });
