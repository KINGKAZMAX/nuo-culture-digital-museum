// 傩文化数字博物馆 Nuo Culture Digital Museum — 手势交互点云数字展馆
// 结构: Stage(Three.js 渲染) + HandControl(MediaPipe 手势) + ModelStore + 文案层
import { Stage } from "./scene.js";
import { HandControl, HAND_CONNECTIONS } from "./handControl.js";
import { ModelStore } from "./modelStore.js";
import { parseModelFile } from "./modelConvert.js";
import { loadBPC } from "./pointCloud.js";

const $ = (id) => document.getElementById(id);

// ---------- 持久化配置 ----------
const LS_KEY = "nuo-mask-cfg-v3";
const defaultCfg = {
  title: "贵傩戏-傩文化数字博物馆",
  sideEn: "NUO CULTURE DIGITAL MUSEUM",
  sideZh: "民俗 · 仪式 · 戏面",
  font: "Liu Jian Mao Cao",
  titleSize: 176,
  color: "#141414",
  textVisible: true,
  spinSpeed: 6,
  rotSens: 1,
  smooth: 1,
  dispPower: 2,
  pointSize: 1.15,
  music: true,
  musicVolume: 0.45,
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
    "Liu Jian Mao Cao": "./fonts/liu-jian-mao-cao/index.css",
    "Zhi Mang Xing": "./fonts/zhi-mang-xing/index.css",
    "Long Cang": "./fonts/long-cang/index.css",
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
  title.style.fontFamily = `'${cfg.font}', 'Liu Jian Mao Cao', 'Kaiti SC', 'STKaiti', serif`;
  title.style.fontSize = `calc(${cfg.titleSize} / 12.5 * 1vmin)`;
  title.style.color = cfg.color;
  title.style.textShadow = "none"; // 宣纸底不用辉光
  document.querySelector(".side-en").textContent = cfg.sideEn.replace(/\s+/g, "\n");
  document.querySelector(".side-zh").textContent = cfg.sideZh;
  document.documentElement.style.setProperty("--gold", cfg.color);
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

  // 水墨展厅: 全量加载所有面具,弧形同屏陈列
  window.__step = "all-models";
  const geos = await Promise.all(defs.map((d) => ensureGeometry(d).catch(() => null)));
  stage.showAllModels(defs, geos);
  stage.focusIndex(0);
  // 异步预编译着色器,消除首次交互的编译卡顿(three 内置 KHR_parallel_shader_compile)
  stage.renderer.compileAsync(stage.scene, stage.camera).catch(() => {});

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
  updateExhibitUI(0);

  introStatus.textContent = "初始化手势引擎…";
  await hand.init((s) => (introStatus.textContent = s));

  // 无进入界面:就绪后加载纱幕自动淡出,直接进展厅
  // (加载期间纱幕仅显示状态文本,无按钮)
  $("intro").classList.add("hide");
  $("hudTip").textContent = "五面同屏 · 单击/捏合转台换展品 · 拖拽旋转 · 滚轮缩放 · 握拳爆散 · 双击文字可编辑";
}

// 顶栏展品编号/名称 + 底栏页码/刻度联动
function updateExhibitUI(idx) {
  const def = defs[idx];
  if (!def) return;
  const no = String(idx + 1).padStart(2, "0");
  const noEl = document.querySelector(".exhibit-no");
  const nameEl = document.querySelector(".exhibit-name");
  if (noEl) noEl.textContent = no;
  if (nameEl) nameEl.textContent = def.name;
  const b = document.querySelector(".pager-num b");
  const total = document.querySelectorAll(".pager-num span")[1];
  if (b) b.textContent = no;
  if (total) total.textContent = String(defs.length).padStart(2, "0");
  document.querySelectorAll(".pager-seg").forEach((seg, i) => {
    seg.classList.toggle("is-current", i === idx);
  });
  $("hudModel").textContent = `展品 ${def.name} · ${idx + 1} / ${defs.length}`;
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
  if (idx === currentModelIndex && stage.models?.length) return;
  currentModelIndex = idx;
  stage.focusIndex(idx);
  updateExhibitUI(idx);
}

// 馆藏变化(上传/删除)后重建弧形陈列
function rebuildGallery() {
  const geos = defs.map((d) => geoCache.get(d.key) ?? null);
  stage.showAllModels(defs, geos);
  stage.focusIndex(currentModelIndex);
  renderModelList();
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
    ctx.strokeStyle = "rgba(220,220,220,.35)";
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
// 用户拖拽旋转(叠加在手势/自转之上) + 惯性
const userRot = { rx: 0, ry: 0, vx: 0, vy: 0 };
let lastT = performance.now();
// 自适应画质(借 drei PerformanceMonitor 算法思路): FPS 跌破阈值阶梯降 DPR
const perfMon = { avg: 60, samples: 0, level: 0, lastChange: 0 };
const PR_STEPS = [null, 1.75, 1.5, 1.25, 1]; // level 0 = 设备原生(≤2)
function applyPR() {
  const target = PR_STEPS[perfMon.level];
  stage._targetPR = target ? Math.min(target, window.devicePixelRatio || 1) : Math.min(window.devicePixelRatio || 1, 2);
  stage._resize();
}
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  // FPS 监测(标签页可见才有效,避免后台节流误降档)
  if (dt > 0 && !document.hidden) {
    const fps = 1 / dt;
    perfMon.avg = perfMon.avg * 0.95 + fps * 0.05;
    if (now - perfMon.lastChange > 4000) {
      if (perfMon.avg < 42 && perfMon.level < PR_STEPS.length - 1) {
        perfMon.level++; applyPR(); perfMon.lastChange = now;
      } else if (perfMon.avg > 57 && perfMon.level > 0) {
        perfMon.level--; applyPR(); perfMon.lastChange = now;
      }
    }
  }
  // 拖拽惯性衰减(较快收敛,避免点击后长时间快转)
  userRot.vx *= Math.exp(-dt * 5.0);
  userRot.vy *= Math.exp(-dt * 5.0);
  userRot.ry += userRot.vx * dt;
  userRot.rx += userRot.vy * dt;
  userRot.rx = Math.max(-1.1, Math.min(1.1, userRot.rx));
  if (hand?.running) {
    stage.setDisp(hand.getDisp());
    const rot = hand.getRotation();
    stage.setZoom(hand.getZoom());
    stage.update(dt, { rx: rot.rx + userRot.rx, ry: rot.ry + userRot.ry });
  } else {
    // 无手状态也保持自转
    stage.update(dt, { rx: userRot.rx, ry: (performance.now() / 1000) * THREE_D2R * (cfg.spinSpeed ?? 12) + userRot.ry });
  }
  drawHandView();
  requestAnimationFrame(tick);
}
const THREE_D2R = Math.PI / 180;

// ---------- 键盘快捷键 ----------
// ←/→ 切面具 · 空格 暂停/恢复自转 · 0 复位视角与缩放
(function bindKeys() {
  let spinPaused = false;
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    if (e.key === "ArrowRight") {
      switchTo(currentModelIndex + 1);
    } else if (e.key === "ArrowLeft") {
      switchTo(currentModelIndex - 1);
    } else if (e.key === " ") {
      e.preventDefault();
      spinPaused = !spinPaused;
      if (spinPaused) {
        cfg.spinSpeedBak = cfg.spinSpeed ?? 12;
        cfg.spinSpeed = 0;
      } else {
        cfg.spinSpeed = cfg.spinSpeedBak ?? 12;
      }
      if (hand) hand.cfg.spinSpeed = cfg.spinSpeed;
      const el = $("spinSpeed"); if (el) el.value = cfg.spinSpeed;
      const lab = $("spinSpeedV"); if (lab) lab.textContent = cfg.spinSpeed;
    } else if (e.key === "0") {
      stage.setZoom(1);
      userRot.rx = 0; userRot.ry = 0; userRot.vx = 0; userRot.vy = 0;
    }
  });
})();

// ---------- 拖拽旋转 / 滚轮与双指缩放 ----------
(function bindViewControls() {
  const cv = $("stage");
  const pointers = new Map();
  let dragging = false, moved = 0, lastPinch = 0;
  cv.style.touchAction = "none";
  cv.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { dragging = true; moved = 0; }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  window.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1 && dragging) {
      moved += Math.abs(dx) + Math.abs(dy);
      userRot.vx += dx * 7;
      userRot.vy += dy * 5;
      // 限位: 点击/快速甩动也不会导致高速旋转
      userRot.vx = Math.max(-2.2, Math.min(2.2, userRot.vx));
      userRot.vy = Math.max(-1.6, Math.min(1.6, userRot.vy));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0 && d > 0) {
        stage.setZoom(stage.getZoom() * (d / lastPinch));
      }
      lastPinch = d;
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) dragging = false;
    lastPinch = 0;
  };
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    stage.setZoom(stage.getZoom() * Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });
  // 单击(非拖拽)才切面具
  cv.addEventListener("click", (e) => {
    if (moved > 6) return;
    if (!hand?.state.handPresent) switchTo(currentModelIndex + 1);
  });
})();

// ---------- UI ----------
function bindUI() {
  // 无进入界面:加载完成后自动进展厅;BGM 由首次任意交互触发(自动播放策略)
  // 摄像头改为设置面板开关(见下方 camEnabled 绑定)

  // ---------- BGM 背景音乐 ----------
  let bgmEl = null;
  function startBgm() {
    if (bgmEl || !cfg.music) return;
    bgmEl = new Audio("./audio/bgm.mp3");
    bgmEl.loop = true;
    bgmEl.volume = cfg.musicVolume ?? 0.45;
    bgmEl.play().then(() => {
      window.__bgm = bgmEl;
      const t = $("musicToggle");
      if (t) { t.checked = true; t.disabled = false; }
    }).catch((e) => console.warn("BGM 播放失败", e));
  }
  window.__startBgm = startBgm;
  const onceGesture = () => {
    startBgm();
    initVoice();
    window.removeEventListener("pointerdown", onceGesture);
    window.removeEventListener("keydown", onceGesture);
  };
  window.addEventListener("pointerdown", onceGesture);
  window.addEventListener("keydown", onceGesture);

  // ---------- 摄像头(设置面板开关) ----------
  async function startCamera() {
    if (hand?.running) return;
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
      $("hudGesture").textContent = "手势：已开启";
    } catch (e) {
      $("camEnabled").checked = false;
      $("hudGesture").textContent = "摄像头不可用: " + e.message;
    }
  }
  function stopCamera() {
    $("handView").classList.add("off");
    if (!hand?.running) return;
    hand.stop();
    const v = hand.video;
    if (v?.srcObject) {
      for (const track of v.srcObject.getTracks()) track.stop();
      v.srcObject = null;
    }
    $("hudGesture").textContent = "手势：--";
  }
  $("camEnabled").addEventListener("change", async (e) => {
    if (e.target.checked) {
      $("handView").classList.remove("off");
      await startCamera();
    } else {
      stopCamera();
    }
  });

  // ---------- 语音科普 ----------
  let voiceInited = false;
  async function initVoice() {
    if (voiceInited) return;
    voiceInited = true;
    try {
      const m = await import("./voice/voice.js");
      m.initVoiceGuide();
      window.__voiceReady = true;
    } catch (e) {
      console.warn("语音模块不可用", e);
    }
  }

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
    stage.setPointSizeAll(v);
  });
  $("musicToggle").addEventListener("change", (e) => {
    cfg.music = e.target.checked;
    saveCfg();
    const bgm = window.__bgm;
    if (bgm) {
      if (cfg.music) bgm.play().catch(() => {});
      else bgm.pause();
    }
  });
  const mv = $("musicVolume");
  mv.value = cfg.musicVolume ?? 0.45;
  $("musicVolumeV").textContent = Number(mv.value).toFixed(2);
  mv.addEventListener("input", () => {
    cfg.musicVolume = Number(mv.value);
    $("musicVolumeV").textContent = cfg.musicVolume.toFixed(2);
    saveCfg();
    if (window.__bgm) window.__bgm.volume = cfg.musicVolume;
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
        rebuildGallery();
        $("hudModel").textContent = `已入馆 ${def.name}`;
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
  // 点击切换已由 bindViewControls 的拖拽判顶逻辑接管(拖动>6px 不切)
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
        rebuildGallery();
        switchTo(currentModelIndex);
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
