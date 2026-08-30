// AR 面具试戴: 摄像头人脸五官绑定 + 傩面具点云实时叠加
// 纯 canvas 2D 投影渲染(不依赖 three.js), 自建 UI, 可独立接入。
//
// ---- 数据钩子(由主代理提供) ----
//   window.__getMaskCloud() -> { positions:Float32Array(n*3), colors:Float32Array(n*3), count }
//     positions: TDPC 原始坐标 —— x/z 已居中(约 ±1.3), y 为 0..2.67(底部 0 / 顶部 2.67),
//                面部朝 +z。本模块抽样时归一: y -= 1.35 居中后三轴统一 /2.67(保持比例)。
//     colors: linear 空间(做过 pow 2.2), 绘制前转 sRGB: pow(c, 1/2.2)。
//     面具切换后返回新的对象引用即可, 本模块按引用变化自动重抽样。
//   window 'ar-switch'  { detail: +1 | -1 } —— 手势层派发的切换指令(仅 AR 打开时响应)。
//
// ---- 本模块对外派发 ----
//   window 'ar-mask-switch' { detail:{ delta:+1|-1 } } —— 请求切换面具(左右半屏点击 / ar-switch 转发)
//   window 'ar-mask-change' { detail:{ open:boolean } } —— AR 模式开关通知
//
// ---- 渲染原理(2D 投影近似) ----
//   取 478 点中的左/右外眼角(263/33)、鼻尖(1)、下巴(152) 四个锚点映射到屏幕(镜像 + cover 裁切),
//   两眼外角间距 W -> 面具宽度 = 1.9*W; 中心 = 眼中点向鼻尖方向 35%; 旋转 = atan2(眼轴);
//   每点: 屏幕 = 中心 + R(ang)·(x*s*k, -y*s*k), k = 1 + z*0.06 做轻透视(鼻尖更近更大);
//   z<0(脸后)的点 alpha×0.35。65k 点抽样到 ~12000, ImageData 手写像素 + 脏区提交,
//   叠加写入实现 additive 发光感, 全程无 fillStyle 字符串开销。
import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

// ---------------- 常量 ----------------
const BTN_ID = "ar-mask-btn";
const TARGET_POINTS = 24000; // 抽样目标点数(ImageData 直写,脏区提交,可承载)
const Y_OFFSET = 1.35; // TDPC y 0..2.67 -> 居中
// One Euro Filter(R5): 静止消抖、快速运动自适应减滞后
class OneEuro {
  constructor(minCutoff = 1, beta = 0.02, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff, xp: null, dxp: 0, tp: 0 });
  }
  reset() { this.xp = null; this.dxp = 0; }
  alpha(fc, dt) { const tau = 1 / (2 * Math.PI * fc); return 1 / (1 + tau / dt); }
  f(t, x) {
    if (this.xp === null) { this.xp = x; this.tp = t; return x; }
    const dt = Math.max(1e-3, (t - this.tp) / 1000); this.tp = t;
    const dx = (x - this.xp) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxh = aD * dx + (1 - aD) * this.dxp; this.dxp = dxh;
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(dxh), dt);
    return (this.xp = a * x + (1 - a) * this.xp);
  }
}

const NORM_DIV = 2.67; // 三轴统一除数(保持比例)
// MediaPipe FaceMesh 锚点索引
const IDX_EYE_R = 33; // 右眼外角(镜像显示后位于屏幕右侧)
const IDX_EYE_L = 263; // 左眼外角(镜像显示后位于屏幕左侧)
const IDX_NOSE = 1; // 鼻尖
const IDX_CHIN = 152; // 下巴(几何合理性校验用)
const IDX_FOREHEAD = 10; // 额头顶(全覆盖: 面具高度跨额头-下巴)
const IDX_TEMPLE_L = 127; // 太阳穴(R1: 面部最宽 127<->356)
const IDX_TEMPLE_R = 356;
const MASK_FACE_RATIO = 2.05; // 面具宽 ≈ 2.05 × 两眼外角间距(完全盖脸)
const CENTER_T = 0.35; // 备用: 眼-鼻锚点中心
const SMOOTH_TAU = 0.09; // 中心/缩放/角度指数平滑时间常数(s)
const FACE_LOST_MS = 450; // 丢脸宽限(防眨眼闪烁)
const BASE_ALPHA = 0.85; // 点基础透明度
const BACK_ALPHA = 0.85 * 0.35; // z<0(脸后)的点 ×0.35
const TIP_DEFAULT = "AR 试戴中 · 左半屏上一个 / 右半屏下一个";

// ---------------- 模块状态 ----------------
let button = null;
let session = null; // 打开中的会话(DOM / 流 / 渲染状态)
let opening = false; // open() 进行中防重入
let landmarker = null; // 跨开关复用, 不重复加载模型
let landmarkerPromise = null;
const switchCbs = new Set(); // 主代理注册的切面具回调

// ---------------- 小工具 ----------------
function makeEl(tag, css) {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  return el;
}
function setBtnText(t, restoreMs = 0) {
  if (!button) return;
  button.textContent = t;
  if (restoreMs > 0) {
    setTimeout(() => {
      if (session?.running) button.textContent = "退出 AR";
      else button.textContent = "AR 试戴";
    }, restoreMs);
  } else {
    button.textContent = session?.running ? "退出 AR" : t;
  }
}

// ---------------- 对外接口 ----------------
export function initARMask() {
  if (window.__arMask) return window.__arMask; // 幂等
  ensureButton();
  // 手势层派发的滑动切换(仅 AR 打开时生效)
  window.addEventListener("ar-switch", (e) => {
    const d = Number(e && e.detail);
    if (session && session.running && (d === 1 || d === -1)) requestSwitch(d);
  });
  // 窗口尺寸变化时画布跟随
  window.addEventListener("resize", () => {
    if (session && session.running) resizeCanvas(session);
  });
  const handle = {
    open: openAR,
    close: closeAR,
    toggle: toggleAR,
    isOn: () => !!(session && session.running),
    // 主代理可直接注册切面具回调: onSwitch((delta)=>{...}), 返回解绑函数
    onSwitch: (cb) => {
      if (typeof cb === "function") {
        switchCbs.add(cb);
        return () => switchCbs.delete(cb);
      }
      return () => {};
    },
  };
  window.__arMask = handle;
  return handle;
}

function toggleAR() {
  if (session && session.running) closeAR();
  else openAR();
}

// ---------------- 自建 UI ----------------
function ensureButton() {
  if (button && document.getElementById(BTN_ID)) return button;
  button = makeEl(
    "button",
    [
      "position:fixed;right:16px;bottom:80px;z-index:40", // 避开右下角语音按钮(bottom:16)
      "padding:10px 18px;border:1px solid rgba(255,255,255,0.38);border-radius:999px",
      "background:rgba(10,13,20,0.72);color:#fff;font-size:13px;letter-spacing:2px",
      "cursor:pointer;outline:none;user-select:none;-webkit-user-select:none;touch-action:manipulation",
      "backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)",
      "transition:background .2s ease,border-color .2s ease",
    ].join(";")
  );
  button.id = BTN_ID;
  button.type = "button";
  button.textContent = "AR 试戴";
  button.addEventListener("click", toggleAR);
  button.addEventListener("mouseenter", () => {
    if (session?.running) button.style.background = "rgba(34,40,58,0.85)";
    else button.style.background = "rgba(28,33,48,0.85)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "rgba(10,13,20,0.72)";
  });
  document.body.appendChild(button);
  return button;
}

function buildDom(s) {
  // 摄像头画面: 镜像 + cover 全屏, 盖住 3D canvas(z 5), 位于其它 UI 之下
  const video = makeEl(
    "video",
    "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);z-index:5;background:#000"
  );
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.srcObject = s.stream;
  video.play().catch(() => {}); // 个别浏览器需显式 play

  // 面具点云叠加层(z 6, 透明; 兼作左右半屏点击热区)
  const canvas = makeEl(
    "canvas",
    "position:fixed;inset:0;width:100%;height:100%;z-index:6;cursor:pointer;touch-action:manipulation"
  );
  canvas.addEventListener("click", (e) => {
    if (!s.running) return;
    requestSwitch(e.clientX < window.innerWidth / 2 ? -1 : 1);
  });

  // 顶部提示条(z 7): 状态文案 + 返回按钮
  const bar = makeEl(
    "div",
    [
      "position:fixed;top:0;left:0;right:0;z-index:7",
      "display:flex;align-items:center;justify-content:space-between;gap:12px",
      "padding:10px 16px;background:rgba(8,10,14,0.55)",
      "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)",
      "color:#fff;font-size:13px;letter-spacing:1px;user-select:none;-webkit-user-select:none",
    ].join(";")
  );
  const tip = makeEl("span", "white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
  const back = makeEl(
    "button",
    "flex:none;padding:6px 14px;border:1px solid rgba(255,255,255,0.4);border-radius:999px;" +
      "background:rgba(255,255,255,0.08);color:#fff;font-size:12px;letter-spacing:2px;cursor:pointer"
  );
  back.type = "button";
  back.textContent = "返回";
  back.addEventListener("click", () => closeAR());
  const shutter = makeEl(
    "button",
    "flex:none;padding:6px 14px;border:1px solid rgba(255,255,255,0.4);border-radius:999px;" +
      "background:rgba(255,255,255,0.08);color:#fff;font-size:12px;letter-spacing:2px;cursor:pointer"
  );
  shutter.type = "button";
  shutter.textContent = "拍照打卡";
  shutter.addEventListener("click", () => captureCheckin(s));
  bar.appendChild(tip);
  bar.appendChild(shutter);
  bar.appendChild(back);
  document.body.appendChild(video);
  document.body.appendChild(canvas);
  document.body.appendChild(bar);

  s.video = video;
  s.canvas = canvas;
  s.ctx = canvas.getContext("2d", { alpha: true });
  s.bar = bar;
  s.tip = tip;
  s.tipText = "";
}

function cleanupDom(s) {
  for (const k of ["video", "canvas", "bar"]) {
    const el = s[k];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    s[k] = null;
  }
}

function stopStream(s) {
  const st = s.stream;
  if (!st) return;
  if (s.shared) {
    // 共享手势模块的流: 不停轨道(手势交互仍需它), 只解除引用
    s.stream = null;
    return;
  }
  try {
    for (const track of st.getTracks()) track.stop();
  } catch (e) {
    /* track 可能已停止 */
  }
  s.stream = null;
}

// ---------------- FaceLandmarker ----------------
async function ensureLandmarker() {
  if (landmarker) return landmarker;
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      // 相对路径按 document.baseURI 解析(与 handControl.js 一致)
      const fileset = await FilesetResolver.forVisionTasks("./mediapipe/wasm");
      const opts = (delegate) => ({
        baseOptions: {
          modelAssetPath: "./mediapipe/models/face_landmarker.task",
          delegate,
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFacialTransformationMatrixes: true, // 头部姿态矩阵(备用/调试)
      });
      try {
        landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
      } catch (e) {
        console.warn("[arMask] GPU 不可用, 回退 CPU:", e);
        landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
      }
      return landmarker;
    })().catch((e) => {
      landmarkerPromise = null; // 允许下次重试
      throw e;
    });
  }
  return landmarkerPromise;
}

// ---------------- 开 / 关 ----------------
async function openAR() {
  if (session || opening) return;
  opening = true;
  setBtnText("启动中…");
  let stream = null;
  let shared = false;
  // R6: iOS 同一摄像头只允许一路活跃流 —— 优先复用手势模块的流(同 video 喂两个 task 合法)
  const handVideo = window.__handVideo;
  if (handVideo && handVideo.srcObject && handVideo.readyState >= 2 && !handVideo.paused) {
    stream = handVideo.srcObject;
    shared = true;
  }
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      console.warn("[arMask] 摄像头不可用:", e);
      setBtnText("摄像头不可用", 2600);
      opening = false;
      return;
    }
  }
  const s = {
    stream,
    shared, // true=复用手势流,关闭时不停止轨道
    running: false,
    raf: 0,
    result: null,
    lastVideoTime: -1,
    lastT: 0,
    cloud: null, // 缓存的面具点云引用
    samp: null, // 抽样后的绘制数据
    cloudOk: false,
    sm: null, // 平滑后的 {cx,cy,s,ang}
    lastFaceSeen: -1e9,
    flashUntil: 0,
    img: null,
    buf: null,
    bw: 0,
    bh: 0,
    dpr: 1,
    ps: 2, // 点尺寸(后端像素)
    prev: null, // 上一帧脏区
  };
  session = s; // 立即占位, isOn() 生效, toggle 可打断
  try {
    buildDom(s);
    setTip(s, "AR 引擎加载中…");
    await ensureLandmarker();
    if (session !== s) return; // 打开过程中被关闭
    s.running = true;
    resizeCanvas(s);
    setTip(s, TIP_DEFAULT);
    setBtnText("退出 AR");
    window.dispatchEvent(new CustomEvent("ar-mask-change", { detail: { open: true } }));
    s.raf = requestAnimationFrame((t) => loop(s, t));
  } catch (e) {
    console.error("[arMask] 初始化失败:", e);
    if (session === s) {
      session = null;
      cleanupDom(s);
      stopStream(s);
      setBtnText("AR 启动失败", 2600);
      window.dispatchEvent(
        new CustomEvent("ar-mask-change", { detail: { open: false, error: String((e && e.message) || e) } })
      );
    }
  } finally {
    opening = false;
  }
}

function closeAR() {
  const s = session;
  if (!s) return;
  s.running = false;
  cancelAnimationFrame(s.raf);
  cleanupDom(s);
  stopStream(s);
  session = null;
  setBtnText("AR 试戴");
  window.dispatchEvent(new CustomEvent("ar-mask-change", { detail: { open: false } }));
}

// ---------------- 画布尺寸 ----------------
function resizeCanvas(s) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  s.dpr = dpr;
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
    s.img = s.ctx.createImageData(w, h);
    s.buf = s.img.data;
  }
  s.bw = w;
  s.bh = h;
  s.ps = Math.max(2, Math.min(4, Math.round(1.6 * dpr))); // 视觉约 1.6 CSS px
}

// ---------------- 面具点云抽样(引用变化时重算) ----------------
function refreshCloud(s) {
  const fn = window.__getMaskCloud;
  let c = null;
  if (typeof fn === "function") {
    try {
      c = fn();
    } catch (e) {
      /* 主代理侧异常, 视为未就绪 */
    }
  }
  const P = c && c.positions;
  const n = P ? Math.floor(c.count || P.length / 3) : 0;
  s.cloudOk = !!(P && P.length >= n * 3 && n >= 256);
  if (!s.cloudOk || c === s.cloud) return;
  s.cloud = c;
  const C = c.colors || null;
  const stride = Math.max(1, Math.round(n / TARGET_POINTS));
  const m = Math.ceil(n / stride);
  const px = new Float32Array(m);
  const py = new Float32Array(m);
  const pz = new Float32Array(m);
  const col = new Uint8ClampedArray(m * 3);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < m; j++) {
    const i = j * stride * 3;
    // 归一: y 0..2.67 -> 居中, 三轴统一 /2.67
    const x = P[i] / NORM_DIV;
    const y = (P[i + 1] - Y_OFFSET) / NORM_DIV;
    const z = P[i + 2] / NORM_DIV;
    px[j] = x;
    py[j] = y;
    pz[j] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (C && C.length >= (j * stride + 1) * 3) {
      col[j * 3] = toSrgbByte(C[i]);
      col[j * 3 + 1] = toSrgbByte(C[i + 1]);
      col[j * 3 + 2] = toSrgbByte(C[i + 2]);
    } else {
      col[j * 3] = 222; // 无颜色时的暖白兜底
      col[j * 3 + 1] = 202;
      col[j * 3 + 2] = 168;
    }
  }
  s.samp = { px, py, pz, col, m, width: Math.max(0.001, maxX - minX), height: Math.max(0.001, maxY - minY) };
}

// linear -> sRGB 字节(轻提亮, 配合 additive 发光感)
function toSrgbByte(v) {
  const c = Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2);
  return Math.min(255, c * 255 * 1.05 + 8);
}

// ---------------- 主循环 ----------------
function loop(s, t) {
  if (!s.running) return;
  s.raf = requestAnimationFrame((tt) => loop(s, tt));
  try {
    const v = s.video;
    if (v && v.readyState >= 2 && landmarker && v.currentTime !== s.lastVideoTime) {
      s.lastVideoTime = v.currentTime;
      s.result = landmarker.detectForVideo(v, performance.now());
    }
    render(s, t);
  } catch (e) {
    console.warn("[arMask] 帧处理异常:", e);
  }
}

// landmark 归一化坐标 -> 画布像素(镜像 + object-fit:cover 裁切补偿)
function mapLm(s, lm, out) {
  const vw = s.video.videoWidth || 1280;
  const vh = s.video.videoHeight || 720;
  const k = Math.max(s.bw / vw, s.bh / vh);
  const dw = vw * k;
  const dh = vh * k;
  const ox = (s.bw - dw) / 2;
  const oy = (s.bh - dh) / 2;
  out.x = s.bw - (ox + lm.x * dw); // scaleX(-1) 镜像
  out.y = oy + lm.y * dh;
  return out;
}

function render(s, now) {
  refreshCloud(s);
  const lm = s.result && s.result.faceLandmarks && s.result.faceLandmarks[0];
  const hasCloud = s.cloudOk && !!s.samp;
  if (!lm) window.__arDbg = { lm: 0, lost, hasCloud };
  if (lm) s.lastFaceSeen = now;
  const lost = now - s.lastFaceSeen > FACE_LOST_MS;
  // 长丢后重置滤波器, 防旧状态缓慢爬升(R5)
  if (lost && s.oe) { for (const k of Object.keys(s.oe)) s.oe[k].reset(); s.sm = null; }

  // 顶部提示文案(闪现文案优先)
  if (now < s.flashUntil) {
    /* 保留闪现文案 */
  } else {
    setTip(s, !hasCloud ? "面具数据未就绪" : lost ? "未检测到人脸 · 请正对镜头" : TIP_DEFAULT);
  }

  // 1) 清掉上一帧脏区(只动了缓冲区, 稍后需 putImageData 提交)
  const cleared = s.prev || null;
  if (cleared) clearRegion(s, cleared);

  // 2) 有脸 + 有云 -> 更新平滑锚点并绘制
  let drawn = false;
  if (lm && !lost && hasCloud && s.video) {
    const L = mapLm(s, lm[IDX_EYE_L], { x: 0, y: 0 }); // 镜像后屏幕左侧
    const R = mapLm(s, lm[IDX_EYE_R], { x: 0, y: 0 }); // 镜像后屏幕右侧
    const N = mapLm(s, lm[IDX_NOSE], { x: 0, y: 0 });
    const CH = mapLm(s, lm[IDX_CHIN], { x: 0, y: 0 });
    const FH = mapLm(s, lm[IDX_FOREHEAD], { x: 0, y: 0 }); // 额头顶
    const TL = mapLm(s, lm[IDX_TEMPLE_L], { x: 0, y: 0 });
    const TR = mapLm(s, lm[IDX_TEMPLE_R], { x: 0, y: 0 });
    const Wpx = Math.hypot(R.x - L.x, R.y - L.y);
    const templeSpan = Math.hypot(TR.x - TL.x, TR.y - TL.y); // R1: 太阳穴=面部最宽
    const faceSpanY = Math.hypot(CH.x - FH.x, CH.y - FH.y); // 额头-下巴全脸高
    const faceH = CH.y - (L.y + R.y) / 2;
    // 几何合理性: 眼距/脸高过小视为误检, 本帧不更新
    window.__arDbg = { lm: 1, lost, hasCloud, Wpx: Math.round(Wpx), dpr: s.dpr, faceH: Math.round(faceH), faceSpanY: Math.round(faceSpanY), m: s.samp?.m, ps: s.ps, sm: s.sm ? { cx: Math.round(s.sm.cx), cy: Math.round(s.sm.cy), s: +s.sm.s.toFixed(3) } : null, bw: s.bw, bh: s.bh };
    if (Wpx >= 8 * s.dpr && faceH > 4 && faceSpanY > Wpx * 0.8) {
      // 双向拟合: 宽度(太阳穴间距×1.14, R1)与高度(全脸高×1.12)取小, 保证完全覆盖
      const sW = (Math.max(templeSpan * 1.14, Wpx * MASK_FACE_RATIO)) / s.samp.width;
      const sH = (faceSpanY * 1.12) / s.samp.height;
      const tx = {
        cx: (FH.x + CH.x) / 2, // 全脸几何中心(额头-下巴中点)
        cy: (FH.y + CH.y) / 2,
        s: Math.min(sW, sH),
        ang: Math.atan2(R.y - L.y, R.x - L.x), // 头部侧倾
      };
      // One Euro 滤波(R5): cx/cy/s 位置量, ang 角度量
      if (!s.oe) s.oe = { cx: new OneEuro(1.0, 0.02), cy: new OneEuro(1.0, 0.02), s: new OneEuro(0.8, 0.01), ang: new OneEuro(1.2, 0.05) };
      if (!s.sm) s.sm = { ...tx };
      else {
        s.sm.cx = s.oe.cx.f(now, tx.cx);
        s.sm.cy = s.oe.cy.f(now, tx.cy);
        s.sm.s = s.oe.s.f(now, tx.s);
        s.sm.ang = s.oe.ang.f(now, tx.ang);
      }
      // 完全覆盖点径(R3): d ≈ 2.8 × 平均点间距 = 2.8×sqrt(脸面积/点数)
      const faceArea = Wpx * Math.max(faceH, Wpx * 1.25) * 0.75;
      const meanGap = Math.sqrt(faceArea / Math.max(1, s.samp.m));
      s.ps = Math.max(2, Math.min(10, Math.round(2.8 * meanGap)));
      // yaw 侧转淡出(R9): 鼻尖偏离眼中点的水平比例作侧转代理
      const yawProxy = Math.abs(N.x - (L.x + R.x) / 2) / Math.max(1, Wpx);
      const yawTarget = Math.max(0.25, Math.min(1, 1 - (yawProxy - 0.5) / 0.35));
      s.yawFade = (s.yawFade ?? 1) * 0.8 + yawTarget * 0.2;
      drawn = paintPoints(s);
    }
  }
  // 3) 提交: 有绘制提交新脏区; 无绘制但清过旧区 -> 提交清空区, 避免 canvas 残留
  if (drawn) {
    s.ctx.putImageData(s.img, 0, 0, drawn.x0, drawn.y0, drawn.x1 - drawn.x0 + 1, drawn.y1 - drawn.y0 + 1);
    s.prev = drawn;
  } else if (cleared) {
    s.ctx.putImageData(s.img, 0, 0, cleared.x0, cleared.y0, cleared.x1 - cleared.x0 + 1, cleared.y1 - cleared.y0 + 1);
    s.prev = null;
  } else {
    s.prev = null;
  }
}

// 逐点写入 ImageData —— 预乘加权累积, 脏区归一化后以 source-over 语义叠加
// (完全覆盖: 多点重叠取加权平均色而非加色提亮, 亮背景不泛白)
function paintPoints(s) {
  const { px, py, pz, col, m } = s.samp;
  const sc = s.sm.s;
  const cx = s.sm.cx;
  const cy = s.sm.cy;
  const cosA = Math.cos(s.sm.ang);
  const sinA = Math.sin(s.sm.ang);
  const buf = s.buf;
  const bw = s.bw;
  const bh = s.bh;
  const ps = s.ps;
  const yawF = s.yawFade ?? 1; // 侧转淡出(R9)
  let x0 = bw;
  let y0 = bh;
  let x1 = -1;
  let y1 = -1;
  // 用 32 位浮点权重缓存更稳: 直接在 buf 上做两个 pass 太绕, 这里用并行 Float32 权重
  const wbuf = s.wbuf ?? (s.wbuf = new Float32Array(bw * bh * 4));
  for (let j = 0; j < m; j++) {
    const z = pz[j];
    const kk = 1 + z * 0.06; // 轻透视: +z(鼻尖方向)更近更大
    const lx = px[j] * sc * kk;
    const ly = -py[j] * sc * kk; // y 向上 -> 屏幕向上
    const X = cx + cosA * lx - sinA * ly;
    const Y = cy + sinA * lx + cosA * ly;
    const ix = X | 0;
    const iy = Y | 0;
    if (ix < -ps || iy < -ps || ix >= bw || iy >= bh) continue;
    const back = z < 0;
    const w = (back ? 0.38 : 0.96) * yawF; // 权重=不透明度
    const r = col[j * 3] * w;
    const g = col[j * 3 + 1] * w;
    const b = col[j * 3 + 2] * w;
    for (let dy = 0; dy < ps; dy++) {
      const yy = iy + dy;
      if (yy < 0 || yy >= bh) continue;
      for (let dx = 0; dx < ps; dx++) {
        const xx = ix + dx;
        if (xx < 0 || xx >= bw) continue;
        const o = (yy * bw + xx) * 4;
        wbuf[o] += r;
        wbuf[o + 1] += g;
        wbuf[o + 2] += b;
        wbuf[o + 3] += w;
        if (xx < x0) x0 = xx;
        if (xx > x1) x1 = xx;
        if (yy < y0) y0 = yy;
        if (yy > y1) y1 = yy;
      }
    }
  }
  if (x1 < x0) return null;
  // 归一化: 权重和 -> 不透明度; 颜色 -> 加权平均再预乘
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const o = (yy * bw + xx) * 4;
      const w = wbuf[o + 3];
      if (w <= 0.003) { buf[o] = buf[o+1] = buf[o+2] = buf[o+3] = 0; continue; }
      const a = Math.min(1, w);
      const c = a / w; // 归一化平均色 × 最终不透明度(预乘)
      buf[o] = wbuf[o] * c;
      buf[o + 1] = wbuf[o + 1] * c;
      buf[o + 2] = wbuf[o + 2] * c;
      buf[o + 3] = a * 255;
      wbuf[o] = wbuf[o+1] = wbuf[o+2] = wbuf[o+3] = 0; // 清权重缓存
    }
  }
  return { x0, y0, x1, y1 };
}

function clearRegion(s, d) {
  const x0 = Math.max(0, d.x0);
  const y0 = Math.max(0, d.y0);
  const x1 = Math.min(s.bw - 1, d.x1);
  const y1 = Math.min(s.bh - 1, d.y1);
  if (x1 < x0 || y1 < y0) return;
  const buf = s.buf;
  const bw = s.bw;
  const start = x0 * 4;
  const len = (x1 - x0 + 1) * 4;
  for (let y = y0; y <= y1; y++) buf.fill(0, (y * bw) * 4 + start, (y * bw) * 4 + start + len);
  if (s.wbuf) for (let y = y0; y <= y1; y++) s.wbuf.fill(0, (y * bw) * 4 + start, (y * bw) * 4 + start + len);
}

// ---------------- 打卡拍照(R7/R10): 视频+面具合成海报 → 分享/保存 ----------------
async function captureCheckin(s) {
  if (!s.video || !s.canvas) return;
  flashTip(s, "正在生成打卡照…");
  try {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const W = 1080;
    const H = Math.round((W * winH) / winW); // 与窗口同裁切比例, 保证面具对位
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    // 1) 视频帧(镜像 cover, 与预览一致)
    const vw = s.video.videoWidth || winW;
    const vh = s.video.videoHeight || winH;
    const k = Math.max(W / vw, H / vh);
    const sw = W / k, sh = H / k;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(s.video, sx, sy, sw, sh, 0, 0, W, H);
    ctx.restore();
    // 2) 面具叠加层(窗口坐标系等比放大)
    ctx.drawImage(s.canvas, 0, 0, W, H);
    // 3) 顶部压暗 + 书法标题 + 印章 + 日期落款
    await document.fonts.load('120px "Long Cang"', "贵傩戏打卡").catch(() => {});
    const g = ctx.createLinearGradient(0, 0, 0, W * 0.4);
    g.addColorStop(0, "rgba(0,0,0,.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W * 0.4);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = Math.round(W * 0.075) + 'px "Long Cang", "STKaiti", serif';
    ctx.lineWidth = Math.round(W * 0.008);
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.strokeText("贵傩戏 · 傩文化数字博物馆", W / 2, W * 0.13);
    ctx.fillStyle = "#fff";
    ctx.fillText("贵傩戏 · 傩文化数字博物馆", W / 2, W * 0.13);
    // 朱文方章
    const ssz = Math.round(W * 0.085);
    ctx.save();
    ctx.translate(W - ssz * 1.6, H - ssz * 2.0);
    ctx.rotate(-0.1);
    ctx.fillStyle = "#A31621";
    ctx.fillRect(-ssz / 2, -ssz / 2, ssz, ssz);
    ctx.fillStyle = "#fff";
    ctx.font = Math.round(ssz * 0.36) + 'px "Long Cang", serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    "傩印".split("").forEach((c, i) => ctx.fillText(c, (i % 2 ? 1 : -1) * ssz * 0.22, (i < 2 ? -1 : 1) * ssz * 0.22));
    ctx.restore();
    // 日期落款
    const d = new Date();
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.font = Math.round(W * 0.024) + 'px "Noto Serif SC", serif';
    ctx.shadowColor = "rgba(0,0,0,.55)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.fillText("打卡 · " + d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日", W * 0.05, H - W * 0.05);
    ctx.fillText("AR 试戴 · 点云面具", W * 0.05, H - W * 0.09);
    ctx.shadowBlur = 0;
    // 4) 导出与分享
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.92));
    cv.width = cv.height = 0;
    if (!blob) throw new Error("合成失败");
    const file = new File([blob], "nuo-checkin-" + Date.now() + ".jpg", { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: "贵傩戏数字博物馆 · AR 试戴打卡" });
        flashTip(s, "已分享 ✓");
        return;
      } catch (e) {
        if (e.name === "AbortError") { flashTip(s, "已取消分享"); return; }
      }
    }
    showCheckinPreview(URL.createObjectURL(blob), file.name);
    flashTip(s, "长按图片可保存");
  } catch (e) {
    console.warn("[arMask] 打卡失败:", e);
    flashTip(s, "打卡失败: " + (e.message || e));
  }
}

function showCheckinPreview(url, name) {
  closeCheckinPreview();
  const mask = makeEl("div", "position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px");
  mask.className = "vg-checkin-mask";
  const img = makeEl("img", "max-width:86vw;max-height:70vh;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6)");
  img.src = url;
  img.alt = "打卡照片(长按保存)";
  const row = makeEl("div", "display:flex;gap:12px");
  const dl = makeEl("button", "padding:10px 22px;border:1px solid rgba(255,255,255,.4);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;font-size:13px;letter-spacing:2px;cursor:pointer");
  dl.type = "button";
  dl.textContent = "下载";
  dl.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  });
  const cl = makeEl("button", "padding:10px 22px;border:none;border-radius:999px;background:#A31621;color:#fff;font-size:13px;letter-spacing:2px;cursor:pointer");
  cl.type = "button";
  cl.textContent = "关闭";
  cl.addEventListener("click", closeCheckinPreview);
  const hint = makeEl("p", "color:rgba(255,255,255,.55);font-size:12px;letter-spacing:2px;margin:0");
  hint.textContent = "移动端长按图片 → 保存/分享";
  row.append(dl, cl);
  mask.append(img, row, hint);
  document.body.appendChild(mask);
  mask._url = url;
}
function closeCheckinPreview() {
  const m = document.querySelector(".vg-checkin-mask");
  if (m) {
    if (m._url) URL.revokeObjectURL(m._url);
    m.remove();
  }
}

// ---------------- 切换 / 提示 ----------------
function requestSwitch(delta) {
  if (!session || !session.running) return;
  flashTip(session, delta > 0 ? "下一个面具 ▸" : "◂ 上一个面具");
  try {
    window.dispatchEvent(new CustomEvent("ar-mask-switch", { detail: { delta } }));
  } catch (e) {
    /* 事件派发不应阻塞 */
  }
  for (const cb of switchCbs) {
    try {
      cb(delta);
    } catch (e) {
      console.warn("[arMask] onSwitch 回调异常:", e);
    }
  }
}

function setTip(s, text) {
  if (s.tipText === text) return;
  s.tipText = text;
  if (s.tip) s.tip.textContent = text;
}

function flashTip(s, text) {
  s.flashUntil = performance.now() + 1200;
  s.tipText = text; // 同步缓存, 保证闪现结束后 setTip 能识别差异并恢复
  if (s.tip) s.tip.textContent = text;
}
