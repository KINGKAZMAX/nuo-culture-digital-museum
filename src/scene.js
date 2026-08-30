// Three.js 舞台：渲染器、相机、面具点云组（交叉淡切）、星空、灯饰、Bloom
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FilmPass } from "three/addons/postprocessing/FilmPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";
import { makePointsMaterial, loadBPC } from "./pointCloud.js";

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    // 纯白展墙:与 --bg-paper #FFFFFF 一致
    this.renderer.setClearColor(0xffffff, 1);
    this.scene = new THREE.Scene();
    // 相机: fov=45; 展陈弧需要更远机位,_resize 内按视口宽高比自适应
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    this.camera.position.set(0, 0.35, 10.4);
    this.camera.lookAt(0, 0, 0);

    // 面具根组: 手势旋转 + 转盘陈列角度作用在这一层
    this.maskRoot = new THREE.Group();
    this.scene.add(this.maskRoot);

    // 全量陈列(水墨展厅): 所有面具弧形同屏
    this.models = [];          // [{ points, def, ghosts[] }]
    this.arcStep = 0;          // 弧上相邻面具的角距
    this.arcRadius = 3.2;
    this.carouselTheta = 0;    // 当前转盘角(平滑值)
    this.carouselTarget = 0;   // 目标角
    this.focusIdx = 0;

    // 旧单件模式保留兼容(上传模型重建等仍走全量陈列)
    this.current = null;
    this.incoming = null;

    this._initComposer();

    this.params = {
      pointSize: 1,
      dispPower: 2,
    };
    this.zoom = 1;

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _initComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    const composer = new EffectComposer(this.renderer);
    // EDL 需要 depth:共享 depthTexture 挂到两个 ping-pong 缓冲(composer clone 会分离)
    this._depthTex = new THREE.DepthTexture(w, h);
    // RenderPass 固定渲染进 readBuffer(renderTarget2);深度纹理只挂 rt2,
    // 否则 EDL 写入 rt1 时会同时读写同一深度附件(GL 未定义行为,读回恒定值)。
    // 注意:交换型 pass(EDL/bloom/film/vignette)须保持偶数个,保证下一帧场景仍渲进 rt2
    composer.renderTarget2.depthTexture = this._depthTex;
    composer.addPass(new RenderPass(this.scene, this.camera));
    // EDL 点云深度着色(potree 算法, BSD-2): 邻域深度对数差暗化,雕纹凹槽出立体感
    this.edl = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this._depthTex },
        uStrength: { value: 0.55 },
        uRadius: { value: 2.0 },
        uNear: { value: this.camera.near },
        uFar: { value: 60 },
        uResolution: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uStrength, uRadius, uNear, uFar;
        uniform vec2 uResolution;
        varying vec2 vUv;
        float linearZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          return (uNear * uFar) / (uFar - d * (uFar - uNear));
        }
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          float zc = linearZ(vUv);
          if (zc > uFar * 0.9) { gl_FragColor = col; return; } // 天空不处理
          vec2 texel = 1.0 / uResolution;
          float shade = 0.0;
          float lc = log(zc);
          const vec4 ox = vec4(-1.0, 1.0, 0.0, 0.0);
          const vec4 oy = vec4(0.0, 0.0, -1.0, 1.0);
          for (int i = 0; i < 4; i++) {
            float zn = linearZ(vUv + vec2(ox[i], oy[i]) * texel * uRadius);
            shade += clamp(exp(-6.0 * abs(lc - log(max(zn, 1e-4)))), 0.0, 1.0);
          }
          shade *= 0.25;
          float f = mix(1.0, shade, uStrength);
          gl_FragColor = vec4(col.rgb * f, col.a);
        }`,
    });
    composer.addPass(this.edl);
    // 胶片颗粒(灰度) + 暗角 —— 纸面颗粒与陈纸边缘(浅色主题不用 bloom,会洗白墨色)
    this.film = new FilmPass(0.08, false); // 彩色保留(面具原生色),白底颗粒收敛防脏
    composer.addPass(this.film);
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.1;
    this.vignette.uniforms.darkness.value = 0.05; // 白底只留极浅暗角,灰晕会显脏
    composer.addPass(this.vignette);
    // linear → sRGB 输出(没有它整帧偏暗)
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    // 机位自适应:保证弧两端面具完整入画(前弧半径 3.2 + 面具半宽 ~1.6)
    const needHalf = 5.1;
    const dist = needHalf / (Math.tan(Math.PI / 8) * Math.max(0.42, this.camera.aspect));
    this.camera.position.z = Math.min(20, Math.max(10.2, 3.2 + dist));
    this.camera.position.y = 0.35;
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    const pr = this._targetPR ?? Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    // 重建共享深度纹理(RT.setSize 不会同步 depthTexture)
    if (this._depthTex) this._depthTex.dispose();
    this._depthTex = new THREE.DepthTexture(w * pr, h * pr);
    this.composer.renderTarget2.depthTexture = this._depthTex;
    if (this.edl) {
      this.edl.uniforms.tDepth.value = this._depthTex;
      this.edl.uniforms.uResolution.value.set(w * pr, h * pr);
    }
    for (const m of this._allMaskEntries()) {
      for (const p of [m.points, ...(m.ghosts ?? [])]) {
        p.material.uniforms.uPixelRatio.value = pr;
        p.material.uniforms.uViewH.value = h * pr;
      }
    }
  }

  _allMaskEntries() {
    // 全量陈列 + 兼容旧单件(current/incoming)
    const list = [...(this.models ?? [])];
    for (const m of [this.current, this.incoming]) if (m && !list.includes(m)) list.push(m);
    return list;
  }

  // ---------- 面具管理 ----------
  _makePoints(geometry, def, opts = {}) {
    // 水墨展厅: 单层无光晕,墨色着色
    const mat = makePointsMaterial({ pointSize: this.params.pointSize, ink: opts.ink === true });
    const points = new THREE.Points(geometry, mat);
    const s = def.baseScale ?? 1;
    points.scale.setScalar(s);
    if (opts.ghosts === false) {
      points.ghosts = [];
      return points;
    }
    // 反馈光晕层(历史帧累积轨迹) —— 暗景模式用
    const ghosts = [];
    const GHOSTS = [
      { g: 1, alpha: 0.42 },
      { g: 2, alpha: 0.28 },
      { g: 3, alpha: 0.17 },
      { g: 4, alpha: 0.10 },
    ];
    for (const gh of GHOSTS) {
      const gm = makePointsMaterial({ pointSize: this.params.pointSize, ghost: gh.g, opacity: gh.alpha, ink: opts.ink === true });
      const gp = new THREE.Points(geometry, gm);
      gp.scale.setScalar(s);
      gp.userData.baseOpacity = gh.alpha;
      ghosts.push(gp);
      points.add(gp); // 挂在主层下,跟随旋转
    }
    points.ghosts = ghosts;
    return points;
  }

  // ---------- 全量弧形陈列(水墨展厅主模式) ----------
  showAllModels(defs, geos) {
    // 清旧(释放材质;几何为共享缓存不释放)
    for (const m of this.models ?? []) {
      this.maskRoot.remove(m.points);
      m.points.material.dispose();
    }
    this.models = [];
    this.current = null;
    this.incoming = null;
    const N = Math.max(1, defs.length);
    this.arcStep = (Math.PI * 2) / N;
    const R = N > 1 ? this.arcRadius : 0;
    defs.forEach((def, i) => {
      const geometry = geos[i];
      if (!geometry) return;
      const p = this._makePoints(geometry, def, { ghosts: false }); // 原生彩色
      // 垂直居中(TDPC 烘焙坐标原点在底部)
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const cy = (bb.min.y + bb.max.y) / 2 * (def.baseScale ?? 1);
      const a = i * this.arcStep;
      p.position.set(Math.sin(a) * R, -cy, Math.cos(a) * R);
      p.rotation.y = a; // 面朝弧外
      this.maskRoot.add(p);
      this.models.push({ points: p, def, ghosts: [] });
    });
    this.current = this.models[this.focusIdx] ?? null;
  }

  // 转盘聚焦:旋转弧使第 idx 面到正前(最短路径)
  focusIndex(idx) {
    const N = Math.max(1, this.models.length || (this.arcStep ? Math.round(Math.PI * 2 / this.arcStep) : 1));
    idx = ((idx % N) + N) % N;
    this.focusIdx = idx;
    this.current = this.models[idx] ?? this.current;
    const desired = -idx * this.arcStep;
    let d = (desired - this.carouselTarget) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.carouselTarget += d;
  }

  showModel(def, geometry) {
    // 兼容旧单件接口(未被水墨展厅主流程使用)
    if (this.current) {
      this.maskRoot.remove(this.current.points);
      this.current.points.geometry.dispose();
      this.current.points.material.dispose();
      for (const gp of this.current.ghosts ?? []) gp.material.dispose();
    }
    const points = this._makePoints(geometry, def);
    points.material.uniforms.uOpacity.value = 1;
    for (const gp of points.ghosts ?? []) gp.material.uniforms.uOpacity.value = gp.userData.baseOpacity;
    this.maskRoot.add(points);
    this.current = { points, def, ghosts: points.ghosts ?? [] };
    this.incoming = null;
  }

  // 兼容旧切换接口:直接走转盘聚焦
  async transitionTo(loaderFn, defs, index) {
    const def = defs[index];
    if (!def) return;
    this.focusIndex(index);
  }

  setDisp(v) {
    const target = v * this.params.dispPower;
    for (const m of this._allMaskEntries()) {
      m.points.material.uniforms.uDisp.value = target;
      for (const gp of m.ghosts ?? []) gp.material.uniforms.uDisp.value = target;
    }
  }

  setPointSizeAll(v) {
    for (const m of this._allMaskEntries()) {
      m.points.material.uniforms.uPointSize.value = v;
      for (const gp of m.ghosts ?? []) gp.material.uniforms.uPointSize.value = v;
    }
  }

  // ---------- 背景粒子云 ----------
  // 水墨展厅不加载暗景云层;保留接口兼容(被调用时静默跳过)
  async loadBackground(manifest) {
    void manifest;
  }

  // ---------- 缩放(滚轮/双指捏合/双手拉距) ----------
  setZoom(z) {
    this.zoom = Math.min(2.6, Math.max(0.45, z));
    this.maskRoot.scale.setScalar(this.zoom);
  }
  getZoom() { return this.zoom ?? 1; }

  // ---------- 每帧 ----------
  update(dt, rot) {
    const t = performance.now() / 1000;
    // 转盘角平滑趋近目标
    this.carouselTheta += (this.carouselTarget - this.carouselTheta) * Math.min(1, dt * 3.4);
    // 面具旋转: rx/ry 由手势/拖拽驱动, 自动自转叠加在 ry, 转盘角叠加
    this.maskRoot.rotation.order = "ZXY";
    this.maskRoot.rotation.x = rot.rx * 0.6; // 弧形陈列俯仰减半,避免翻转整个展台
    this.maskRoot.rotation.y = rot.ry + this.carouselTheta;
    this.maskRoot.rotation.z = Math.sin(t * 0.13) * 0.012;

    for (const m of this._allMaskEntries()) {
      m.points.material.uniforms.uTime.value = t;
      for (const gp of m.ghosts ?? []) gp.material.uniforms.uTime.value = t;
    }
    this.composer.render();
  }
}
