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
      pinchArmed: true,
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

    const hands = res?.landmarks ?? [];
    if (hands.length > 0) {
      // 只认第一只手
      const lm = hands[0];
      st.landmarks = lm;
      st.handPresent = true;

      // ---- 手腕位置 -> 旋转 (含自拍镜像) ----
      const wx = 1 - lm[0].x; // 镜像(自拍视图)
      const wy = lm[0].y;
      const ryTarget = THREE_MAP(wx, -120, 120) * this.cfg.rotSens;
      const rxTarget = THREE_MAP(wy, 50, -90) * this.cfg.rotSens;
      st.ryTarget = ryTarget;
      st.rxTarget = rxTarget;

      // ---- 双手拉距 -> 缩放 ----
      if (hands.length >= 2) {
        const a = hands[0][0], b = hands[1][0];
        const dx = (1 - a.x) - (1 - b.x), dy = a.y - b.y;
        const d = Math.hypot(dx, dy); // 0.15(合) .. 0.6(开)
        const z = THREE_MAP(d, 0.15, 0.6) * 2.1 + 0.45; // -> 0.45..2.55
        st.zoom = damp(st.zoom ?? 1, z, 0.35, dt);
      }

      // ---- 捏合 -> 计数 ----
      const pinch = pinchDistance(lm);
      if (st.pinchArmed && pinch < this.cfg.pinchEnter) {
        st.pinchArmed = false;
        st.maskIndex = (st.maskIndex + 1) % this.modLength;
        this._onMaskSwitch?.(st.maskIndex);
      } else if (!st.pinchArmed && pinch > this.cfg.pinchExit) {
        st.pinchArmed = true;
      }
      st.pinch = pinch;

      // ---- 手势 -> 爆散 ----
      let fistScore = 0;
      let gestureName = GESTURE_NONE;
      if (res.gestures && res.gestures[0] && res.gestures[0].length) {
        gestureName = res.gestures[0][0].categoryName ?? GESTURE_NONE;
        if (gestureName === "Closed_Fist") {
          fistScore = res.gestures[0][0].score ?? 1;
        }
      }
      st.gestureName = gestureName;
      // 双手中若另一只握拳也算
      if (res.gestures && res.gestures[1] && res.gestures[1][0]?.categoryName === "Closed_Fist") {
        fistScore = Math.max(fistScore, res.gestures[1][0].score ?? 1);
      }
      // 置信度 >= 0.5 后线性放大到 0..2
      const dispTarget = fistScore >= this.cfg.fistThreshold
        ? this.cfg.dispTarget * Math.min(1, (fistScore - 0.5) / 0.5)
        : 0;
      st.disp = damp(st.disp, dispTarget, this.cfg.dispTau, dt);

      this.hudGesture?.(gestureName, fistScore);
    } else {
      st.handPresent = false;
      st.landmarks = null;
      st.gestureName = "--";
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
