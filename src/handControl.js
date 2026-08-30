// 手势控制: MediaPipe 手势识别 → 交互状态映射
//
// 识别输入:
//   landmarks   : 每手 21 点骨架（wrist / thumb_tip / index_tip ...）
//   gestures    : 每手 one-hot [None, Closed_Fist, Open_Palm, Pointing_Up,
//                  Thumb_Down, Thumb_Up, Victory, ILoveYou]
//   交互设计:
//     手腕水平位置 → 线性映射 -120..120° → 2s 平滑 → 面具绕Y旋转
//     手腕垂直位置 → 线性映射 50..-90°  → 2s 平滑 → 面具绕X旋转
//     拇指-食指捏合距离 < 0.06 → 迟滞触发 → 计数循环 0..N → 1s 交叉淡切
//                  (捏合 -> 切换面具, 1s 交叉淡切)
//     Closed_Fist 置信度 → 线性映射 0..2 → 2s 平滑 → 噪声幅度
//                  (握拳 -> 粒子爆散 0..2)
//     基础速度 21°/s 积分 → 面具自动自转
import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

const GESTURE_NONE = "None";

// 2s 平滑窗口的观感 ≈ 指数平滑时间常数 ~0.5*width
function damp(current, target, tau, dt) {
  if (tau <= 0.001) return target;
  const k = 1 - Math.exp(-dt / tau);
  return current + (target - current) * k;
}

export class HandControl {
  constructor({ video, handCanvas, hudGesture }) {
    this.video = video;
    this.handCanvas = handCanvas;
    this.hudGesture = hudGesture;
    this.recognizer = null;
    this.running = false;
    this.lastVideoTime = -1;

    // 状态(单位: 弧度 / 归一化)
    this.state = {
      rx: 0, ry: 0,           // 平滑后的面具旋转(输出)
      spin: 0,                // 自转累计(速度积分)
      maskIndex: 0,           // 当前面具索引
      disp: 0,                // 爆散 0..2
      handPresent: false,
      gestureName: "--",
      pinchArmed: false,     // 必须先观察到"张开手掌"才武装(防幻觉紧凑手直接触发)
      landmarks: null,        // 叠加用
    };
    this.modLength = 5; // 计数循环长度(新增模型后更新)
    // 数学映射参数
    this.cfg = {
      spinSpeed: 12,          // °/s
      rotSens: 1,             // 旋转灵敏度倍率
      smoothTau: 0.5,         // s (平滑窗口 2s ≈ tau 0.5)
      dispTau: 1.0,           // 爆散平滑(平滑窗口 2s)
      pinchEnter: 0.06,       // 触发阈值
      pinchExit: 0.12,        // 迟滞
      fistThreshold: 0.5,     // 握拳判定阈值
      dispTarget: 2,          // 爆散目标幅度
    };
  }

  async init(statusCb) {
    statusCb?.("加载手势引擎(本地 wasm + 模型)…");
    const fileset = await FilesetResolver.forVisionTasks("./mediapipe/wasm");
    this.recognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "./mediapipe/models/gesture_recognizer.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });
    statusCb?.("手势引擎就绪");
  }

  async start(video) {
    this.video = video;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    this.state.handPresent = false;
    this.state.gestureName = "--";
  }

  _loop = async () => {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.recognizer) {
      if (this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        try {
          const res = this.recognizer.recognizeForVideo(this.video, performance.now());
          this._consume(res);
        } catch (e) {
          console.warn("recognize error", e);
        }
      }
    }
    requestAnimationFrame(() => this._loop());
  };

  _consume(res) {
    const st = this.state;
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this._t ?? now));
    this._t = now;
    if (this._warm === undefined) this._warm = now;
    if (this._trigT && now - this._trigT > 2) { this._trigText = ""; this._trigT = 0; }
    const ready = now - this._warm > 1.2; // 起流预热: 曝光未稳阶段不触发切换
    const hh = res?.handedness ?? res?.handednesses;
    const trusted = (hh?.[0]?.[0]?.score ?? 0) >= 0.5; // 低置信检测(远景/误检)只许旋转, 不许切换

    const hands = res?.landmarks ?? [];
    if (hands.length > 0) {
      // 只认第一只手
      const lm = hands[0];
      st.landmarks = lm;
      st.handPresent = true;
      // handScale: 腕->中指根长度(归一)。远处/幻觉的小"手"(如背景人脸被误检)不许触发切换
      const handScale = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
      const near = handScale > 0.07;

      // ---- 手腕位置 -> 旋转 (含自拍镜像) ----
      const wx = 1 - lm[0].x; // 镜像(自拍视图)
      const wy = lm[0].y;
      const ryTarget = THREE_MAP(wx, -120, 120) * this.cfg.rotSens;
      const rxTarget = THREE_MAP(wy, 50, -90) * this.cfg.rotSens;
      st.ryTarget = ryTarget;
      st.rxTarget = rxTarget;

      // ---- 手势滑动切换: 手腕水平快速位移(与捏合区分: 捏合看距离,滑动看速度) ----
      const wxNow = lm[0].x;
      const tNow = now;
      if (this._swipeX === undefined || tNow - (this._swipeT ?? 0) > 0.45 || !trusted) {
        this._swipeX = wxNow; this._swipeT = tNow;
      } else {
        const dxs = wxNow - this._swipeX;
        const dts = tNow - this._swipeT;
        if (dts > 0.08 && Math.abs(dxs) > 0.16 && st.pinch > 0.15) {
          // 连续两个窗口同向才确认: 单帧跳变(手 ID 切换/噪声)不触发
          const prev = this._swipePrevDx ?? 0;
          this._swipePrevDx = dxs;
          if (ready && trusted && near && Math.abs(prev) > 0.04 && Math.sign(prev) === Math.sign(dxs) && (this._swipeLock ?? 0) < tNow) {
            const dir = dxs > 0 ? -1 : 1; // 手向左挥 -> 下一件
            this._swipeX = wxNow; this._swipeT = tNow;
            this._swipeLock = tNow + 0.7;
            this._swipePrevDx = 0;
            this._trigText = `SWIPE${dir > 0 ? "▸" : "◂"}`;
            this._trigT = tNow;
            const next = (st.maskIndex + dir + this.modLength) % this.modLength;
            st.maskIndex = next;
            this._onMaskSwitch?.(next);
            window.dispatchEvent(new CustomEvent("ar-switch", { detail: dir }));
          }
        } else if (dts > 0.45) {
          this._swipeX = wxNow; this._swipeT = tNow;
          this._swipePrevDx = 0;
        }
      }

      // ---- 双手拉距 -> 缩放 ----
      if (hands.length >= 2) {
        const a = hands[0][0], b = hands[1][0];
        const dx = (1 - a.x) - (1 - b.x), dy = a.y - b.y;
        const d = Math.hypot(dx, dy); // 0.15(合) .. 0.6(开)
        const z = THREE_MAP(d, 0.15, 0.6) * 2.1 + 0.45; // -> 0.45..2.55
        st.zoom = damp(st.zoom ?? 1, z, 0.35, dt);
      }

      // ---- 手势 -> 爆散(先算,供捏合仲裁: 握拳成形过程不过捏合) ----
      let fistScore = 0;
      let gestureName = GESTURE_NONE;
      if (res.gestures && res.gestures[0] && res.gestures[0].length) {
        gestureName = res.gestures[0][0].categoryName ?? GESTURE_NONE;
        if (gestureName === "Closed_Fist") {
          fistScore = res.gestures[0][0].score ?? 1;
        }
      }
      st.gestureName = gestureName;
      if (res.gestures && res.gestures[1] && res.gestures[1][0]?.categoryName === "Closed_Fist") {
        fistScore = Math.max(fistScore, res.gestures[1][0].score ?? 1);
      }

      // ---- 捏合 -> 计数(握拳中挂起,防止"先切后散"误触) ----
      const pinch = pinchDistance(lm);
      this._pinchHold = pinch < this.cfg.pinchEnter ? (this._pinchHold ?? 0) + 1 : 0; // 捏合需持续~3帧才确认
      this._openHold = pinch > this.cfg.pinchExit ? (this._openHold ?? 0) + 1 : 0;   // 武装需先持续~5帧张开
      if (fistScore < 0.4 && ready && trusted && near) {
        if (st.pinchArmed && pinch < this.cfg.pinchEnter && this._pinchHold >= 3 && (this._swipeLock ?? 0) < now) {
          st.pinchArmed = false;
          this._swipeLock = now + 0.6; // 触发后冷却, 防检测闪烁连环切
          this._trigText = `PINCH p${(pinch * 100) | 0}`;
          this._trigT = now;
          st.maskIndex = (st.maskIndex + 1) % this.modLength;
          this._onMaskSwitch?.(st.maskIndex);
          window.dispatchEvent(new CustomEvent("ar-switch", { detail: 1 }));
        } else if (!st.pinchArmed && this._openHold >= 5) {
          st.pinchArmed = true; // 真人捏合必先经历"张开"阶段; 幻觉紧凑手永远到不了这里
        }
      }
      st.pinch = pinch;
      // 置信度 >= 0.5 后线性放大到 0..2
      const dispTarget = fistScore >= this.cfg.fistThreshold
        ? this.cfg.dispTarget * Math.min(1, (fistScore - 0.5) / 0.5)
        : 0;
      st.disp = damp(st.disp, dispTarget, this.cfg.dispTau, dt);

      this.hudGesture?.(
        `${gestureName} p${(pinch * 100) | 0} s${(handScale * 100) | 0}${near ? "" : " FAR"}${trusted ? "" : " LQ"} a${st.pinchArmed ? 1 : 0}${this._trigText ? " " + this._trigText : ""}`,
        fistScore
      );
    } else {
      st.handPresent = false;
      st.landmarks = null;
      st.gestureName = "--";
      // 手离开: 武装/捏合计数全部复位(检测闪烁不能借旧状态触发)
      st.pinchArmed = false;
      this._pinchHold = 0;
      this._openHold = 0;
      // 手离开:爆散缓慢回落,旋转回到自转
      st.disp = damp(st.disp, 0, this.cfg.dispTau, dt);
      st.ryTarget = undefined;
      st.rxTarget = undefined;
      this.hudGesture?.("--", 0);
    }

    // ---- 自转积分(基础速度 21°/s 积分) ----
    st.spin += this.cfg.spinSpeed * dt;

    // ---- 旋转平滑(2s 平滑) ----
    const tau = this.cfg.smoothTau;
    const ryGoal = (st.ryTarget ?? 0) + st.spin;
    const rxGoal = st.rxTarget ?? 0;
    // 手离开时 ry 继续由 spin 驱动, rx 回 0
    st.ry = damp(st.ry, ryGoal, st.handPresent ? tau : tau * 0.6, dt);
    st.rx = damp(st.rx, rxGoal, st.handPresent ? tau : tau * 0.6, dt);
  }

  // 每帧输出给舞台
  getRotation() {
    return { rx: deg2rad(this.state.rx), ry: deg2rad(this.state.ry) };
  }
  getDisp() {
    return this.state.disp;
  }
  getZoom() {
    return this.state.zoom ?? 1;
  }
}

// 归一化 0..1 -> [a,b] 线性映射
function THREE_MAP(v, a, b) {
  return a + (b - a) * Math.min(1, Math.max(0, v));
}
function deg2rad(d) {
  return (d * Math.PI) / 180;
}

// pinch_midpoint:distance 的近似: 拇指尖-食指尖距离 / 手掌尺度
// MediaPipe 的 distance 为归一化值, 张开 ~0.3+, 捏合 <0.06
function pinchDistance(lm) {
  const dx = lm[4].x - lm[8].x, dy = lm[4].y - lm[8].y, dz = (lm[4].z ?? 0) - (lm[8].z ?? 0);
  const d = Math.hypot(dx, dy, dz);
  const px = lm[0].x - lm[9].x, py = lm[0].y - lm[9].y;
  const palm = Math.hypot(px, py) || 0.2;
  return d / palm;
}

// MediaPipe HAND_CONNECTIONS(21 点骨架)
export const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];
